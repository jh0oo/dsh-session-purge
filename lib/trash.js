/**
 * dsh-session-purge — the recycle bin (回收站) backend.
 *
 * Deletion in this plugin is deliberately *two-phase*:
 *
 *   phase 1  trash(ids)      the session disappears from the sidebar and its log
 *                            is no longer inside ~/.dsh/sessions, but every byte
 *                            is parked in the trash and can be put back exactly
 *                            where it was.
 *   phase 2  purge(entryId)  the parked bytes are actually unlinked, together
 *                            with the session's ledger references and any
 *                            attachment blobs no surviving session references.
 *                            Only now is the session "as if it never existed".
 *
 * This file owns phase 1 and the byte-level half of phase 2. It is a *pure
 * filesystem module* like `lib/store.js`: it makes no policy decision, calls no
 * host service, and never touches anything outside the DSH home.
 *
 * ## On-disk layout
 *
 *   <home>/storages/dsh-session-purge/trash/index.json      the entry ledger
 *   <home>/storages/dsh-session-purge/trash/<entryId>/payload/<name>
 *
 * Session directories and single files (projection cache, vision-router policy)
 * are *flattened* into one `payload` directory. Each `name` is the original
 * basename, and the entry's `sessionDirs` / `files` lists record the absolute
 * original path (`from`) for each one, which is what makes an exact restore
 * possible. Flattening keeps the entry self-describing: moving the whole
 * `<entryId>` directory moves a complete, restorable session.
 *
 * ## Why the index cannot be trusted
 *
 * `index.json` sits in the user's home, so it is writable by anything running as
 * the user. Every path that leaves this module is therefore re-validated:
 *
 *   - `from` must be *strictly inside* `<home>/sessions` or `<home>/storages`,
 *     and never inside this plugin's own storage directory;
 *   - `name` must be a plain basename (no separators, no `..`, no drive letter);
 *   - `entryId` is restricted to `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`, so a tampered
 *     index can never turn `deleteEntryPayload` into `rm -rf` on an arbitrary
 *     path.
 *
 * A violation raises `code: 'TRASH_outside'` / `'TRASH_entry'` and nothing on
 * disk is modified.
 *
 * ## Failure contract
 *
 * No function here throws a raw platform error: everything is wrapped into an
 * `Error` with a readable Chinese message and a `code` beginning with `TRASH_`.
 * Per-item problems during a batch move are *collected* (`skipped` / `failed`)
 * rather than thrown, because aborting halfway would leave moved bytes with no
 * index entry pointing at them — the one outcome this module must never
 * produce. Bytes that fail to move simply stay where they were.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  bareId,
  dirBytes,
  isInside,
  readJson,
  resolveHome,
  sessionsRoot,
  storagesRoot,
  writeJsonAtomic
} from './store.js';

/** Index schema version written by this module. */
export const INDEX_VERSION = 1;
/** Default retention when the plugin config says nothing. */
export const RETENTION_DEFAULT_DAYS = 30;
/** Clamp floor — a 0-day retention would empty the bin before the user sees it. */
export const RETENTION_MIN_DAYS = 1;
/** Clamp ceiling — ten years, i.e. "effectively forever" without overflowing. */
export const RETENTION_MAX_DAYS = 3650;

const DAY_MS = 86_400_000;
const RENAME_TRIES = 6;
const RENAME_BASE_DELAY_MS = 60;
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENOENT']);
/** A trash entry id is also a directory name — allow nothing exotic. */
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Characters Windows refuses in a file name, plus control characters. */
const ILLEGAL_NAME = /[<>:"|?*\u0000-\u001f]/;

/* ── small helpers ───────────────────────────────────────────────────────── */

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function message(error) {
  return error && error.message ? String(error.message) : String(error);
}

function trashError(code, text, cause) {
  const error = new Error(text);
  error.code = code;
  if (cause) {
    error.cause = cause;
    if (cause.errno !== undefined) error.errno = cause.errno;
  }
  return error;
}

/**
 * Re-wrap a failure for the caller without losing an already-classified code.
 * Nested TRASH_* errors (e.g. `deleteEntryPayload` inside `sweepExpired`) pass
 * through unchanged so the UI never reports a generic wrapper.
 */
function asTrashError(code, text, error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('TRASH_')) return error;
  return trashError(code, `${text}${error && error.message ? `：${message(error)}` : ''}`, error);
}

