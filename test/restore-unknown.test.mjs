/**
 * test/restore-unknown.test.mjs — restoring a session the host catalog forgot.
 *
 * CONTEXT (why this file exists)
 * ------------------------------
 * The 6th boot crash on this machine came from this exact shape:
 *
 *   dsh: fatal load failure: Error: cannot validate session
 *     'session-binlive-…': session persistence holds no such session
 *     at WorkspaceRegistry.readSessionHeader (dsh-workspace/lib/index.js:933)
 *     at async WorkspaceEntity.attachSession  (dsh-workspace/lib/index.js:113)
 *
 * Two independent faults produced it, and both are pinned here:
 *
 *   1. `restore()` called the *async* `attachSession()` without `await`. The
 *      rejection therefore escaped the surrounding `try/catch`, reached the host
 *      as an unhandled rejection, and killed the process. Same class of bug in
 *      `detachFromRegistry()`, which called the async `entity.detachSession()`
 *      bare.
 *
 *   2. Even awaited, attaching an id the host's persistence catalog has never
 *      seen is a *guaranteed* throw. Restoring the bytes of such a session is
 *      still correct and safe — announcing it to the sidebar is not. So the
 *      service now asks `hostKnows()` first and skips the announce, with a
 *      warning, instead of throwing.
 *
 * The invariant both tests defend: **restore never produces an unhandled
 * rejection, and never leaves the host holding a membership it cannot validate.**
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeChecker, makeCtx, makeTempHome, workspaceLedger } from './helpers.mjs';
import { createPurgeService } from '../lib/service.js';

const { home, storages, cleanup } = makeTempHome('sp-restore-unknown-');
const checker = makeChecker('restore-unknown');
const { check, group } = checker;

const SLUG = '--restore-slug--';
const SESSIONS = join(home, 'sessions', SLUG);
const PROCACHE = join(home, 'storages', 'session_projcache', 'sessions');
const LEDGER = join(storages, 'workspace.json');
const TRASH_BIN = join(storages, 'dsh-session-purge', 'trash');

/** A session on disk with the log the host's boot validator looks for. */
function seedSession(name) {
  const id = `session-${name}`;
  const dir = join(SESSIONS, id);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(log, `${JSON.stringify({ type: 'session', version: 4, id: name })}\n`, 'utf8');
  mkdirSync(PROCACHE, { recursive: true });
  writeFileSync(join(PROCACHE, `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { val: name } } } }), 'utf8');
  return { id, bare: name, dir, log };
}

/**
 * A registry whose `attachSession` rejects exactly like the real host does for an
 * unknown id, and whose `detachSession` is async (as in dsh-workspace:148).
 *
 * `attachAttempts` records every call so the test can assert the guard skipped it
 * rather than relying on the rejection being swallowed.
 */
function makeHostLikeRegistry(ids, known) {
  const attachAttempts = [];
  const entity = {
    id: 'ws-1',
    path: join(home, 'ws'),
    title: 'probe',
    sessionIds: [...ids],
    async attachSession(sessionId) {
      attachAttempts.push(sessionId);
      if (!known.has(String(sessionId).replace(/^session-/, ''))) {
        throw new Error(`cannot validate session '${sessionId}': session persistence holds no such session`);
      }
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
    },
    async insertSessionBefore(sessionId) {
      return this.attachSession(sessionId);
    },
    async detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter((item) => item !== sessionId);
    }
  };
  return {
    archivedSessionIds: [],
    pinnedSessionIds: [],
    attachAttempts,
    entities: [entity],
    list() {
      return [entity];
    },
    get(id) {
      return String(id) === 'ws-1' ? entity : undefined;
    },
    unpinSession() {},
    unarchiveSession() {}
  };
}

/** A `sessionPersistence` stub: `stat` answers only for ids in `known`. */
function makePersistence(known) {
  return {
    async stat(sessionId) {
      const bare = String(sessionId).replace(/^session-/, '');
      return known.has(bare) ? { header: { id: bare }, sizeBytes: 1 } : undefined;
    }
  };
}

/* ── 1. restore of a session the catalog forgot ───────────────────────────── */

group('1. restore never attaches an id the host cannot validate');

const known = new Set(['restknown']);
const forgotten = seedSession('restforgotten');

writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([forgotten.id]), null, 2)}\n`, 'utf8');
const registry = makeHostLikeRegistry([forgotten.id], known);
const persistence = makePersistence(known);
const service = createPurgeService(makeCtx({ workspaceRegistry: registry, sessionPersistence: persistence }));

/* Park it in the bin through the plugin's own path. */
const trashed = await service.trash([forgotten.id]);
check('trash parked the session in the bin', trashed.results[0] && trashed.results[0].ok === true, JSON.stringify(trashed.results[0] && trashed.results[0].warnings));
check('the log left the live store', !existsSync(forgotten.log), forgotten.log);

/* Restore it. If `restore()` ever drops its `await` again, this await rejects or
   the process dies on an unhandled rejection before the assertions run. */
let restoreOutcome;
let restoreError;
try {
  restoreOutcome = await service.restore(trashed.entryIds);
} catch (error) {
  restoreError = error;
}
check('restore did not throw', restoreError === undefined, restoreError && restoreError.message);
check('the log is back on disk', existsSync(forgotten.log), forgotten.log);
check('restore reported the entry as restored', Boolean(restoreOutcome && restoreOutcome.restored.length === 1), JSON.stringify(restoreOutcome && restoreOutcome.restored));

/* The whole point: the guard asked the catalog first and did NOT call attach. */
check('the unknown id was never handed to attachSession', registry.attachAttempts.length === 0, JSON.stringify(registry.attachAttempts));
const warned = (restoreOutcome && restoreOutcome.restored[0] && restoreOutcome.restored[0].warnings) || [];
check('the operator is told why it is not in the sidebar', warned.some((line) => line.includes('宿主索引')), JSON.stringify(warned));
check('the ledger does not name it (nothing to validate at boot)', !registry.entities[0].sessionIds.includes(forgotten.id), JSON.stringify(registry.entities[0].sessionIds));

/* ── 2. a session the catalog DOES know is attached normally ──────────────── */

group('2. a known session is still attached');

const knownEntry = seedSession('restknown');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([knownEntry.id]), null, 2)}\n`, 'utf8');
const registry2 = makeHostLikeRegistry([knownEntry.id], known);
const service2 = createPurgeService(makeCtx({ workspaceRegistry: registry2, sessionPersistence: makePersistence(known) }));

const trashed2 = await service2.trash([knownEntry.id]);
check('trash parked the known session', trashed2.results[0] && trashed2.results[0].ok === true);
const restored2 = await service2.restore(trashed2.entryIds);
check('restore succeeded for the known session', Boolean(restored2 && restored2.restored.length === 1), JSON.stringify(restored2));
check('attachSession was called for it', registry2.attachAttempts.length === 1, JSON.stringify(registry2.attachAttempts));
check('the ledger names it again', registry2.entities[0].sessionIds.includes(knownEntry.id), JSON.stringify(registry2.entities[0].sessionIds));

/* ── 3. a known session whose attach still rejects ────────────────────────── */

/*
 * The catalog knows this one, so the guard lets the attach through — and then the
 * host refuses it anyway (its cwd resolved somewhere else, which is the other
 * `attachSession` throw path in dsh-workspace:122). This is the case that proves
 * the `await` matters: without it the rejection escapes the surrounding
 * try/catch and the host process dies on an unhandled rejection.
 */
group('3. a rejecting attach is caught, not leaked');

const rejectEntry = seedSession('restreject');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([rejectEntry.id]), null, 2)}\n`, 'utf8');

