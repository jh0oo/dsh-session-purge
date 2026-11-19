/**
 * dsh-session-purge — the filesystem side.
 *
 * Everything a session leaves behind on disk lives here, and every function in
 * this file is a *pure byte operation*: no host service, no policy decision.
 * `lib/service.js` decides what may be deleted; this module is the only place
 * that actually unlinks bytes, which keeps the destructive surface auditable.
 *
 * Layout facts this file encodes (verified against a live install):
 *   ~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd   one dir per session
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json sidebar projection cache
 *   ~/.dsh/storages/vision_router_session_policy/policies/<id>.json
 *   ~/.dsh/storages/workspace.json                      workspace + archive + pin ledger
 *   ~/.dsh/storages/cost-meter/ledger.json              token accounting
 *   ~/.dsh/storages/dsh-context/overview-cache.v1.json  context-panel cache
 *   ~/.dsh/storages/schedule.json                       scheduled tasks
 *   ~/.dsh/attachments/v1/**                            content-addressed blobs
 *
 * Session ids appear in two spellings: the workspace ledger always writes
 * `session-<guid>`, while the projection cache and the session directory are
 * usually the bare `<guid>`. Every lookup therefore probes both.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const SESSION_LOG = 'session.v4.jsonl.zstd';

/** `$DSH_HOME`, else `~/.dsh` — same precedence the host uses. */
export function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh');
}

export function sessionsRoot(home = resolveHome()) {
  return join(home, 'sessions');
}

export function storagesRoot(home = resolveHome()) {
  return join(home, 'storages');
}

/** `session-<guid>` → `<guid>`; anything else is returned unchanged. */
export function bareId(sessionId) {
  return String(sessionId || '').replace(/^session-/, '');
}

/** Both spellings of one id, de-duplicated, empty values dropped. */
export function idVariants(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return [];
  const bare = bareId(raw);
  const prefixed = `session-${bare}`;
  const out = [];
  for (const candidate of [raw, prefixed, bare]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** True when `child` sits strictly inside `parent` (no path traversal). */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Cheap recursive byte total; a vanished file counts as zero. */
export async function dirBytes(target) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        /* raced with another writer */
      }
    }
  }
  return total;
}

/**
 * Every session directory under the store, with the metadata the UI needs.
 * @returns {Promise<Array<{name:string, dirPath:string, slug:string, bare:string,
 *   sizeBytes:number, mtimeMs:number}>>}
 */
export async function listSessionDirs(home = resolveHome()) {
  const root = sessionsRoot(home);
  const out = [];
  let slugs = [];
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugPath = join(root, slug.name);
    let entries = [];
    try {
      entries = await readdir(slugPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(slugPath, entry.name);
      const logPath = join(dirPath, SESSION_LOG);
      let size = 0;
      let mtime = 0;
      try {
        const info = await stat(logPath);
        size = info.size;
        mtime = info.mtimeMs;
      } catch {
        try {
          mtime = (await stat(dirPath)).mtimeMs;
        } catch {
          continue;
        }
      }
      out.push({
        name: entry.name,
        dirPath,
        logPath,
        slug: slug.name,
        bare: bareId(entry.name),
        sizeBytes: size,
        mtimeMs: mtime
      });
    }
  }
  return out;
}

/** Session directories matching one id in either spelling. */
export function dirsFor(sessionDirectories, sessionId) {
  const bare = bareId(sessionId);
  return sessionDirectories.filter((dir) => dir.bare === bare);
}

/**
 * `rm -rf` one session directory. Returns true when the path is gone.
 *
 * Windows reports EPERM/EBUSY while Defender or the indexer still has a handle
 * open on the log file, so the removal backs off and retries before giving up
 * with an error the UI can explain.
 */
export async function removeSessionDir(dirPath) {
  const attempts = 4;
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(dirPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
      if (!existsSync(dirPath)) return true;
      last = Object.assign(new Error('目录仍存在'), { code: 'EBUSY' });
    } catch (error) {
      last = error;
      const code = error && error.code ? String(error.code) : '';
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    }
    if (attempt < attempts - 1) await delay(120 * (attempt + 1));
  }
  const wrapped = new Error(
    `删除会话目录失败：${dirPath} 正被其他程序占用（${last && last.code ? last.code : '未知错误'}）。`
      + '请暂时关闭杀毒软件的实时防护后再试。'
  );
  wrapped.code = last && last.code ? String(last.code) : 'EPERM';
  wrapped.status = 503;
  throw wrapped;
}