/* ── paths ───────────────────────────────────────────────────────────────── */

/** `<home>/storages/dsh-session-purge/trash` */
export function trashRoot(home = resolveHome()) {
  return join(home, 'storages', 'dsh-session-purge', 'trash');
}

/** `<home>/storages/dsh-session-purge/trash/index.json` */
export function trashIndexPath(home = resolveHome()) {
  return join(trashRoot(home), 'index.json');
}

/** The plugin's own storage directory: never a legal move source or target. */
function ownStorageRoot(home) {
  return join(storagesRoot(home), 'dsh-session-purge');
}

/** `<trash>/<entryId>` — the directory `deleteEntryPayload` removes. */
function entryDir(home, entryId) {
  return join(trashRoot(home), entryId);
}

/** `<trash>/<entryId>/payload` — where the bytes actually live. */
function payloadDir(home, entryId) {
  return join(entryDir(home, entryId), 'payload');
}

/* ── validation ──────────────────────────────────────────────────────────── */

function assertEntryId(entryId) {
  const value = typeof entryId === 'string' ? entryId : '';
  if (!ENTRY_ID.test(value)) {
    throw trashError('TRASH_entry', `回收站条目 id 非法：${value || '(空)'}`);
  }
  return value;
}

/**
 * A payload file name must be a single path component.
 *
 * `basename(name) === name` rejects both separators, and the explicit `..` /
 * `ILLEGAL_NAME` checks reject the Windows-specific escapes that `basename`
 * alone would let through (`C:evil`, `x:stream`).
 */
function assertName(name, kind) {
  const value = typeof name === 'string' ? name : '';
  const bad = !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes(':')
    || basename(value) !== value
    || ILLEGAL_NAME.test(value);
  if (bad) {
    throw trashError('TRASH_entry', `回收站条目里的${kind || '文件'}名非法：${value || '(空)'}`);
  }
  return value;
}

/**
 * Accept only paths this module is allowed to move bytes for.
 *
 * Returns the resolved absolute source path so the rest of the function never
 * has to re-resolve a caller-supplied string.
 */
function assertFrom(home, from) {
  const raw = typeof from === 'string' ? from.trim() : '';
  if (!raw) throw trashError('TRASH_outside', '回收站缺少来源路径');
  if (!isAbsolute(raw)) {
    throw trashError('TRASH_outside', `回收站拒绝相对路径：${raw}`);
  }
  const target = resolve(raw);
  const own = resolve(ownStorageRoot(home));
  /* The trash itself lives under storages/, so it passes the fence below.
     Moving bytes into the directory that is receiving them (or deleting it
     later) would be data loss, so the plugin's own store is fenced off. */
  if (resolve(target) === own || isInside(own, target)) {
    throw trashError('TRASH_outside', `回收站拒绝处理自己的存储目录：${target}`);
  }
  if (isInside(sessionsRoot(home), target)) return target;
  if (isInside(storagesRoot(home), target)) return target;
  throw trashError('TRASH_outside', `路径越界，已阻止：${target}`);
}

/**
 * Remove directories that a move just emptied, walking up but *stopping at the
 * store roots*.
 *
 * `store.pruneEmptyDirs` walks up to three levels unconditionally, so calling it
 * on a session directory's parent would delete `~/.dsh/sessions` itself once the
 * last session left — which would look like the whole feature had eaten the
 * store. The bounded walk below reproduces the useful half of that behaviour
 * (`<sessions>/<slug>` disappears when its last session is trashed) while never
 * removing `sessions/`, `storages/`, the DSH home or this plugin's directory.
 */
async function pruneOrigins(home, movedFrom) {
  const stop = [
    resolve(home),
    resolve(sessionsRoot(home)),
    resolve(storagesRoot(home)),
    resolve(ownStorageRoot(home)),
    resolve(trashRoot(home))
  ].map((path) => path.toLowerCase());
  const removed = [];
  let current = resolve(dirname(movedFrom));
  for (let depth = 0; depth < 4; depth += 1) {
    const key = current.toLowerCase();
    if (stop.includes(key)) break;
    if (!isInside(sessionsRoot(home), current) && !isInside(storagesRoot(home), current)) break;
    let entries;
    try {
      entries = await readdir(current);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      /* `rmdir`, not `rm(…, { recursive: false })`: on a directory that form
         raises ERR_FS_EISDIR and removes nothing, which silently turns the
         whole prune into a no-op. */
      await rmdir(current);
    } catch {
      break;
    }
    removed.push(current);
    current = resolve(dirname(current));
  }
  return removed;
}