const leaks = [];
const onRejection = (reason) => leaks.push(String((reason && reason.message) || reason));
process.on('unhandledRejection', onRejection);

const rejectingRegistry = makeHostLikeRegistry([rejectEntry.id], new Set(['restreject']));
for (const entity of rejectingRegistry.entities) {
  entity.attachSession = async function attachSession(sessionId) {
    await new Promise((done) => setTimeout(done, 20));
    throw new Error(`cannot attach session '${sessionId}': its cwd resolves to 'C:\\elsewhere'`);
  };
}
const serviceReject = createPurgeService(makeCtx({ workspaceRegistry: rejectingRegistry, sessionPersistence: makePersistence(new Set(['restreject'])) }));
const trashedReject = await serviceReject.trash([rejectEntry.id]);
let rejectedOutcome;
let rejectedError;
try {
  rejectedOutcome = await serviceReject.restore(trashedReject.entryIds);
} catch (error) {
  rejectedError = error;
}
/* Let any escaped rejection surface before asserting. */
await new Promise((done) => setTimeout(done, 150));
process.off('unhandledRejection', onRejection);

check('the rejection did not escape as unhandled', leaks.length === 0, JSON.stringify(leaks));
check('restore still reported the entry as restored', Boolean(rejectedOutcome && rejectedOutcome.restored.length === 1), JSON.stringify(rejectedOutcome && rejectedOutcome.restored));
check('restore itself did not throw', rejectedError === undefined, rejectedError && rejectedError.message);
check('the log came back anyway', existsSync(rejectEntry.log), rejectEntry.log);
const rejectWarnings = (rejectedOutcome && rejectedOutcome.restored[0] && rejectedOutcome.restored[0].warnings) || [];
check('the refusal is reported to the operator', rejectWarnings.some((line) => line.includes('工作区登记还原失败')), JSON.stringify(rejectWarnings));