/** Unlink a file, tolerating "already gone". Returns true when it was removed. */
async function removeFile(target) {
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Unlink `<name>.json` plus every derived sibling the host may have parked
 * beside it. The projection cache moves a record it cannot parse aside as
 * `<name>.json.bak.<stamp>` (see `invalidRecords: 'backup-and-skip'` in
 * `@deepseek-ai/dsh-session-projection-cache`), so deleting only `.json`
 * would leave a readable copy of the deleted session's title and cwd on disk.
 */
async function removeRecordVariants(dir, name, label) {
  const removed = [];
  const names = new Set([`${name}.json`]);
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === `${name}.json` || entry.name.startsWith(`${name}.json.`)) names.add(entry.name);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  for (const candidate of names) {
    try {
      if (await removeFile(join(dir, candidate))) removed.push(`${label}/${candidate}`);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/** Drop the sidebar projection cache for one session (both spellings). */
export async function removeProjectionCache(home, sessionId) {
  const dir = join(storagesRoot(home), 'session_projcache', 'sessions');
  const removed = [];
  for (const name of idVariants(sessionId)) {
    removed.push(...(await removeRecordVariants(dir, name, 'session_projcache')));
  }
  return removed;
}

/** Drop the per-session vision-router policy record. */
export async function removePolicyRecord(home, sessionId) {
  const dir = join(storagesRoot(home), 'vision_router_session_policy', 'policies');
  const removed = [];
  for (const name of idVariants(sessionId)) {
    removed.push(...(await removeRecordVariants(dir, name, 'vision_router_session_policy')));
  }
  return removed;
}

/** Read a JSON file; a missing or corrupt file reads as `undefined`. */
export async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    return undefined;
  }
}

/* ── durable JSON writes ────────────────────────────────────────────────────
 *
 * Two Windows facts drive this block.
 *
 * 1. `rename` over a file that Defender, the search indexer or a sync client
 *    holds for a few dozen milliseconds fails with EPERM/EACCES/EBUSY
 *    (errno -4048). The Host's own `dsh-storage-json` has no retry and treats
 *    the failure as fatal — that is exactly how the 2026-11-19 start-up crash
 *    happened. This plugin must not repeat the mistake, so every rename backs
 *    off and tries again.
 *
 * 2. The host writes the same ledgers while the app runs. Blindly rewriting
 *    `workspace.json` from a snapshot read a second earlier could silently
 *    drop a session the user created in the meantime. Every rewrite therefore
 *    carries the file's `mtimeMs`+`size` stamp and refuses to clobber a file
 *    that changed underneath it, re-reading and re-applying instead.
 */

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'ENOENT', 'EMFILE']);
const RENAME_TRIES = 6;
const RENAME_BASE_DELAY_MS = 60;
const MUTATE_TRIES = 4;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** `{ mtimeMs, size }` for a file, or `undefined` when it does not exist. */
export async function stampOf(target) {
  try {
    const info = await stat(target);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameStamp(left, right) {
  if (!left || !right) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function startedAt() {
  return new Date().toISOString();
}

/** A read plus the stamp that guards the matching write. */
export async function readJsonSnapshot(target) {
  const stamp = await stampOf(target);
  return { data: await readJson(target), stamp };
}

function staleLedgerError(target) {
  const error = new Error(
    `配置文件在删除过程中被其他程序改动，已放弃写入以免覆盖新数据：${target}`
  );
  error.code = 'STALE';
  error.status = 409;
  return error;
}

async function renameWithRetry(from, to) {
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
  const wrapped = new Error(
    `写入 ${to} 失败：文件正被其他程序占用（${last && last.code ? last.code : '未知错误'}）。`
      + `已重试 ${RENAME_TRIES} 次，请关闭杀毒软件的实时扫描或稍后重试。`
  );
  wrapped.code = last && last.code ? String(last.code) : 'EPERM';
  wrapped.status = 503;
  throw wrapped;
}

/**
 * Write JSON through a sibling temp file so a crash mid-write cannot leave a
 * truncated ledger behind. The rename is atomic on the same volume.
 *
 * Pass `expectedStamp` (from `readJsonSnapshot`) to make the write conditional:
 * a file that changed since it was read raises a `STALE` error instead of
 * being overwritten.
 */
export async function writeJsonAtomic(target, value, expectedStamp) {
  if (expectedStamp !== undefined) {
    const current = await stampOf(target);
    if (!sameStamp(current, expectedStamp)) throw staleLedgerError(target);
  }
  /* Same `.<uuid>.tmp` naming the host's own writer uses, so a leftover temp
     file is recognisable and never collides with a ledger name. */
  const temp = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameWithRetry(temp, target);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      /* temp already gone */
    }
    throw error;
  }
}

/**
 * Read → mutate → conditional write → verify, retried when another process
 * wins the race. `apply` receives freshly read data every attempt and must be
 * idempotent, so re-running it on a newer snapshot stays correct.
 *
 * The verify pass is what makes the guarantee hold rather than merely likely:
 * the Host rewrites `workspace.json` from its own in-memory snapshot, so a
 * successful write can still be followed by the Host writing back the id we
 * just removed. Re-reading and re-applying until the end state actually holds
 * converges as soon as the other writer settles, instead of silently leaving a
 * deleted session re-registered.
 */
async function mutateJsonWithRetry(target, apply) {
  let lastError;
  for (let attempt = 0; attempt < MUTATE_TRIES; attempt += 1) {
    const snapshot = await readJsonSnapshot(target);
    const outcome = apply(snapshot.data);
    if (!outcome.changed) return outcome.result;
    try {
      await writeJsonAtomic(target, snapshot.data, snapshot.stamp);
    } catch (error) {
      if (!error || error.code !== 'STALE') throw error;
      lastError = error;
      await delay(RENAME_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    /* Written — now prove the edit survived before reporting success. */
    if (typeof outcome.verify !== 'function') return outcome.result;
    const check = await readJson(target);
    if (outcome.verify(check)) return outcome.result;
    lastError = staleLedgerError(target);
    await delay(RENAME_BASE_DELAY_MS * (attempt + 1));
  }
  throw lastError || staleLedgerError(target);
}

/** Every spelling of the requested ids, as one lookup set. */
function wantedSet(sessionIds) {
  const wanted = new Set();
  for (const id of sessionIds) for (const variant of idVariants(id)) wanted.add(variant);
  return wanted;
}

function matchesId(wanted, value) {
  return wanted.has(String(value)) || wanted.has(bareId(value));
}

/**
 * Strip ids from the workspace ledger: membership, archive flags, pins.
 *
 * The in-memory registry is the source of truth while the app runs, so this is
 * the *second* pass — the registry API is called first by `service.js`, and
 * this rewrite catches whatever the registry no longer knew about.
 */
export async function editWorkspaceLedger(home, sessionIds) {
  const target = join(storagesRoot(home), 'workspace.json');
  const wanted = wantedSet(sessionIds);
  return mutateJsonWithRetry(target, (data) => {
    if (!data || typeof data !== 'object') return { changed: false, result: { touched: false, removed: 0 } };

    let removed = 0;
    const strip = (list) => {
      if (!Array.isArray(list)) return list;
      return list.filter((id) => {
        const hit = matchesId(wanted, id);
        if (hit) removed += 1;
        return !hit;
      });
    };

    const global = data.global && typeof data.global === 'object' ? data.global : undefined;
    if (global) {
      global.archivedSessionIds = strip(global.archivedSessionIds);
      global.pinnedSessionIds = strip(global.pinnedSessionIds);
    }
    const tables = data.tables && typeof data.tables === 'object' ? data.tables : {};
    const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {};
    for (const record of Object.values(workspaces)) {
      if (!record || typeof record !== 'object') continue;
      record.sessionIds = strip(record.sessionIds);
    }

    if (removed === 0) return { changed: false, result: { touched: false, removed: 0 } };
    return {
      changed: true,
      result: { touched: true, removed },
      /* No spelling of a deleted id may survive in any ledger list. */
      verify: (fresh) => {
        if (!fresh || typeof fresh !== 'object') return false;
        const lists = [];
        if (fresh.global && typeof fresh.global === 'object') {
          lists.push(fresh.global.archivedSessionIds, fresh.global.pinnedSessionIds);
        }
        const tables = fresh.tables && typeof fresh.tables === 'object' ? fresh.tables : {};
        const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {};
        for (const record of Object.values(workspaces)) {
          if (record && typeof record === 'object') lists.push(record.sessionIds);
        }
        return lists.every((list) => !Array.isArray(list) || !list.some((id) => matchesId(wanted, id)));
      }
    };
  });
}

/**
 * Strip the ids from the cost ledger: the per-session cursor map and the
 * per-day session rows. Day totals are left alone — they are aggregates, not
 * per-session records, and rewriting them would falsify the user's spend.
 */
export async function editCostLedger(home, sessionIds) {
  const target = join(storagesRoot(home), 'cost-meter', 'ledger.json');
  const wanted = wantedSet(sessionIds);
  return mutateJsonWithRetry(target, (data) => {
    if (!data || typeof data !== 'object') return { changed: false, result: { touched: false, removed: 0 } };

    let removed = 0;
    if (data.usageCursors && typeof data.usageCursors === 'object') {
      for (const key of Object.keys(data.usageCursors)) {
        const owner = String(key).split(':')[0];
        if (matchesId(wanted, owner)) {
          delete data.usageCursors[key];
          removed += 1;
        }
      }
    }
    const days = data.days && typeof data.days === 'object' ? data.days : {};
    for (const day of Object.values(days)) {
      if (!day || !Array.isArray(day.sessions)) continue;
      day.sessions = day.sessions.filter((row) => {
        const hit = row && matchesId(wanted, row.id);
        if (hit) removed += 1;
        return !hit;
      });
    }
    if (removed === 0) return { changed: false, result: { touched: false, removed: 0 } };
    return {
      changed: true,
      result: { touched: true, removed },
      verify: (fresh) => {
        if (!fresh || typeof fresh !== 'object') return false;
        const cursors = fresh.usageCursors && typeof fresh.usageCursors === 'object' ? fresh.usageCursors : {};
        if (Object.keys(cursors).some((key) => matchesId(wanted, String(key).split(':')[0]))) return false;
        const days = fresh.days && typeof fresh.days === 'object' ? fresh.days : {};
        return Object.values(days).every((day) =>
          !day || !Array.isArray(day.sessions) || !day.sessions.some((row) => row && matchesId(wanted, row.id)));
      }
    };
  });
}

/** Drop cached context-panel entries for the deleted sessions. */
export async function editOverviewCache(home, sessionIds) {
  const target = join(storagesRoot(home), 'dsh-context', 'overview-cache.v1.json');
  const wanted = wantedSet(sessionIds);
  return mutateJsonWithRetry(target, (data) => {
    if (!data || !Array.isArray(data.sessions)) return { changed: false, result: { touched: false, removed: 0 } };
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((entry) => {
      const id = entry && entry.session && entry.session.id ? entry.session.id : '';
      return !matchesId(wanted, id);
    });
    const removed = before - data.sessions.length;
    if (removed === 0) return { changed: false, result: { touched: false, removed: 0 } };
    return {
      changed: true,
      result: { touched: true, removed },
      verify: (fresh) => {
        if (!fresh || !Array.isArray(fresh.sessions)) return false;
        return !fresh.sessions.some((entry) => {
          const id = entry && entry.session && entry.session.id ? entry.session.id : '';
          return matchesId(wanted, id);
        });
      }
    };
  });
}

/**
 * The destination a Schedule task keeps when the Session it pointed at is
 * deleted. `schedule`'s own schema reserves this id for a `new_once` task and
 * derives it from the task id, so writing it back is exactly what the Host
 * would compute — the task stays valid and armed instead of naming a Session
 * that no longer exists.
 */
function reservedScheduleSessionId(taskId) {
  return `session-schedule-${createHash('sha256').update(String(taskId)).digest('hex')}`;
}

/**
 * Scheduled tasks are user-owned; they are never deleted here. What is removed
 * is every reference to a deleted Session: the involved ids, a `target` that
 * pointed at it (re-pointed at the task's reserved destination, so the task
 * keeps working), and the destination recorded on past deliveries. The task
 * itself is reported back so the UI can say what changed.
 */
export async function editScheduleRefs(home, sessionIds) {
  const target = join(storagesRoot(home), 'schedule.json');
  const wanted = wantedSet(sessionIds);
  return mutateJsonWithRetry(target, (data) => {
    if (!data || typeof data !== 'object') {
      return { changed: false, result: { touched: false, stripped: 0, targets: [] } };
    }
    const matches = (value) => matchesId(wanted, value);

    let stripped = 0;
    const targets = [];
    const tasks = data.tables && data.tables.tasks && typeof data.tables.tasks === 'object' ? data.tables.tasks : {};
    for (const [taskId, task] of Object.entries(tasks)) {
      if (!task || typeof task !== 'object') continue;
      let touchedTask = false;

      if (Array.isArray(task.involvedSessionIds)) {
        task.involvedSessionIds = task.involvedSessionIds.filter((id) => {
          const hit = matches(id);
          if (hit) {
            stripped += 1;
            touchedTask = true;
          }
          return !hit;
        });
      }

      /* Legacy v1 rows carry the destination as a bare `sessionId`. */
      if (typeof task.sessionId === 'string' && matches(task.sessionId)) {
        delete task.sessionId;
        stripped += 1;
        touchedTask = true;
      }

      const targetSession = task.target && task.target.sessionId ? String(task.target.sessionId) : '';
      if (targetSession && matches(targetSession)) {
        const reserved = reservedScheduleSessionId(taskId);
        task.target =
          task.target.kind === 'new'
            ? { kind: 'new', create: task.target.create || {} }
            : { kind: 'new_once', sessionId: reserved, create: task.target.create || {} };
        stripped += 1;
        touchedTask = true;
        targets.push({
          taskId,
          title: task.record && task.record.title ? String(task.record.title) : taskId
        });
      }

      /* Deliveries that went to the deleted Session keep the delivery fact but
         adopt the task's reserved destination id, so the deleted id is gone and
         the receipt still validates against `schedule`'s schema. */
      const reserved = reservedScheduleSessionId(taskId);
      const receipts = [];
      if (task.pendingDelivery && matches(task.pendingDelivery.targetSessionId)) {
        task.pendingDelivery = { targetSessionId: reserved };
        stripped += 1;
        touchedTask = true;
      }
      if (task.lastDelivery) receipts.push(task.lastDelivery);
      if (task.deliveryHistory && Array.isArray(task.deliveryHistory.records)) {
        receipts.push(...task.deliveryHistory.records);
      }
      for (const receipt of receipts) {
        if (!receipt || typeof receipt !== 'object') continue;
        if (!receipt.targetSessionId || !matches(receipt.targetSessionId)) continue;
        receipt.targetSessionId = reserved;
        stripped += 1;
        touchedTask = true;
      }

      if (touchedTask) task.updatedAt = new Date().toISOString();
    }
    if (stripped === 0) return { changed: false, result: { touched: false, stripped: 0, targets } };
    return {
      changed: true,
      result: { touched: true, stripped, targets },
      /* The task list must still exist and no deleted id may remain in any
         reference field the schema defines. */
      verify: (fresh) => {
        if (!fresh || typeof fresh !== 'object') return false;
        const tasks = fresh.tables && fresh.tables.tasks && typeof fresh.tables.tasks === 'object' ? fresh.tables.tasks : {};
        for (const task of Object.values(tasks)) {
          if (!task || typeof task !== 'object') continue;
          if (Array.isArray(task.involvedSessionIds) && task.involvedSessionIds.some((id) => matches(id))) return false;
          if (typeof task.sessionId === 'string' && matches(task.sessionId)) return false;
          if (task.target && task.target.sessionId && matches(task.target.sessionId)) return false;
          if (task.pendingDelivery && task.pendingDelivery.targetSessionId
            && matches(task.pendingDelivery.targetSessionId)) return false;
          const receipts = [];
          if (task.lastDelivery) receipts.push(task.lastDelivery);
          if (task.deliveryHistory && Array.isArray(task.deliveryHistory.records)) {
            receipts.push(...task.deliveryHistory.records);
          }
          for (const receipt of receipts) {
            if (!receipt || typeof receipt !== 'object') continue;
            if (receipt.targetSessionId && matches(receipt.targetSessionId)) return false;
          }
        }
        return true;
      }
    };
  });
}

/** Decode one session log to text, or '' when the codec or file is missing. */
export async function readLogText(logPath) {
  if (typeof zstdDecompressSync !== 'function') return '';
  let buffer;
  try {
    buffer = await readFile(logPath);
  } catch {
    return '';
  }
  try {
    return zstdDecompressSync(buffer).toString('utf8');
  } catch {
    // A log that is already plain JSONL (older stores) still scans fine.
    const text = buffer.toString('utf8');
    return text.startsWith('{') ? text : '';
  }
}

const HASH = /\b[0-9a-f]{64}\b/g;

/** Every 64-hex (sha256) token referenced by the given session logs. */
export async function hashesInLogs(sessionDirectories) {
  const found = new Set();
  for (const dir of sessionDirectories) {
    const text = await readLogText(dir.logPath);
    if (!text) continue;
    for (const match of text.matchAll(HASH)) found.add(match[0]);
  }
  return found;
}

/**
 * Delete content-addressed blobs that no surviving session references.
 *
 * Attachments are stored by content hash with no session key, so "this blob
 * belongs to session X" can only be answered by reference counting: collect
 * the hashes the purged logs mention, subtract every hash a surviving log
 * mentions, and remove only the difference. A blob shared with any surviving
 * session is always kept.
 */
export async function sweepAttachments(home, dropHashes) {
  const result = { scanned: 0, removed: 0, bytes: 0, roots: [] };
  if (!dropHashes || dropHashes.size === 0) return result;
  const roots = [
    join(home, 'attachments', 'v1'),
    join(home, 'cache', 'attachments', 'request-images')
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    result.roots.push(root);
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!dropHashes.has(entry.name)) continue;
        result.scanned += 1;
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          /* raced */
        }
        if (await removeFile(full)) {
          result.removed += 1;
          result.bytes += size;
        }
      }
    }
  }
  return result;
}

