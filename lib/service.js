/**
 * dsh-session-purge — the policy side.
 *
 * `lib/store.js` knows how to unlink bytes; this file decides what is allowed
 * to be unlinked, in what order, and what evidence to hand back to the UI.
 *
 * The deletion is deliberately *staged* so a failure cannot leave a session
 * that is half-alive — visible in the sidebar but missing its log, or archived
 * but still on disk:
 *
 *   0. quiescence  — the log must be byte-identical across two probes
 *   1. protection  — never touch a running / currently-open session
 *   2. fence       — only ever inside the DSH home, never a user document
 *   3. host forget — drop the in-memory session + agent so writers close
 *   4. disk sweep  — session dir, caches, ledgers, references
 *   5. resync      — tell the client to re-read its projections
 *
 * Steps 3 and 4 are ordered this way on purpose: the host must release the
 * append-only writer *before* the directory is removed, otherwise the writer
 * recreates the file immediately after the unlink and the session comes back.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  bareId,
  dirsFor,
  editCostLedger,
  editOverviewCache,
  editScheduleRefs,
  editWorkspaceLedger,
  groupBySlug,
  hashesInLogs,
  idVariants,
  isInside,
  listSessionDirs,
  pruneEmptyDirs,
  readJson,
  removePolicyRecord,
  removeProjectionCache,
  removeSessionDir,
  resolveHome,
  sessionsRoot,
  storagesRoot,
  sweepAttachments
} from './store.js';
import {
  deleteEntryPayload,
  listTrash,
  moveIntoTrash,
  readTrashIndex,
  restoreEntry,
  retentionFrom,
  sweepExpired,
  writeTrashIndexAt
} from './trash.js';

const QUIESCE_DELAY_MS = 240;
const QUIESCE_TRIES = 3;

const zh = {
  live: '会话正在运行，无法删除',
  current: '不能删除当前正在对话的会话',
  outside: '路径越界，已阻止',
  busy: '会话正在写入，请稍后重试',
  gone: '会话不存在',
  empty: '未选择会话'
};

/** `ctx.get` that never throws on a missing service. */
function safeGet(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function headerOf(snapshot) {
  return (snapshot && (snapshot.header || snapshot)) || {};
}

function liveIdOf(session) {
  if (!session) return '';
  const id = session.id || (session.header && session.header.id);
  return typeof id === 'string' ? id : '';
}

function message(error) {
  return error && error.message ? error.message : String(error);
}

function statusOf(error, fallback) {
  const value = Number(error && error.status);
  return Number.isFinite(value) && value >= 400 ? value : fallback;
}

function failure(code, text, status) {
  const error = new Error(text);
  error.code = code;
  if (status) error.status = status;
  return error;
}

/**
 * Two probes of the session log separated by a short delay.
 *
 * The point is not to lock the file — it is to notice an *active writer*. A
 * session that is mid-turn grows between the probes; a session at rest does
 * not. Deleting a growing log would race the persistence layer and can leave a
 * resurrected, truncated session behind.
 */
async function waitForQuiescence(dir) {
  const target = dir.logPath;
  let previous = null;
  for (let attempt = 0; attempt < QUIESCE_TRIES; attempt += 1) {
    let info;
    try {
      info = await stat(target);
    } catch {
      return { quiet: true, note: 'missing' };
    }
    const stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
    if (previous === stamp) return { quiet: true, note: stamp };
    previous = stamp;
    await new Promise((done) => setTimeout(done, QUIESCE_DELAY_MS));
  }
  return { quiet: false, note: String(previous) };
}

/**
 * Build the purge service for one plugin instance.
 * @param {object} ctx - Cordis host context.
 * @param {object} [config] - Plugin config; only `trashRetentionDays` is read.
 */
export function createPurgeService(ctx, config) {
  let inFlight = false;

  function guard() {
    if (inFlight) throw failure('busy', '另一个删除操作正在执行，请稍后再试', 409);
    inFlight = true;
  }

  function release() {
    inFlight = false;
  }

  function home() {
    return resolveHome();
  }

  /** The session the user is talking to right now — never deletable. */
  function currentSessionId() {
    for (const name of ['conversationCurrent', 'currentSession', 'activeSession']) {
      const service = safeGet(ctx, name);
      if (!service) continue;
      try {
        const value = typeof service.id === 'string' ? service.id : service.current;
        if (typeof value === 'string' && value) return value;
      } catch {
        /* not this service */
      }
    }
    return '';
  }

  /**
   * Is this session live? A session is live when an agent for it is still
   * running, or when the in-memory store still holds it open for writing.
   */
  function liveState(sessionId) {
    const bare = bareId(sessionId);
    const agents = safeGet(ctx, 'agents');
    if (agents && typeof agents.get === 'function') {
      for (const variant of idVariants(sessionId)) {
        let agent;
        try {
          agent = agents.get(variant);
        } catch {
          agent = undefined;
        }
        if (!agent) continue;
        const status = agent.status || agent.state || '';
        if (status === 'running' || status === 'streaming' || status === 'pending') {
          return { live: true, reason: `${zh.live}（agent ${status}）` };
        }
      }
    }
    const sessions = safeGet(ctx, 'sessions');
    if (sessions && typeof sessions.get === 'function') {
      for (const variant of idVariants(sessionId)) {
        let session;
        try {
          session = sessions.get(variant);
        } catch {
          session = undefined;
        }
        if (session) return { live: true, reason: zh.live };
      }
    }
    void bare;
    return { live: false, reason: '' };
  }

  /**
   * Ask the host to forget a session.
   *
   * There is no public "delete session" API, so this uses the same seam the
   * archive action uses: detach the agent first (it owns the writer), then the
   * session. Without this the row stays in the sidebar until the next app
   * restart, which would break the "as if it never existed" promise.
   */
  function hostForget(sessionId) {
    const released = [];
    const agents = safeGet(ctx, 'agents');
    const server = agents && agents.store && typeof agents.store.get === 'function' ? agents.store : undefined;
    for (const variant of idVariants(sessionId)) {
      if (!server) break;
      let entry;
      try {
        entry = server.get(variant);
      } catch {
        entry = undefined;
      }
      if (!entry) continue;
      try {
        agents.detachEntered(entry);
        released.push('agent');
      } catch {
        /* older host without detachEntered */
      }
    }
    const sessions = safeGet(ctx, 'sessions');
    const store = sessions && sessions.store && typeof sessions.store.get === 'function' ? sessions.store : undefined;
    for (const variant of idVariants(sessionId)) {
      if (!store) break;
      let entry;
      try {
        entry = store.get(variant);
      } catch {
        entry = undefined;
      }
      if (!entry) continue;
      try {
        sessions.detachEntered(entry);
        released.push('session');
      } catch {
        /* older host without detachEntered */
      }
    }
    return [...new Set(released)];
  }

  /** Drop the id from the workspace ledger through the public registry API. */
  async function detachFromRegistry(sessionId) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    const done = [];
    if (!registry) return done;

    const archived = (() => {
      try {
        return new Set(registry.archivedSessionIds || []);
      } catch {
        return new Set();
      }
    })();
    const pinned = (() => {
      try {
        return new Set(registry.pinnedSessionIds || []);
      } catch {
        return new Set();
      }
    })();

    for (const variant of idVariants(sessionId)) {
      if (pinned.has(variant) && typeof registry.unpinSession === 'function') {
        try {
          registry.unpinSession(variant);
          done.push('unpin');
        } catch {
          /* ledger rewrite below is the fallback */
        }
      }
    }

    let entities = [];
    try {
      entities = registry.list() || [];
    } catch {
      entities = [];
    }
    for (const entity of entities) {
      let ids = [];
      try {
        ids = entity.sessionIds || [];
      } catch {
        ids = [];
      }
      const hit = ids.some((id) => bareId(id) === bareId(sessionId));
      if (!hit) continue;
      try {
        if (typeof entity.detachSession === 'function') {
          /* `detachSession` is async: without the await its rejection escapes
             this try/catch and reaches the host as an unhandled rejection. */
          await entity.detachSession(sessionId);
          done.push('detach');
        }
      } catch {
        /* fall through to the registry-level call */
      }
    }
    for (const variant of idVariants(sessionId)) {
      if (archived.has(variant) && typeof registry.unarchiveSession === 'function') {
        try {
          registry.unarchiveSession(variant);
          done.push('unarchive');
        } catch {
          /* ledger rewrite below is the fallback */
        }
      }
    }
    return done;
  }

  /** Titles, from the cheapest source that answers. */
  async function readTitles(ids) {
    const titles = new Map();
    const query = safeGet(ctx, 'sessionQuery');
    if (!query || typeof query.readTitleSnapshots !== 'function' || ids.length === 0) return titles;
    const deadline = Date.now() + 2500;
    for (let index = 0; index < ids.length; index += 40) {
      if (Date.now() > deadline) break;
      const chunk = ids.slice(index, index + 40);
      let rows;
      try {
        rows = await query.readTitleSnapshots(chunk);
      } catch {
        break;
      }
      for (const row of rows || []) {
        if (row && row.status === 'fulfilled' && row.value) {
          const title = row.value.title;
          const id = row.value.session && row.value.session.id;
          if (typeof title === 'string' && title.trim() && id) titles.set(bareId(id), title.trim());
        }
      }
    }
    return titles;
  }

  /**
   * Fallback titles straight from the projection cache files.
   *
   * The cache is keyed by the *full* session id (`session-<guid>.json`,
   * `mnemon-run-v1-<guid>.json`), not by the bare guid, so both spellings are
   * probed before giving up. Reading the bare name alone silently missed every
   * workspace session and left the whole list showing 「未命名」.
   *
   * Also returns the sidebar-visible metadata the sidebar row shows, so the
   * dialog can present a row exactly like the sidebar does.
   */
  async function cachedRecords(sessionDirectories) {
    const records = new Map();
    const dir = join(storagesRoot(home()), 'session_projcache', 'sessions');
    for (const entry of sessionDirectories) {
      const candidates = [`${entry.id}.json`, `session-${entry.bare}.json`, `${entry.bare}.json`];
      for (const name of candidates) {
        const data = await readJson(join(dir, name));
        const rows = data && data.record && data.record.rows;
        if (!rows) continue;
        const meta = rows.sessionListMetadata && rows.sessionListMetadata.val;
        const title = rows.title && rows.title.val;
        const titleInput = rows.titleInput && rows.titleInput.val;
        const first = titleInput && titleInput.first && titleInput.first.text;
        records.set(entry.bare, {
          title: typeof title === 'string' ? title.trim() : '',
          firstPrompt: typeof first === 'string' ? first.trim() : '',
          blank: Boolean(meta && meta.blank),
          lastPromptAt: meta && Number.isFinite(meta.lastPromptAt) ? meta.lastPromptAt : 0,
          agentPreset: (rows.agentPreset && rows.agentPreset.val) || ''
        });
        break;
      }
    }
    return records;
  }

  /**
   * The sidebar's own row order.
   *
   * Its session rows sort newest `lastPromptAt` first, and an un-prompted
   * session (`lastPromptAt === null`, i.e. a freshly created blank session) sits
   * at the very top. Matching that key is what makes this dialog read in the
   * same order as the sidebar; `mtimeMs` is only a tie-breaker for the rare row
   * whose projection cache is missing.
   */
  function compareSidebarOrder(left, right) {
    const leftPrompt = left.lastPromptAt || 0;
    const rightPrompt = right.lastPromptAt || 0;
    if (leftPrompt !== rightPrompt) {
      /* 0 means "never prompted", which the sidebar shows first. */
      if (leftPrompt === 0) return -1;
      if (rightPrompt === 0) return 1;
      return rightPrompt - leftPrompt;
    }
    return (right.mtimeMs || 0) - (left.mtimeMs || 0) || String(left.id).localeCompare(String(right.id));
  }

  /**
   * The session inventory the dialog renders.
   *
   * The list is deliberately *registry-driven*, in registry order, because that
   * is exactly what the workspace sidebar renders: `tables.workspaces[<id>]
   * .sessionIds` already arrives newest-first and already excludes the internal
   * background sessions (mnemon checkpoint runs, schedule runs) that exist only
   * as directories on disk. Walking the filesystem instead made this dialog
   * show 148 rows the sidebar has never shown, which is why it did not look
   * like the sidebar at all.
   *
   * Those non-member directories are still real residue, so they are not
   * dropped — they are reported separately and only on request, under an
   * explicit 「未归属工作区」 group the user opts into.
   */
  async function list(options) {
    const wantOrphans = Boolean(options && options.includeOrphans);
    const homePath = home();
    const directories = await listSessionDirs(homePath);
    const registry = safeGet(ctx, 'workspaceRegistry');

    const byBare = new Map();
    for (const dir of directories) {
      if (!byBare.has(dir.bare)) byBare.set(dir.bare, dir);
    }

    const workspaces = [];
    if (registry && typeof registry.list === 'function') {
      let entities = [];
      try {
        entities = registry.list() || [];
      } catch {
        entities = [];
      }
      for (const entity of entities) {
        let ids = [];
        try {
          ids = entity.sessionIds || [];
        } catch {
          ids = [];
        }
        workspaces.push({
          id: entity.id,
          path: entity.path || '',
          title: entity.title || (entity.path ? basename(entity.path) : ''),
          sessionIds: [...ids]
        });
      }
    }

    const archived = (() => {
      try {
        return new Set(registry && registry.archivedSessionIds ? [...registry.archivedSessionIds].map(bareId) : []);
      } catch {
        return new Set();
      }
    })();
    const pinned = (() => {
      try {
        return new Set(registry && registry.pinnedSessionIds ? [...registry.pinnedSessionIds].map(bareId) : []);
      } catch {
        return new Set();
      }
    })();

    /* Which directories does the registry claim? Everything else is residue. */
    const claimed = new Set();
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) claimed.add(bareId(id));
    }

    const current = bareId(currentSessionId());

    const makeRow = (sessionId, dir, workspace) => {
      const bare = bareId(sessionId);
      const record = records.get(bare) || null;
      const state = liveState(sessionId);
      const title = (record && record.title) || '';
      return {
        id: sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`,
        bare,
        title,
        firstPrompt: (record && record.firstPrompt) || '',
        blank: Boolean(record && record.blank),
        lastPromptAt: (record && record.lastPromptAt) || 0,
        agentPreset: (record && record.agentPreset) || '',
        sizeBytes: dir ? dir.sizeBytes : 0,
        mtimeMs: dir ? dir.mtimeMs : 0,
        dirPath: dir ? dir.dirPath : '',
        slug: dir ? dir.slug : '',
        ghost: !dir,
        workspaceId: workspace ? workspace.id : '',
        workspaceTitle: workspace ? workspace.title : '',
        workspacePath: workspace ? workspace.path : '',
        archived: archived.has(bare),
        pinned: pinned.has(bare),
        live: state.live,
        liveReason: state.reason,
        current: bare === current,
        deletable: !state.live && bare !== current
      };
    };

    /* One cheap cache read per candidate, before rows are assembled. */
    const candidates = [];
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) {
        candidates.push(id.startsWith('session-') ? id : `session-${id}`);
      }
    }
    for (const dir of directories) {
      if (!claimed.has(dir.bare)) candidates.push(dir.bare);
    }
    const records = await cachedRecords(candidates.map((id) => ({ id, bare: bareId(id) })));

    /* Live rows get their title from the host, which is authoritative. */
    const liveIds = [];
    for (const id of candidates) {
      if (liveState(id).live) liveIds.push(id);
    }
    const queryTitles = await readTitles(liveIds);

    const groups = [];
    for (const workspace of workspaces) {
      const group = {
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessions: []
      };
      for (const id of workspace.sessionIds) {
        const bare = bareId(id);
        const dir = byBare.get(bare) || null;
        const row = makeRow(id, dir, workspace);
        const liveTitle = queryTitles.get(bare);
        if (liveTitle) row.title = liveTitle;
        group.sessions.push(row);
      }
      /*
       * The sidebar lists a workspace's sessions newest-prompt-first, and an
       * un-prompted session (lastPromptAt null) sits at the very top. Sorting on
       * the same key keeps this dialog in the same order as the sidebar it is
       * meant to mirror, instead of the registry's insertion order.
       */
      group.sessions.sort(compareSidebarOrder);
      if (group.sessions.length > 0) groups.push(group);
    }

    let orphanBytes = 0;
    let orphanCount = 0;
    const orphanDirs = [];
    for (const dir of directories) {
      if (claimed.has(dir.bare)) continue;
      orphanCount += 1;
      orphanBytes += dir.sizeBytes;
      orphanDirs.push(dir);
    }

    /*
     * No registry at all (a headless context, or a damaged registry) must not
     * mean "no sessions": fall back to the on-disk inventory so the dialog can
     * still be used, with the workspace labels left blank.
     */
    if (workspaces.length === 0) {
      const group = { id: '~disk', title: '', path: '', sessions: [] };
      for (const dir of directories.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        const row = makeRow(dir.bare, dir, null);
        group.sessions.push(row);
      }
      if (group.sessions.length > 0) groups.push(group);
    }

    if (wantOrphans && orphanDirs.length > 0) {
      const group = {
        id: '~unregistered',
        title: '',
        path: '',
        orphan: true,
        sessions: []
      };
      for (const dir of orphanDirs.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        const row = makeRow(dir.bare, dir, null);
        row.orphan = true;
        group.sessions.push(row);
      }
      groups.push(group);
    }

    /* Flat rows follow the rendered group order so the footer totals agree. */
    const rows = groups.flatMap((group) => group.sessions);

    return {
      home: homePath,
      root: sessionsRoot(homePath),
      groups,
      sessions: rows,
      totalBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      currentSessionId: current ? `session-${current}` : '',
      includeOrphans: wantOrphans,
      orphanCount,
      orphanBytes
    };
  }

  /**
   * Everything that will be removed for one session, without removing it.
   * Used by the confirmation dialog so the user sees the real blast radius.
   */
  async function inspect(ids) {
    const homePath = home();
    const directories = await listSessionDirs(homePath);
    const report = [];
    for (const sessionId of ids) {
      const matched = dirsFor(directories, sessionId);
      const files = [];
      for (const dir of matched) {
        files.push({ path: dir.logPath, bytes: dir.sizeBytes });
      }
      const projcache = join(storagesRoot(homePath), 'session_projcache', 'sessions');
      const policy = join(storagesRoot(homePath), 'vision_router_session_policy', 'policies');
      for (const variant of idVariants(sessionId)) {
        if (existsSync(join(projcache, `${variant}.json`))) {
          files.push({ path: join(projcache, `${variant}.json`), bytes: 0 });
        }
        if (existsSync(join(policy, `${variant}.json`))) {
          files.push({ path: join(policy, `${variant}.json`), bytes: 0 });
        }
      }
      const state = liveState(sessionId);
      report.push({
        id: sessionId,
        bare: bareId(sessionId),
        dirs: matched.map((dir) => dir.dirPath),
        files,
        live: state.live,
        liveReason: state.reason,
        blocked: state.live || bareId(sessionId) === bareId(currentSessionId())
      });
    }
    return report;
  }

  /**
   * Permanently delete sessions.
   *
   * Each id is processed independently and its outcome reported, but the batch
   * is *pre-flighted first*: if any selected session is live or still being
   * written, nothing is deleted at all. Partial deletion of a user's selection
   * is worse than a clean refusal.
   */
  async function purge(rawIds, options) {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id) => typeof id === 'string' && id.trim()) : [];
    if (ids.length === 0) throw failure('empty', zh.empty, 400);
    const dryRun = Boolean(options && options.dryRun);

    guard();
    try {
      const homePath = home();
      const directories = await listSessionDirs(homePath);
      const plan = [];

      // ---- pre-flight: nothing is deleted until the whole batch passes ----
      for (const sessionId of ids) {
        const matched = dirsFor(directories, sessionId);
        const state = liveState(sessionId);
        if (state.live) throw failure('live', `${zh.live}：${state.reason || sessionId}`, 409);
        if (bareId(sessionId) === bareId(currentSessionId())) {
          throw failure('current', zh.current, 409);
        }
        for (const dir of matched) {
          if (!isInside(sessionsRoot(homePath), dir.dirPath)) {
            throw failure('outside', `${zh.outside}：${dir.dirPath}`, 403);
          }
          const quiet = await waitForQuiescence(dir);
          if (!quiet.quiet) {
            throw failure('busy', `${zh.busy}：${sessionId}`, 409);
          }
        }
        plan.push({ id: sessionId, matched });
      }

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          plan: plan.map((item) => ({
            id: item.id,
            dirs: item.matched.map((dir) => dir.dirPath),
            bytes: item.matched.reduce((sum, dir) => sum + dir.sizeBytes, 0)
          }))
        };
      }

      // ---- attachment reference counting, before any log is removed ----
      const doomedDirs = plan.flatMap((item) => item.matched);
      const doomedBares = new Set(plan.map((item) => bareId(item.id)));
      const survivors = directories.filter((dir) => !doomedBares.has(dir.bare));
      const doomedHashes = await hashesInLogs(doomedDirs);
      const survivorHashes = await hashesInLogs(survivors);
      const orphanHashes = new Set();
      for (const hash of doomedHashes) {
        if (!survivorHashes.has(hash)) orphanHashes.add(hash);
      }

      // ---- delete ----
      /*
       * Order matters, and it is not the obvious one.
       *
       * The workspace ledger must lose an id BEFORE its log disappears. The host
       * re-reads every member header on boot (`WorkspaceRegistry.init` →
       * `indexStoredHeaders`) and `attachSession` throws
       * `session persistence holds no such session` when the header is gone,
       * which surfaces as `dsh: fatal load failure` and kills the app on the
       * next start. A dangling *ledger* row with no log is therefore fatal,
       * while a log with no ledger row is merely an orphan the plugin can sweep
       * later. So: registry first, bytes second.
       */
      const results = [];
      for (const item of plan) {
        const sessionId = item.id;
        const record = {
          id: sessionId,
          bare: bareId(sessionId),
          removed: [],
          bytes: 0,
          warnings: [],
          ok: false
        };
        try {
          // 1. host forget first: closes the persistence writer.
          const released = hostForget(sessionId);
          if (released.length > 0) record.removed.push(`宿主释放（${released.join('+')}）`);

          // 2. registry membership + flags. Before the bytes.
          const detached = await detachFromRegistry(sessionId);
          if (detached.length > 0) record.removed.push(`登记表（${detached.join('+')}）`);

          /*
           * 2b. Prove the ledger no longer names it. `detachFromRegistry` swallows
           *     errors by design (it is a best-effort API dance), so the only
           *     trustworthy signal is a re-read. Removing the log while a member
           *     row survives turns the next boot into `dsh: fatal load failure`.
           */
          if (stillRegistered(sessionId)) {
            record.removed.push(...(await forceDetach(homePath, sessionId)));
            if (stillRegistered(sessionId)) {
              throw failure(
                'registered',
                `登记表仍登记该会话，已放弃删除以免下次启动失败：${sessionId}`,
                409
              );
            }
          }

          // 3. per-session caches: derived data, safe to drop first, and the
          //    projection cache carries the title and cwd of the session.
          for (const name of await removeProjectionCache(homePath, sessionId)) record.removed.push(name);
          for (const name of await removePolicyRecord(homePath, sessionId)) record.removed.push(name);

          // 4. the session directory itself, last.
          for (const dir of item.matched) {
            const ok = await removeSessionDir(dir.dirPath);
            record.bytes += dir.sizeBytes;
            record.removed.push(ok ? `会话目录 ${dir.dirPath}` : `会话目录未完全删除 ${dir.dirPath}`);
            if (!ok) record.warnings.push(`目录残留：${dir.dirPath}`);
            await pruneEmptyDirs(join(dir.dirPath, '..'));
          }

          record.ok = record.warnings.length === 0;
        } catch (error) {
          record.warnings.push(message(error));
        }
        results.push(record);
      }

      // ---- ledgers + references (one pass for the whole batch) ----
      const ledgerNotes = [];
      try {
        const workspaceEdit = await editWorkspaceLedger(homePath, ids);
        if (workspaceEdit.removed > 0) ledgerNotes.push(`workspace.json 清理 ${workspaceEdit.removed} 处`);
      } catch (error) {
        ledgerNotes.push(`workspace.json 清理失败：${message(error)}`);
      }
      try {
        const costEdit = await editCostLedger(homePath, ids);
        if (costEdit.removed > 0) ledgerNotes.push(`cost-meter 清理 ${costEdit.removed} 条记账`);
      } catch (error) {
        ledgerNotes.push(`cost-meter 清理失败：${message(error)}`);
      }
      try {
        const overviewEdit = await editOverviewCache(homePath, ids);
        if (overviewEdit.removed > 0) ledgerNotes.push(`context 概览缓存清理 ${overviewEdit.removed} 条`);
      } catch (error) {
        ledgerNotes.push(`context 概览缓存清理失败：${message(error)}`);
      }

      const scheduleNote = { targets: [], notes: [] };
      try {
        const scheduleEdit = await editScheduleRefs(homePath, ids);
        if (scheduleEdit.stripped > 0) scheduleNote.notes.push(`定时任务引用清理 ${scheduleEdit.stripped} 处`);
        for (const target of scheduleEdit.targets) {
          scheduleNote.targets.push(target);
          scheduleNote.notes.push(`定时任务「${target.title}」原本指向被删会话，已改用该任务自带的保留目标，任务保留`);
        }
      } catch (error) {
        scheduleNote.notes.push(`定时任务引用清理失败：${message(error)}`);
      }

      // ---- orphaned attachment blobs ----
      const attachmentNote = { removed: 0, bytes: 0, notes: [] };
      try {
        const sweep = await sweepAttachments(homePath, orphanHashes);
        attachmentNote.removed = sweep.removed;
        attachmentNote.bytes = sweep.bytes;
        if (sweep.removed > 0) attachmentNote.notes.push(`无主附件清理 ${sweep.removed} 个文件`);
      } catch (error) {
        attachmentNote.notes.push(`附件清理失败：${message(error)}`);
      }

      resync();

      return {
        ok: results.every((record) => record.ok),
        deleted: results.filter((record) => record.ok).map((record) => record.id),
        failed: results.filter((record) => !record.ok).map((record) => ({ id: record.id, warnings: record.warnings })),
        results,
        bytes: results.reduce((sum, record) => sum + record.bytes, 0),
        attachments: attachmentNote,
        ledgers: ledgerNotes,
        schedules: scheduleNote,
        remaining: await countRemaining(homePath, ids)
      };
    } finally {
      release();
    }
  }

  /** Ask the client to re-read its projections so deleted rows vanish. */
  function resync() {
    try {
      ctx.emit('session/purged', {});
    } catch {
      /* no listeners is fine */
    }
    try {
      const sessions = safeGet(ctx, 'sessions');
      if (sessions && typeof sessions.refresh === 'function') sessions.refresh();
    } catch {
      /* best effort */
    }
  }

  /** After deletion, confirm nothing matching the ids is left behind. */
  async function countRemaining(homePath, ids) {
    const leftover = [];
    const directories = await listSessionDirs(homePath);
    for (const sessionId of ids) {
      if (dirsFor(directories, sessionId).length > 0) leftover.push({ id: sessionId, kind: 'session-dir' });
      for (const variant of idVariants(sessionId)) {
        if (existsSync(join(storagesRoot(homePath), 'session_projcache', 'sessions', `${variant}.json`))) {
          leftover.push({ id: sessionId, kind: 'projection-cache' });
        }
        if (existsSync(join(storagesRoot(homePath), 'vision_router_session_policy', 'policies', `${variant}.json`))) {
          leftover.push({ id: sessionId, kind: 'policy' });
        }
      }
    }
    const ledger = await readJson(join(storagesRoot(homePath), 'workspace.json'));
    if (ledger && ledger.global && Array.isArray(ledger.global.archivedSessionIds)) {
      for (const sessionId of ids) {
        const bare = bareId(sessionId);
        if (ledger.global.archivedSessionIds.some((id) => bareId(id) === bare)) {
          leftover.push({ id: sessionId, kind: 'archived-flag' });
        }
      }
    }
    /* A membership row left behind means the ledger rewrite lost a race with
       the Host. Report it instead of claiming a clean delete. */
    const workspaces = ledger && ledger.tables && ledger.tables.workspaces && typeof ledger.tables.workspaces === 'object'
      ? ledger.tables.workspaces
      : {};
    for (const sessionId of ids) {
      const bare = bareId(sessionId);
      for (const record of Object.values(workspaces)) {
        if (!record || !Array.isArray(record.sessionIds)) continue;
        if (record.sessionIds.some((id) => bareId(id) === bare)) {
          leftover.push({ id: sessionId, kind: 'workspace-membership' });
          break;
        }
      }
    }
    return leftover;
  }

  /* ── recycle bin ──────────────────────────────────────────────────────── */

  function retentionDays() {
    return retentionFrom(config);
  }

  /**
   * Every path that belongs to one session and can be parked in the bin.
   *
   * The log directory and the two per-session caches are the only files that
   * live under a session's own name, so they are the only ones that can be
   * given back byte-for-byte on restore.
   */
  function payloadOf(homePath, sessionId, matched) {
    const sessionDirs = matched.map((dir) => ({ from: dir.dirPath, name: basename(dir.dirPath) }));
    const files = [];
    const projcache = join(storagesRoot(homePath), 'session_projcache', 'sessions');
    const policy = join(storagesRoot(homePath), 'vision_router_session_policy', 'policies');
    for (const variant of idVariants(sessionId)) {
      const cache = join(projcache, `${variant}.json`);
      if (existsSync(cache)) files.push({ from: cache, name: `${variant}.json` });
      const record = join(policy, `${variant}.json`);
      if (existsSync(record)) files.push({ from: record, name: `${variant}.json` });
    }
    return { sessionDirs, files };
  }

  /**
   * Where the session sits in the workspace right now, so a restore can put it
   * back in the same place instead of appending it to the bottom.
   */
  function placeOf(sessionId) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    if (!registry) return { workspaceId: '', index: -1 };
    let entities = [];
    try {
      entities = registry.list() || [];
    } catch {
      entities = [];
    }
    for (const entity of entities) {
      let ids = [];
      try {
        ids = entity.sessionIds || [];
      } catch {
        ids = [];
      }
      const index = ids.findIndex((id) => bareId(id) === bareId(sessionId));
      if (index >= 0) return { workspaceId: String(entity.id || ''), index };
    }
    return { workspaceId: '', index: -1 };
  }

  /**
   * Is this id still named anywhere the host will validate on boot?
   *
   * The host walks every ledger member through `attachSession`, so a member
   * whose log is gone is a hard boot failure. Moving bytes while the ledger
   * still names the session is exactly that window — so this predicate is
   * checked right before each move, not merely assumed from the earlier
   * detach call (which silently swallows errors).
   */
  function stillRegistered(sessionId) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    if (!registry) return false;
    const wanted = bareId(sessionId);
    let entities = [];
    try {
      entities = registry.list() || [];
    } catch {
      return true; /* cannot prove it is gone — treat as still named */
    }
    for (const entity of entities) {
      let ids = [];
      try {
        ids = entity.sessionIds || [];
      } catch {
        ids = [];
      }
      if (ids.some((id) => bareId(id) === wanted)) return true;
    }
    return false;
  }

  /**
   * Does the host's own persistence catalog know this session?
   *
   * `attachSession` asks `readSessionHeader`, which only answers for sessions in
   * the persistence listing. Calling attach for an id the catalog has never seen
   * is therefore a guaranteed throw — and an un-handled one is fatal to the host.
   * Restoring bytes is always safe; announcing them to the sidebar is not.
   */
  async function hostKnows(sessionId) {
    const persistence = safeGet(ctx, 'sessionPersistence');
    if (!persistence || typeof persistence.stat !== 'function') return true; /* cannot prove otherwise */
    for (const variant of idVariants(sessionId)) {
      try {
        const snapshot = await persistence.stat(variant);
        if (snapshot) return true;
      } catch {
        /* try the next spelling */
      }
    }
    return false;
  }

  /** Last-resort ledger strip, used when the registry API refused to detach. */
  async function forceDetach(homePath, sessionId) {
    const notes = [];
    try {
      const edit = await editWorkspaceLedger(homePath, [sessionId]);
      if (edit.removed > 0) notes.push(`workspace.json 强制清理 ${edit.removed} 处`);
    } catch (error) {
      notes.push(`workspace.json 强制清理失败：${message(error)}`);
    }
    return notes;
  }

  function flagsOf(sessionId) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    const has = (list) => {
      try {
        return Array.isArray(list) && list.some((id) => bareId(id) === bareId(sessionId));
      } catch {
        return false;
      }
    };
    if (!registry) return { archived: false, pinned: false };
    return {
      archived: has(registry.archivedSessionIds),
      pinned: has(registry.pinnedSessionIds)
    };
  }

  /**
   * Move sessions into the recycle bin.
   *
   * Same pre-flight as a hard delete — the batch either passes completely or
   * nothing is touched — but the log directory and the per-session caches are
   * *renamed* into the bin instead of being unlinked, so `restore` can hand
   * them back exactly as they were.
   *
   * Ledger cleanup still happens immediately: while a session sits in the bin
   * it must not appear in the sidebar, in the workspace registration, in cost
   * accounting or in a scheduled task. Only the bytes are reversible.
   */
  async function trash(rawIds, options) {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id) => typeof id === 'string' && id.trim()) : [];
    if (ids.length === 0) throw failure('empty', zh.empty, 400);

    guard();
    try {
      const homePath = home();
      const directoryList = await listSessionDirs(homePath);
      const plan = [];

      for (const sessionId of ids) {
        const matched = dirsFor(directoryList, sessionId);
        const state = liveState(sessionId);
        if (state.live) throw failure('live', `${zh.live}：${state.reason || sessionId}`, 409);
        if (bareId(sessionId) === bareId(currentSessionId())) {
          throw failure('current', zh.current, 409);
        }
        for (const dir of matched) {
          if (!isInside(sessionsRoot(homePath), dir.dirPath)) {
            throw failure('outside', `${zh.outside}：${dir.dirPath}`, 403);
          }
          const quiet = await waitForQuiescence(dir);
          if (!quiet.quiet) throw failure('busy', `${zh.busy}：${sessionId}`, 409);
        }
        plan.push({ id: sessionId, matched });
      }

      /* Attachment blobs stay put: they are content-addressed, shared, and
         only become orphaned once the entry is destroyed for good. */
      const doomedDirs = plan.flatMap((item) => item.matched);
      const doomedBares = new Set(plan.map((item) => bareId(item.id)));
      const survivors = directoryList.filter((dir) => !doomedBares.has(dir.bare));
      const doomedHashes = await hashesInLogs(doomedDirs);
      const survivorHashes = await hashesInLogs(survivors);
      const orphanHashes = new Set();
      for (const hash of doomedHashes) {
        if (!survivorHashes.has(hash)) orphanHashes.add(hash);
      }

      const titles = await readTitles(plan.map((item) => item.id));
      const records = await cachedRecords(plan.flatMap((item) => item.matched));
      const retention = retentionDays();

      /* Capture where each session sat, and its flags, BEFORE the ledger is
         touched. Detaching first is required for crash safety, but it also
         erases the very membership the bin needs to restore the row to its old
         place, so the snapshot has to be taken up front. */
      const places = new Map();
      const flagsById = new Map();
      for (const item of plan) {
        places.set(item.id, placeOf(item.id));
        flagsById.set(item.id, flagsOf(item.id));
      }

      const results = [];
      const entryIds = [];

      for (const item of plan) {
        const sessionId = item.id;
        const bare = bareId(sessionId);
        const record = { id: sessionId, bare, entryId: '', moved: [], bytes: 0, warnings: [], ok: false };
        try {
          const released = hostForget(sessionId);
          if (released.length > 0) record.moved.push(`宿主释放（${released.join('+')}）`);

          /* Detach from the ledger BEFORE the bytes move. The host validates
             every member header on boot, so a ledger row whose log has been
             parked in the bin is a `dsh: fatal load failure` on next start;
             the reverse (orphan log, no ledger row) is harmless. */
          const detached = await detachFromRegistry(sessionId);
          if (detached.length > 0) record.moved.push(`登记表（${detached.join('+')}）`);

          /* Same guard as purge: the bytes may not move while the host still
             validates this id on boot. */
          if (stillRegistered(sessionId)) {
            record.moved.push(...(await forceDetach(homePath, sessionId)));
            if (stillRegistered(sessionId)) {
              throw failure(
                'registered',
                `登记表仍登记该会话，已放弃删除以免下次启动失败：${sessionId}`,
                409
              );
            }
          }

          const payload = payloadOf(homePath, sessionId, item.matched);
          const flags = flagsById.get(sessionId) || { archived: false, pinned: false };
          const place = places.get(sessionId) || { workspaceId: '', index: -1 };
          const cached = records.get(bare);
          const entryId = randomUUID();
          const outcome = await moveIntoTrash(homePath, {
            entryId,
            sessionDirs: payload.sessionDirs,
            files: payload.files,
            entry: {
              id: sessionId,
              bare,
              title: titles.get(bare) || (cached && cached.title) || '',
              deletedAt: Date.now(),
              retentionDays: retention,
              sessionDirs: payload.sessionDirs,
              files: payload.files,
              workspace: place,
              archived: flags.archived,
              pinned: flags.pinned,
              hashes: [...orphanHashes]
            }
          });
          record.entryId = outcome.entryId;
          record.bytes = outcome.bytes;
          if (outcome.entry) entryIds.push(outcome.entry.entryId);
          for (const moved of outcome.moved) {
            record.moved.push(`${moved.kind === 'dir' ? '会话目录' : '缓存文件'} ${moved.from}`);
          }
          for (const skipped of outcome.skipped) {
            if (skipped.reason !== 'missing') record.warnings.push(`跳过 ${skipped.from}：${skipped.reason}`);
          }
          for (const problem of outcome.failed) {
            record.warnings.push(`未能移入回收站 ${problem.from}：${problem.error}`);
          }

          record.ok = record.warnings.length === 0;
        } catch (error) {
          record.warnings.push(message(error));
        }
        results.push(record);
      }

      /* Keep the bin index honest even when a move half-failed: an entry with
         no bytes on disk would show up as a phantom row nobody can restore. */
      if (entryIds.length > 0) {
        try {
          const index = await readTrashIndex(homePath);
          const keep = index.entries.filter((entry) => {
            const dir = join(storagesRoot(homePath), 'dsh-session-purge', 'trash', entry.entryId);
            return existsSync(join(dir, 'payload'));
          });
          if (keep.length !== index.entries.length) {
            await writeTrashIndexAt(homePath, { version: index.version, entries: keep });
          }
        } catch {
          /* the sweep below retries this */
        }
      }

      const ledgerNotes = await tidyLedgers(homePath, ids);
      resync();

      return {
        ok: results.every((record) => record.ok),
        trashed: results.filter((record) => record.ok).map((record) => record.id),
        failed: results
          .filter((record) => !record.ok)
          .map((record) => ({ id: record.id, warnings: record.warnings })),
        results,
        entryIds,
        bytes: results.reduce((sum, record) => sum + record.bytes, 0),
        ledgers: ledgerNotes,
        retentionDays: retention,
        remaining: await countRemaining(homePath, ids)
      };
    } finally {
      release();
    }
  }

  /** The ledger pass shared by `purge` and `trash`. */
  async function tidyLedgers(homePath, ids) {
    const notes = [];
    try {
      const edit = await editWorkspaceLedger(homePath, ids);
      if (edit.removed > 0) notes.push(`workspace.json 清理 ${edit.removed} 处`);
    } catch (error) {
      notes.push(`workspace.json 清理失败：${message(error)}`);
    }
    try {
      const edit = await editCostLedger(homePath, ids);
      if (edit.removed > 0) notes.push(`cost-meter 清理 ${edit.removed} 条记账`);
    } catch (error) {
      notes.push(`cost-meter 清理失败：${message(error)}`);
    }
    try {
      const edit = await editOverviewCache(homePath, ids);
      if (edit.removed > 0) notes.push(`context 概览缓存清理 ${edit.removed} 条`);
    } catch (error) {
      notes.push(`context 概览缓存清理失败：${message(error)}`);
    }
    try {
      const edit = await editScheduleRefs(homePath, ids);
      if (edit.stripped > 0) notes.push(`定时任务引用清理 ${edit.stripped} 处`);
      for (const target of edit.targets) {
        notes.push(`定时任务「${target.title}」原本指向该会话，已改用任务自带的保留目标，任务保留`);
      }
    } catch (error) {
      notes.push(`定时任务引用清理失败：${message(error)}`);
    }
    return notes;
  }

  /** The bin as the UI should paint it, with the retention policy attached. */
  async function trashList() {
    const homePath = home();
    /* Sweep first: a session that expired while the app was closed should not
       be advertised as restorable. */
    let swept = { purged: [], bytes: 0, failed: [] };
    try {
      swept = await sweepExpired(homePath, Date.now());
    } catch {
      /* a broken index must not hide the rows that are still fine */
    }
    const listing = await listTrash(homePath);
    if (swept.purged.length > 0) resync();
    return {
      entries: listing.entries,
      totalBytes: listing.totalBytes,
      retentionDays: retentionDays(),
      swept: swept.purged.length,
      sweptBytes: swept.bytes
    };
  }

  /**
   * Put entries back exactly where they came from.
   *
   * Bytes first, registry second: attaching a session whose log is still in the
   * bin would give the sidebar a row that throws when clicked.
   */
  async function restore(rawEntryIds) {
    const entryIds = Array.isArray(rawEntryIds)
      ? rawEntryIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    if (entryIds.length === 0) throw failure('empty', '未选择要还原的会话', 400);

    guard();
    try {
      const homePath = home();
      const index = await readTrashIndex(homePath);
      const byId = new Map(index.entries.map((entry) => [entry.entryId, entry]));
      const registry = safeGet(ctx, 'workspaceRegistry');
      const done = [];
      const failed = [];
      const restoredIds = [];

      for (const entryId of entryIds) {
        const entry = byId.get(entryId);
        if (!entry) {
          failed.push({ entryId, warnings: ['回收站里没有这个条目'] });
          continue;
        }
        try {
          const outcome = await restoreEntry(homePath, entry);
          const warnings = [];
          for (const problem of outcome.failed) warnings.push(`还原失败 ${problem.from}：${problem.error}`);
          for (const gone of outcome.missing) warnings.push(`回收站里缺少 ${gone.name}`);
          if (outcome.restored.length === 0) {
            failed.push({ entryId, id: entry.id, warnings: warnings.length > 0 ? warnings : ['没有可还原的文件'] });
            continue;
          }

          /* Re-attach to the workspace it was taken from, at its old index. */
          if (registry && typeof registry.list === 'function') {
            /*
             * Only announce a session the host's catalog can actually answer for.
             * A restored-but-unknown id would make `attachSession` throw, and the
             * sidebar row would be dead on arrival. The bytes are already back on
             * disk either way, so skipping the announce loses nothing.
             */
            if (!(await hostKnows(entry.id))) {
              warnings.push('会话文件已还原，但宿主索引里没有它的记录，未自动放回侧栏（重启后会按磁盘重新收录）');
            } else {
              let entities = [];
              try {
                entities = registry.list() || [];
              } catch {
                entities = [];
              }
              const wanted = entry.workspace && entry.workspace.workspaceId;
              const target = entities.find((entity) => String(entity.id || '') === wanted) || entities[0];
              if (target) {
                /*
                 * `attachSession` is async and *throws* when the host does not know
                 * the session (its `readSessionHeader` cannot find a header). An
                 * un-awaited call would let that rejection escape this try/catch
                 * and reach the host process as an unhandled rejection, which is a
                 * `dsh: fatal load failure` on the next boot. Await it, and treat a
                 * refusal as "the bytes came back but the sidebar will not show it"
                 * rather than as a reason to lose the files.
                 */
                try {
                  if (typeof target.attachSession === 'function') await target.attachSession(entry.id);
                  else if (typeof target.insertSessionBefore === 'function') await target.insertSessionBefore(entry.id, null);
                } catch (error) {
                  warnings.push(`工作区登记还原失败：${message(error)}`);
                }
              }
            }
          }
          if (entry.archived && registry && typeof registry.archiveSession === 'function') {
            try {
              registry.archiveSession(entry.id, { stopActivity: true });
            } catch {
              /* archived is a cosmetic flag */
            }
          }
          if (entry.pinned && registry && typeof registry.pinSession === 'function') {
            try {
              registry.pinSession(entry.id);
            } catch {
              /* pinned is a cosmetic flag */
            }
          }

          done.push({ entryId, id: entry.id, files: outcome.restored.length, warnings });
          restoredIds.push(entryId);
        } catch (error) {
          failed.push({ entryId, id: entry.id, warnings: [message(error)] });
        }
      }

      if (restoredIds.length > 0) {
        const keep = index.entries.filter((entry) => !restoredIds.includes(entry.entryId));
        await writeTrashIndexAt(homePath, { version: index.version, entries: keep });
      }
      resync();

      return {
        ok: failed.length === 0,
        restored: done,
        failed,
        remaining: (await listTrash(homePath)).entries.length
      };
    } finally {
      release();
    }
  }

  /**
   * Destroy bin entries for good: parked bytes, then the attachment blobs that
   * only those sessions referenced.
   */
  async function purgeForever(rawEntryIds) {
    const entryIds = Array.isArray(rawEntryIds)
      ? rawEntryIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    if (entryIds.length === 0) throw failure('empty', '未选择要彻底删除的会话', 400);

    guard();
    try {
      const homePath = home();
      const index = await readTrashIndex(homePath);
      const byId = new Map(index.entries.map((entry) => [entry.entryId, entry]));
      const destroyed = [];
      const failed = [];
      const removedEntries = [];
      const hashes = new Set();
      let bytes = 0;

      for (const entryId of entryIds) {
        const entry = byId.get(entryId);
        if (!entry) {
          failed.push({ entryId, warnings: ['回收站里没有这个条目'] });
          continue;
        }
        try {
          const outcome = await deleteEntryPayload(homePath, entry);
          bytes += outcome.bytes || 0;
          for (const hash of Array.isArray(entry.hashes) ? entry.hashes : []) hashes.add(hash);
          destroyed.push({ entryId, id: entry.id, bytes: outcome.bytes || 0 });
          removedEntries.push(entryId);
        } catch (error) {
          failed.push({ entryId, id: entry.id, warnings: [message(error)] });
        }
      }

      const attachments = { removed: 0, bytes: 0, notes: [] };
      if (hashes.size > 0) {
        try {
          const sweep = await sweepAttachments(homePath, hashes);
          attachments.removed = sweep.removed;
          attachments.bytes = sweep.bytes;
          if (sweep.removed > 0) attachments.notes.push(`无主附件清理 ${sweep.removed} 个文件`);
        } catch (error) {
          attachments.notes.push(`附件清理失败：${message(error)}`);
        }
      }

      if (removedEntries.length > 0) {
        const keep = index.entries.filter((entry) => !removedEntries.includes(entry.entryId));
        await writeTrashIndexAt(homePath, { version: index.version, entries: keep });
      }
      resync();

      return {
        ok: failed.length === 0,
        destroyed,
        failed,
        bytes,
        attachments,
        remaining: (await listTrash(homePath)).entries.length
      };
    } finally {
      release();
    }
  }

  /** Empty the bin: every entry, no selection required. */
  async function emptyTrash() {
    const listing = await listTrash(home());
    const ids = listing.entries.map((entry) => entry.entryId);
    if (ids.length === 0) {
      return { ok: true, destroyed: [], failed: [], bytes: 0, attachments: { removed: 0, bytes: 0, notes: [] }, remaining: 0 };
    }
    return purgeForever(ids);
  }

  return { list, inspect, purge, trash, trashList, restore, purgeForever, emptyTrash, retentionDays };
}

export { statusOf, groupBySlug, sessionsRoot };