/* ── 4. an async detach is awaited before the bytes move ──────────────────── */

group('4. an async detach is awaited before the bytes move');

const asyncDetached = seedSession('restasync');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([asyncDetached.id]), null, 2)}\n`, 'utf8');

/* The registry's detachSession resolves only after a tick; if the service does
   not await it, the on-disk ledger is still dirty when the bytes move. */
let detachResolved = false;
const slowRegistry = makeHostLikeRegistry([asyncDetached.id], new Set(['restasync']));
for (const entity of slowRegistry.entities) {
  entity.detachSession = async function detachSession(sessionId) {
    await new Promise((done) => setTimeout(done, 25));
    this.sessionIds = this.sessionIds.filter((item) => item !== sessionId);
    detachResolved = true;
  };
}
const service3 = createPurgeService(makeCtx({ workspaceRegistry: slowRegistry, sessionPersistence: makePersistence(new Set(['restasync'])) }));
const trashed3 = await service3.trash([asyncDetached.id]);
check('trash reported success', trashed3.results[0] && trashed3.results[0].ok === true, JSON.stringify(trashed3.results[0] && trashed3.results[0].warnings));
check('the async detach actually ran', detachResolved === true);
check('the session left the live store', !existsSync(asyncDetached.log), asyncDetached.log);
check('the in-memory ledger no longer names it', !slowRegistry.entities[0].sessionIds.includes(asyncDetached.id), JSON.stringify(slowRegistry.entities[0].sessionIds));

/* ── 5. no unhandled rejection may escape the service ─────────────────────── */

group('5. the service never leaks an unhandled rejection');

const finalLeaks = [];
const onFinalRejection = (reason) => finalLeaks.push(String((reason && reason.message) || reason));
process.on('unhandledRejection', onFinalRejection);
/* Give any escaped rejection a turn to surface. */
await new Promise((done) => setTimeout(done, 120));
process.off('unhandledRejection', onFinalRejection);
check('no unhandled rejection was observed', finalLeaks.length === 0, JSON.stringify(finalLeaks));
check('the bin directory is still a directory', existsSync(TRASH_BIN), TRASH_BIN);

/* ── verdict ──────────────────────────────────────────────────────────────── */

checker.finish();
cleanup();