/* ── byte movement ───────────────────────────────────────────────────────── */

/** Rename with the same Windows backoff `store.js` uses internally. */
async function renameRetry(from, to) {
  let last;
  for (let attempt = 0; attempt < RENAME_TRIES; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      last = error;
      if (!error || !RETRYABLE_CODES.has(String(error.code))) throw error;
      if (attempt === RENAME_TRIES - 1) break;
      await delay(RENAME_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw trashError(
    'TRASH_io',
    `移动失败：${from} → ${to}（${last && last.code ? last.code : '未知错误'}）`,
    last
  );
}

/**
 * Move one path, degrading to copy+delete when the two ends are on different
 * volumes (a `$DSH_HOME` on another drive, or a redirected temp directory).
 * @returns {Promise<'rename'|'copy'>} how the move happened.
 */
async function moveOne(from, to) {
  try {
    await renameRetry(from, to);
    return 'rename';
  } catch (error) {
    if (String(error && error.code) !== 'EXDEV') throw error;
  }
  await cp(from, to, { recursive: true, force: true });
  await rm(from, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
  return 'copy';
}

/** Size of one payload item, whatever it is. A vanished path counts as zero. */
async function sizeOf(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return await dirBytes(target);
    return info.size;
  } catch {
    return 0;
  }
}

/* ── index ───────────────────────────────────────────────────────────────── */

/** Read the trash index; a missing or corrupt file reads as an empty index. */
export async function readTrashIndex(home = resolveHome()) {
  const homePath = resolve(home || resolveHome());
  try {
    const data = await readJson(trashIndexPath(homePath));
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
      return { version: INDEX_VERSION, entries: [] };
    }
    const entries = data.entries.filter(
      (entry) => entry && typeof entry === 'object' && typeof entry.entryId === 'string' && entry.entryId
    );
    return { version: INDEX_VERSION, entries };
  } catch (error) {
    throw asTrashError('TRASH_index', `读取回收站索引失败：${trashIndexPath(homePath)}`, error);
  }
}

/**
 * Atomically replace the trash index.
 *
 * `writeJsonAtomic` without a third argument skips the concurrency check, which
 * is what we want here: the trash index is written only by this plugin (never by
 * the Host), so there is no other writer to lose a race against.
 */
export async function writeTrashIndexAt(home, index) {
  const homePath = resolve(home || resolveHome());
  try {
    const entries = Array.isArray(index && index.entries)
      ? index.entries.filter(
        (entry) => entry && typeof entry === 'object' && typeof entry.entryId === 'string' && entry.entryId
      )
      : [];
    const value = { version: INDEX_VERSION, entries, updatedAt: new Date().toISOString() };
    await mkdir(trashRoot(homePath), { recursive: true });
    await writeJsonAtomic(trashIndexPath(homePath), value);
    return value;
  } catch (error) {
    throw asTrashError('TRASH_index', `写入回收站索引失败：${trashIndexPath(homePath)}`, error);
  }
}

/* ── entry construction ──────────────────────────────────────────────────── */

/** Clamp a retention value into `[1, 3650]`, defaulting when unusable. */
export function clampRetention(value, fallback = RETENTION_DEFAULT_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(days)));
}

/** Config → retention days. Never throws; a broken config means the default. */
export function retentionFrom(config) {
  try {
    if (!config || typeof config !== 'object') return RETENTION_DEFAULT_DAYS;
    return clampRetention(config.trashRetentionDays);
  } catch {
    return RETENTION_DEFAULT_DAYS;
  }
}

/**
 * Build a well-formed trash entry.
 *
 * Kept here (rather than in `service.js`) so the field set, the id spelling and
 * the `expiresAt = deletedAt + retentionDays` invariant can never drift between
 * the code that writes the index and the code that reads it back.
 *
 * @param {object} input - `{ entryId?, id?, bare?, title?, deletedAt?,
 *   retentionDays?, bytes?, sessionDirs?, files?, workspace?, archived?,
 *   pinned?, hashes? }`
 */
