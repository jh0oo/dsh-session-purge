/**
 * test/e2e.test.mjs — end-to-end purge against a synthetic store.
 *
 * This is the test that proves the whole promise: after `purge()` resolves,
 * *nothing* about the deleted session survives — not the log directory, not the
 * projection cache, not the policy record, not a ledger row, not an attachment
 * blob — while every neighbouring session is left byte-for-byte intact.
 *
 * It builds a complete fake `$DSH_HOME` on disk (two doomed sessions, one
 * survivor, a workspace ledger, a cost ledger, an overview cache, a schedule
 * task pointing at a doomed id, and content-addressed attachment blobs), then
 * drives `createPurgeService(stubCtx).purge()` directly. No HTTP server is
 * started and the real `~/.dsh` is never opened — `resolveHome()` is asserted to
 * point inside the temp directory before anything runs.
 *
 * Run:  node test/e2e.test.mjs     (exit 0 = all assertions passed)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  allTemps,
  assertIsolated,
  makeChecker,
  makeCtx,
  makeRegistry,
  makeTempHome,
  readJsonAt,
  realHomes,
  seedWorkspace,
  sha256,
  workspaceLedger,
  writeJson
} from './helpers.mjs';

const DOOMED_A = 'session-aaaa1111-2222-3333-4444-555555555555';
const DOOMED_B = 'session-bbbb1111-2222-3333-4444-666666666666';
const SURVIVOR = 'session-cccc1111-2222-3333-4444-777777777777';
const SLUG = '--C-Users-GH0058-Documents-default-workspace--';
const LOG_NAME = 'session.v4.jsonl.zstd';
const SCHEDULE_TASK = 'schedule-e2e-0000-0000-000000000001';

/* Attachment blobs are content-addressed, so the ids are the content hashes. */
const H_ONLY_A = sha256('blob-doomed-a-only');
const H_ONLY_B = sha256('blob-doomed-b-only');
const H_SHARED = sha256('blob-shared-with-survivor');

/* ── isolation first: point $DSH_HOME at a temp dir before importing the libs */
const { home, storages, cleanup } = makeTempHome('sp-e2e-');

const store = await import('../lib/store.js');
const { createPurgeService } = await import('../lib/service.js');

const checker = makeChecker('e2e');
const { check, group } = checker;

/* ── paths inside the fake store ────────────────────────────────────────── */
const SESSIONS = join(home, 'sessions');
const PROJCACHE = join(storages, 'session_projcache', 'sessions');
const POLICIES = join(storages, 'vision_router_session_policy', 'policies');
const ATTACH_V1 = join(home, 'attachments', 'v1');
const REQUEST_IMAGES = join(home, 'cache', 'attachments', 'request-images');
const LEDGER = join(storages, 'workspace.json');
const COST = join(storages, 'cost-meter', 'ledger.json');
const OVERVIEW = join(storages, 'dsh-context', 'overview-cache.v1.json');
const SCHEDULE = join(storages, 'schedule.json');

const sessionDir = (id) => join(SESSIONS, SLUG, id);
const logPath = (id) => join(sessionDir(id), LOG_NAME);

/** One JSONL turn, optionally referencing attachment hashes. */
function logTurn(id, title, hashes) {
  const turn = {
    type: 'turn',
    session: { id },
    title,
    at: '2026-11-19T00:00:00.000Z',
    attachments: (hashes || []).map((hash) => ({ sha256: hash }))
  };
  return `${JSON.stringify(turn)}\n`;
}

function writeLog(id, text) {
  mkdirSync(sessionDir(id), { recursive: true });
  writeFileSync(logPath(id), zstdCompressSync(Buffer.from(text, 'utf8')));
}

function writeProjcache(id, title, lastPromptAt) {
  mkdirSync(PROJCACHE, { recursive: true });
  writeJson(join(PROJCACHE, `${id}.json`), {
    unit: { name: 'session_projcache', version: 1 },
    record: {
      rows: {
        title: { val: title },
        titleInput: { val: { first: { text: `${title} 的第一句话` } } },
        agentPreset: { val: 'default' },
        sessionListMetadata: { val: { blank: false, lastPromptAt } }
      }
    }
  });
}

function writePolicy(id) {
  mkdirSync(POLICIES, { recursive: true });
  writeJson(join(POLICIES, `${id}.json`), { unit: { name: 'vision_router_session_policy', version: 1 }, id });
}