/**
 * Remove a directory only if it is now empty, walking up while it stays empty.
 *
 * Two hard rules, because this runs right after a session directory has been
 * deleted and the directories above it are `~/.dsh/sessions` and `~/.dsh`:
 *
 *   1. `rmdir`, not `rm`. `rm(dir, { recursive: false, force: true })` throws
 *      `ERR_FS_EISDIR` for every directory on Windows, so the old version was
 *      silently a no-op and left empty slug folders behind.
 *   2. Stop at every boundary. The walk climbs a fixed number of levels, but
 *      it must never remove `~/.dsh`, `~/.dsh/sessions`, `~/.dsh/storages` or
 *      the plugin's own storage root, even if one of them happens to be empty.
 */
export async function pruneEmptyDirs(target) {
  const removed = [];
  const home = resolveHome();
  const fence = new Set(
    [
      home,
      join(home, 'sessions'),
      join(home, 'storages'),
      join(home, 'storages', 'dsh-session-purge'),
      join(home, 'storages', 'dsh-session-purge', 'trash')
    ].map((path) => resolve(path))
  );
  let current = resolve(target);
  for (let depth = 0; depth < 3; depth += 1) {
    if (fence.has(current)) break;
    /* Never climb outside the data directory either. */
    if (!isInside(home, current)) break;
    let entries;
    try {
      entries = await readdir(current);
    } catch (error) {
      /* The leaf is usually already gone — that is the normal case, not a
         reason to stop. Climb and clean up the parent that is left empty. */
      if (error && error.code === 'ENOENT') {
        current = dirname(current);
        continue;
      }
      break;
    }
    if (entries.length > 0) break;
    try {
      await rmdir(current);
      removed.push(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
  return removed;
}

/** Group session directories by their slug (one slug per working directory). */
export function groupBySlug(sessionDirectories) {
  const groups = new Map();
  for (const dir of sessionDirectories) {
    if (!groups.has(dir.slug)) groups.set(dir.slug, []);
    groups.get(dir.slug).push(dir);
  }
  return groups;
}

export { SESSION_LOG, basename };