export function makeEntry(input) {
  const options = input && typeof input === 'object' ? input : {};
  const bare = String(
    (typeof options.bare === 'string' && options.bare.trim())
      || bareId(typeof options.id === 'string' ? options.id : '')
      || ''
  ).trim();
  const id = typeof options.id === 'string' && options.id.trim()
    ? options.id.trim()
    : bare
      ? `session-${bare}`
      : '';
  const deletedAtRaw = Number(options.deletedAt);
  const deletedAt = Number.isFinite(deletedAtRaw) && deletedAtRaw > 0 ? deletedAtRaw : Date.now();
  const retentionDays = clampRetention(options.retentionDays);
  const expiresRaw = Number(options.expiresAt);
  const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0
    ? expiresRaw
    : deletedAt + retentionDays * DAY_MS;
  const bytes = Number(options.bytes);
  const workspace = options.workspace && typeof options.workspace === 'object' ? options.workspace : {};
  const index = Number(workspace.index);
  const asItems = (list) => (Array.isArray(list)
    ? list.filter((item) => item && typeof item === 'object' && typeof item.from === 'string' && item.from)
      .map((item) => ({ from: item.from, name: String(item.name || basename(item.from)) }))
    : []);

  return {
    entryId: assertEntryId(
      typeof options.entryId === 'string' && options.entryId ? options.entryId : randomUUID()
    ),
    id,
    bare,
    title: typeof options.title === 'string' ? options.title : '',
    deletedAt,
    expiresAt,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
    sessionDirs: asItems(options.sessionDirs),
    files: asItems(options.files),
    workspace: {
      workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
      index: Number.isFinite(index) ? index : -1
    },
    archived: options.archived === true,
    pinned: options.pinned === true,
    hashes: Array.isArray(options.hashes) ? options.hashes.filter((hash) => typeof hash === 'string') : [],
    retentionDays
  };
}

/* ── phase 1: move into the trash ────────────────────────────────────────── */

/**
 * Move one session's bytes into `<trash>/<entryId>/payload/`.
 *
 * @param {string} home - DSH home.
 * @param {object} plan - `{ entryId?, sessionDirs, files, entry? }`
 *   `sessionDirs` / `files` are `[{ from, name? }]`; `name` defaults to the
 *   basename of `from`. `entryId` is optional: it is generated (uuid) when the
 *   caller does not supply one, and the value actually used is always returned.
 *   When `entry` is supplied, a complete entry is appended
 *   to the index in the same call (see the return value), which closes the
 *   window where bytes sit in the trash with nothing pointing at them.
 * @returns {Promise<{entryId:string, moved:Array, bytes:number,
 *   skipped:Array, failed:Array, sessionDirs:Array, files:Array,
 *   entry?:object, pruned:string[]}>}
 */