const exists = (target) => existsSync(target);

try {
  /* ── 0. the isolation invariant the whole suite depends on ─────────────── */
  group('0. isolation');
  check('resolveHome() points inside the temp directory',
    store.resolveHome() === home && assertIsolated(store.resolveHome()) === home,
    `resolveHome=${store.resolveHome()} temp=${home}`);
  check('temp home is not the real DSH home',
    !realHomes().includes(home), realHomes().join(', '));

  /* ── 1. build a store that looks like the real one ─────────────────────── */
  group('1. seeding a synthetic store');
  writeLog(DOOMED_A, logTurn(DOOMED_A, '要删除的会话 A', [H_ONLY_A, H_SHARED]) + logTurn(DOOMED_A, '第二回合'));
  writeLog(DOOMED_B, logTurn(DOOMED_B, '要删除的会话 B', [H_ONLY_B]));
  writeLog(SURVIVOR, logTurn(SURVIVOR, '保留的会话', [H_SHARED]));

  writeProjcache(DOOMED_A, '会话 A', 1000);
  writeProjcache(DOOMED_B, '会话 B', 2000);
  writeProjcache(SURVIVOR, '会话 C', 3000);
  writePolicy(DOOMED_A);
  writePolicy(DOOMED_B);
  writePolicy(SURVIVOR);

  const ledger = workspaceLedger([DOOMED_A, SURVIVOR, DOOMED_B], {
    archived: [DOOMED_B],
    pinned: [DOOMED_A]
  });
  writeJson(LEDGER, ledger);

  writeJson(COST, {
    version: 3,
    usageCursors: {
      [`${DOOMED_A}:aa`]: 1,
      [`${DOOMED_B}:bb`]: 2,
      [`${SURVIVOR}:cc`]: 3
    },
    days: {
      '2026-11-19': {
        sessions: [{ id: DOOMED_A }, { id: DOOMED_B }, { id: SURVIVOR }],
        totalTokens: 999
      }
    }
  });

  writeJson(OVERVIEW, {
    version: 1,
    sessions: [
      { session: { id: DOOMED_A }, tokens: 10 },
      { session: { id: DOOMED_B }, tokens: 20 },
      { session: { id: SURVIVOR }, tokens: 30 }
    ]
  });

  writeJson(SCHEDULE, {
    unit: { name: 'schedule', version: 1 },
    tables: {
      tasks: {
        [SCHEDULE_TASK]: {
          record: { id: SCHEDULE_TASK, title: '每日清理提醒' },
          target: { kind: 'session', sessionId: DOOMED_A },
          involvedSessionIds: [DOOMED_A, SURVIVOR],
          status: 'active',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }
  });

  mkdirSync(ATTACH_V1, { recursive: true });
  mkdirSync(REQUEST_IMAGES, { recursive: true });
  writeFileSync(join(ATTACH_V1, H_ONLY_A), 'blob-doomed-a-only');
  writeFileSync(join(ATTACH_V1, H_SHARED), 'blob-shared-with-survivor');
  writeFileSync(join(REQUEST_IMAGES, H_ONLY_B), 'blob-doomed-b-only');

  const registry = makeRegistry(ledger);
  const ctx = makeCtx({ workspaceRegistry: registry });
  const service = createPurgeService(ctx);

  check('all seeded session directories exist',
    exists(logPath(DOOMED_A)) && exists(logPath(DOOMED_B)) && exists(logPath(SURVIVOR)));

  /* ── 2. list() mirrors the registry before anything is deleted ─────────── */
  group('2. list() before the purge');
  const before = await service.list();
  check('lists all three sessions', before.sessions.length === 3, String(before.sessions.length));
  check('titles come from the projection cache',
    before.sessions.some((row) => row.title === '会话 A') &&
      before.sessions.some((row) => row.title === '会话 C'),
    before.sessions.map((row) => row.title).join(','));
  check('totals are non-zero', before.totalBytes > 0, String(before.totalBytes));
  const rowA = before.sessions.find((row) => row.id === DOOMED_A);
  check('a doomed row is deletable and not live',
    Boolean(rowA) && rowA.deletable === true && rowA.live === false, JSON.stringify(rowA));

  /* ── 3. guards: live and current sessions are refused, nothing deleted ─── */
  group('3. pre-flight guards');
  {
    const liveCtx = makeCtx({
      workspaceRegistry: makeRegistry(ledger),
      sessions: { get: (id) => (id === DOOMED_A ? { id: DOOMED_A } : undefined) }
    });
    const liveService = createPurgeService(liveCtx);
    let code = '';
    try {
      await liveService.purge([DOOMED_A]);
    } catch (error) {
      code = String(error.code || '');
    }
    check('a live session is refused', code === 'live', code);
    check('the refusal deleted nothing', exists(logPath(DOOMED_A)) && exists(logPath(DOOMED_B)));
  }
  {
    const currentCtx = makeCtx({
      workspaceRegistry: makeRegistry(ledger),
      currentSession: { id: DOOMED_B }
    });
    const currentService = createPurgeService(currentCtx);
    let code = '';
    try {
      await currentService.purge([DOOMED_B]);
    } catch (error) {
      code = String(error.code || '');
    }
    check('the current conversation is refused', code === 'current', code);
    check('that refusal deleted nothing', exists(logPath(DOOMED_B)));
  }

  /* ── 4. dryRun previews without touching the disk ──────────────────────── */
  group('4. dryRun');
  const dry = await service.purge([DOOMED_A, DOOMED_B], { dryRun: true });
  check('dryRun reports a plan and flags itself',
    dry.ok === true && dry.dryRun === true && dry.plan.length === 2, JSON.stringify(dry.plan));
  check('dryRun deleted nothing',
    exists(logPath(DOOMED_A)) && exists(logPath(DOOMED_B)) &&
      exists(join(PROJCACHE, `${DOOMED_A}.json`)));
  check('dryRun reported the log bytes',
    dry.plan.every((item) => item.bytes > 0), JSON.stringify(dry.plan.map((item) => item.bytes)));

  /* ── 5. the real purge ─────────────────────────────────────────────────── */
  group('5. purge()');
  const result = await service.purge([DOOMED_A, DOOMED_B]);
  check('reports success', result.ok === true, JSON.stringify(result.failed));
  check('both ids deleted',
    result.deleted.length === 2 && result.deleted.includes(DOOMED_A) && result.deleted.includes(DOOMED_B),
    JSON.stringify(result.deleted));
  check('no failures', result.failed.length === 0, JSON.stringify(result.failed));
  check('byte count is non-zero', result.bytes > 0, String(result.bytes));

  /* ── 6. the residual probe must find nothing ───────────────────────────── */
  group('6. residual probes (all must be empty/false)');
  check('service reports zero remaining', result.remaining.length === 0, JSON.stringify(result.remaining));
  check('session directories gone', !exists(sessionDir(DOOMED_A)) && !exists(sessionDir(DOOMED_B)));
  check('projection caches gone',
    !exists(join(PROJCACHE, `${DOOMED_A}.json`)) && !exists(join(PROJCACHE, `${DOOMED_B}.json`)));
  check('policy records gone',
    !exists(join(POLICIES, `${DOOMED_A}.json`)) && !exists(join(POLICIES, `${DOOMED_B}.json`)));

  const ledgerAfter = readJsonAt(LEDGER);
  const members = ledgerAfter.tables.workspaces['ws-1'].sessionIds;
  check('workspace membership cleaned', JSON.stringify(members) === JSON.stringify([SURVIVOR]),
    JSON.stringify(members));
  check('archive flags cleaned', ledgerAfter.global.archivedSessionIds.length === 0,
    JSON.stringify(ledgerAfter.global.archivedSessionIds));
  check('pin flags cleaned', ledgerAfter.global.pinnedSessionIds.length === 0,
    JSON.stringify(ledgerAfter.global.pinnedSessionIds));

  const costAfter = readJsonAt(COST);
  check('cost cursors cleaned',
    !(`${DOOMED_A}:aa` in costAfter.usageCursors) && !(`${DOOMED_B}:bb` in costAfter.usageCursors),
    JSON.stringify(costAfter.usageCursors));
  check('cost day rows cleaned',
    JSON.stringify(costAfter.days['2026-11-19'].sessions.map((row) => row.id)) === JSON.stringify([SURVIVOR]),
    JSON.stringify(costAfter.days['2026-11-19'].sessions));
  check('day totals preserved',
    costAfter.days['2026-11-19'].totalTokens === 999, String(costAfter.days['2026-11-19'].totalTokens));

  const overviewAfter = readJsonAt(OVERVIEW);
  check('overview cache cleaned',
    JSON.stringify(overviewAfter.sessions.map((entry) => entry.session.id)) === JSON.stringify([SURVIVOR]),
    JSON.stringify(overviewAfter.sessions.map((entry) => entry.session.id)));

  const scheduleRaw = readFileSync(SCHEDULE, 'utf8');
  const scheduleAfter = JSON.parse(scheduleRaw);
  const taskAfter = scheduleAfter.tables.tasks[SCHEDULE_TASK];
  check('scheduled task kept', Boolean(taskAfter), JSON.stringify(Object.keys(scheduleAfter.tables.tasks)));
  check('scheduled task re-pointed off the deleted session',
    taskAfter.target.kind === 'new_once' &&
      taskAfter.target.sessionId === `session-schedule-${sha256(SCHEDULE_TASK)}`,
    JSON.stringify(taskAfter.target));
  check('no deleted id left anywhere in schedule.json',
    !scheduleRaw.includes(DOOMED_A) && !scheduleRaw.includes(DOOMED_B), 'schedule.json still names a deleted id');
  check('the UI was told which tasks changed',
    result.schedules.targets.length === 1 && result.schedules.targets[0].title === '每日清理提醒',
    JSON.stringify(result.schedules));

  /* ── 7. attachments: orphan-only sweep ─────────────────────────────────── */
  group('7. content-addressed attachment sweep');
  check('blob referenced only by a deleted session is removed',
    !exists(join(ATTACH_V1, H_ONLY_A)));
  check('request-image blob of a deleted session is removed',
    !exists(join(REQUEST_IMAGES, H_ONLY_B)));
  check('blob shared with a surviving session is kept',
    exists(join(ATTACH_V1, H_SHARED)));
  check('the sweep reported what it removed',
    result.attachments.removed === 2 && result.attachments.bytes > 0,
    JSON.stringify(result.attachments));

  /* ── 8. the survivor is untouched ──────────────────────────────────────── */
  group('8. the surviving session is intact');
  check('survivor log still readable',
    exists(logPath(SURVIVOR)) &&
      (await store.readLogText(logPath(SURVIVOR))).includes('保留的会话'),
    'log missing or unreadable');
  check('survivor projection cache and policy intact',
    exists(join(PROJCACHE, `${SURVIVOR}.json`)) && exists(join(POLICIES, `${SURVIVOR}.json`)));
  check('survivor cost row and cursor intact',
    costAfter.days['2026-11-19'].sessions.some((row) => row.id === SURVIVOR) &&
      `${SURVIVOR}:cc` in costAfter.usageCursors);
  check('survivor overview entry intact',
    overviewAfter.sessions.length === 1 && overviewAfter.sessions[0].session.id === SURVIVOR);

  /* ── 9. post-purge view + no temp litter ───────────────────────────────── */
  group('9. after the purge');
  const after = await service.list();
  check('the list no longer offers the deleted sessions',
    after.sessions.length === 1 && after.sessions[0].id === SURVIVOR,
    after.sessions.map((row) => row.id).join(','));
  check('the list still resolves the survivor title',
    after.sessions[0] && after.sessions[0].title === '会话 C', String(after.sessions[0] && after.sessions[0].title));
  check('no .tmp litter anywhere in the store', allTemps(home).length === 0, allTemps(home).join(','));

  /* ── 10. purging something that is already gone is reported, not crashed ─ */
  group('10. re-purging a missing session');
  const again = await service.purge([DOOMED_A]);
  check('a vanished id is reported clean without warnings',
    again.ok === true && again.failed.length === 0, JSON.stringify(again.failed));
  check('nothing new is reported as remaining', again.remaining.length === 0, JSON.stringify(again.remaining));
  check('the real DSH home was never touched',
    store.resolveHome() === home && !realHomes().includes(home), store.resolveHome());
} catch (error) {
  console.error('\n测试执行中抛出异常：');
  console.error(error && error.stack ? error.stack : error);
  check('no unexpected exception', false, String(error && error.message ? error.message : error));
} finally {
  const ok = checker.finish();
  cleanup();
  console.log(`${checker.passed} passed, ${checker.failed} failed`);
  process.exit(ok ? 0 : 1);
}