export async function moveIntoTrash(home, plan) {
  const homePath = resolve(home || resolveHome());
  try {
    /* `entryId` is optional: callers that do not supply one still get a valid
       directory name, and the value actually used comes back in the result. */
    const requested = plan && typeof plan.entryId === 'string' && plan.entryId ? plan.entryId : '';
    const entryId = requested ? assertEntryId(requested) : assertEntryId(randomUUID());
    const sourceDirs = Array.isArray(plan && plan.sessionDirs) ? plan.sessionDirs : [];
    const sourceFiles = Array.isArray(plan && plan.files) ? plan.files : [];

    /* ---- validate and name everything before touching the disk ---- */
    const prepared = [];
    const skipped = [];
    const taken = new Set();
    const claim = (preferred) => {
      let name = preferred;
      let suffix = 2;
      /* Windows is case-insensitive: `<guid>` and `<GUID>` are the same file. */
      while (taken.has(name.toLowerCase())) {
        name = `${preferred}~${suffix}`;
        suffix += 1;
      }
      taken.add(name.toLowerCase());
      return name;
    };
    const seen = new Set();

    for (const [list, kind] of [[sourceDirs, 'dir'], [sourceFiles, 'file']]) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const from = assertFrom(homePath, item.from);
        const key = from.toLowerCase();
        if (seen.has(key)) {
          /* The same log listed twice: the second move would fail with ENOENT
             and would also poison the payload with a duplicate name. */
          skipped.push({ from, name: String(item.name || basename(from)), kind, reason: 'duplicate' });
          continue;
        }
        seen.add(key);
        const name = claim(assertName(
          typeof item.name === 'string' && item.name ? item.name : basename(from),
          kind === 'dir' ? '目录' : '文件'
        ));
        prepared.push({ from, name, kind });
      }
    }

    /* ---- move ---- */
    const target = payloadDir(homePath, entryId);
    await mkdir(target, { recursive: true });

    const moved = [];
    const failed = [];
    const pruned = [];
    let bytes = 0;

    for (const item of prepared) {
      if (!existsSync(item.from)) {
        skipped.push({ from: item.from, name: item.name, kind: item.kind, reason: 'missing' });
        continue;
      }
      const destination = join(target, item.name);
      try {
        const how = await moveOne(item.from, destination);
        const size = await sizeOf(destination);
        bytes += size;
        moved.push({ from: item.from, name: item.name, kind: item.kind, bytes: size, how });
        pruned.push(...(await pruneOrigins(homePath, item.from)));
      } catch (error) {
        /* Keep going: the remaining items still belong in this entry, and the
           one that failed is safely still at its original path. */
        failed.push({ from: item.from, name: item.name, kind: item.kind, error: message(error) });
      }
    }

    const movedDirs = moved.filter((item) => item.kind === 'dir').map((item) => ({ from: item.from, name: item.name }));
    const movedFiles = moved
      .filter((item) => item.kind === 'file')
      .map((item) => ({ from: item.from, name: item.name }));

    const result = { entryId, moved, bytes, skipped, failed, sessionDirs: movedDirs, files: movedFiles, pruned };

    /* ---- optional: record the entry while we still know the real names ---- */
    if (plan && plan.entry && typeof plan.entry === 'object' && moved.length > 0) {
      const entry = makeEntry({
        ...plan.entry,
        entryId,
        bytes,
        sessionDirs: movedDirs,
        files: movedFiles
      });
      const index = await readTrashIndex(homePath);
      const entries = index.entries.filter((existing) => existing.entryId !== entryId);
      entries.push(entry);
      await writeTrashIndexAt(homePath, { version: INDEX_VERSION, entries });
      result.entry = entry;
    }

    return result;
  } catch (error) {
    throw asTrashError('TRASH_move', `移入回收站失败：${(plan && plan.entryId) || ''}`, error);
  }
}

/* ── restore ─────────────────────────────────────────────────────────────── */

/**
 * Put one entry's bytes back exactly where they came from.
 *
 * This restores *files only*. Re-attaching the session to the workspace
 * registry is the caller's job (it needs the host service, i.e. policy).
 *
 * @returns {Promise<{restored:Array, missing:Array, failed:Array}>}
 */
export async function restoreEntry(home, entry) {
  const homePath = resolve(home || resolveHome());
  try {
    const entryId = assertEntryId(entry && entry.entryId);
    const source = payloadDir(homePath, entryId);
    const lists = [
      [Array.isArray(entry && entry.sessionDirs) ? entry.sessionDirs : [], 'dir'],
      [Array.isArray(entry && entry.files) ? entry.files : [], 'file']
    ];

    /* Validate every destination first: a tampered `from` must abort before a
       single byte is written outside the store. */
    const prepared = [];
    for (const [list, kind] of lists) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        prepared.push({
          from: assertFrom(homePath, item.from),
          name: assertName(
            typeof item.name === 'string' && item.name ? item.name : basename(String(item.from || '')),
            kind === 'dir' ? '目录' : '文件'
          ),
          kind
        });
      }
    }

    const restored = [];
    const missing = [];
    const failed = [];
    for (const item of prepared) {
      const payload = join(source, item.name);
      if (!existsSync(payload)) {
        missing.push({ from: item.from, name: item.name, kind: item.kind });
        continue;
      }
      try {
        await mkdir(dirname(item.from), { recursive: true });
        const how = await moveOne(payload, item.from);
        restored.push({ from: item.from, name: item.name, kind: item.kind, bytes: await sizeOf(item.from), how });
      } catch (error) {
        failed.push({ from: item.from, name: item.name, kind: item.kind, error: message(error) });
      }
    }
    return { restored, missing, failed };
  } catch (error) {
    throw asTrashError('TRASH_restore', `还原回收站条目失败：${entry && entry.entryId ? entry.entryId : ''}`, error);
  }
}

/* ── phase 2: destroy the parked bytes ───────────────────────────────────── */

/**
 * Irreversibly delete one entry's parked bytes.
 *
 * The whole `<entryId>` directory goes, including the payload, so a later
 * `restoreEntry` reports every item as `missing` instead of half-restoring a
 * session whose log has been destroyed.
 *
 * @returns {Promise<{removed:boolean, bytes:number}>}
 */
export async function deleteEntryPayload(home, entry) {
  const homePath = resolve(home || resolveHome());
  try {
    const entryId = assertEntryId(entry && entry.entryId);
    const target = entryDir(homePath, entryId);
    const bytes = await sizeOf(target);
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
    if (existsSync(target)) {
      throw trashError('TRASH_delete', `回收站条目删除后仍然存在：${target}`);
    }
    return { removed: true, bytes };
  } catch (error) {
    throw asTrashError('TRASH_delete', `彻底删除回收站条目失败：${entry && entry.entryId ? entry.entryId : ''}`, error);
  }
}

/* ── listing ─────────────────────────────────────────────────────────────── */

/**
 * The trash as the UI should show it.
 *
 * Entries whose payload directory vanished (a manual `rm`, a failed restore)
 * are *reported* with `missing: true` rather than silently rewritten out of the
 * index — deleting the record here would destroy the user's only explanation of
 * where their session went.
 *
 * `totalBytes` sums only entries that still have bytes on disk, so it is the
 * honest "reclaimable if you empty the bin" figure.
 */
export async function listTrash(home = resolveHome()) {
  const homePath = resolve(home || resolveHome());
  try {
    const index = await readTrashIndex(homePath);
    const entries = [];
    let totalBytes = 0;
    for (const entry of index.entries) {
      let missing = false;
      try {
        const entryId = assertEntryId(entry.entryId);
        if (!existsSync(payloadDir(homePath, entryId))) missing = true;
      } catch {
        /* An id that cannot even name a directory cannot have a payload. */
        missing = true;
      }
      const bytes = Number(entry.bytes);
      const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
      if (!missing) totalBytes += size;
      entries.push({ ...entry, missing });
    }
    /* Newest deletion first — the row the user is most likely looking for. */
    entries.sort((left, right) => (Number(right.deletedAt) || 0) - (Number(left.deletedAt) || 0));
    return { entries, totalBytes };
  } catch (error) {
    throw asTrashError('TRASH_list', '读取回收站列表失败', error);
  }
}

/* ── retention sweep ─────────────────────────────────────────────────────── */

/**
 * Destroy every entry that has passed its retention deadline.
 *
 * An entry with no readable `expiresAt` is never swept: silently deleting a
 * session because its record was malformed would be worse than keeping it.
 *
 * @returns {Promise<{purged:string[], bytes:number, failed:Array, kept:number}>}
 */
export async function sweepExpired(home, now = Date.now()) {
  const homePath = resolve(home || resolveHome());
  const atRaw = Number(now);
  const at = Number.isFinite(atRaw) ? atRaw : Date.now();
  try {
    const index = await readTrashIndex(homePath);
    const keep = [];
    const purged = [];
    const failed = [];
    let bytes = 0;

    for (const entry of index.entries) {
      const expiresAt = Number(entry.expiresAt);
      const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= at;
      if (!expired) {
        keep.push(entry);
        continue;
      }
      try {
        const outcome = await deleteEntryPayload(homePath, entry);
        bytes += outcome.bytes || 0;
        purged.push(entry.entryId);
      } catch (error) {
        /* Keep the record so the next sweep retries instead of orphaning it. */
        keep.push(entry);
        failed.push({ entryId: entry.entryId, error: message(error) });
      }
    }

    if (purged.length > 0) {
      await writeTrashIndexAt(homePath, { version: INDEX_VERSION, entries: keep });
    }
    return { purged, bytes, failed, kept: keep.length };
  } catch (error) {
    throw asTrashError('TRASH_sweep', '回收站过期清理失败', error);
  }
}
