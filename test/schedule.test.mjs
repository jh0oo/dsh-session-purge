/**
 * test/schedule.test.mjs — regression suite for `editScheduleRefs`.
 *
 * A Schedule task that targeted a deleted Session must lose every trace of that
 * id while staying a valid, armed task. Migrated from `_scratch/schedtest.mjs`;
 * 21 assertions covering the rewrite, the `kind:'new'` branch, the untouched
 * neighbours, and idempotency (a second run must be a byte-level no-op).
 *
 * Run:  node test/schedule.test.mjs     (exit 0 = all assertions passed)
 * Runs against a throwaway $DSH_HOME, never the live store.
 */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bareId,
  makeChecker,
  makeTempHome,
  reservedScheduleId,
  writeJson
} from './helpers.mjs';

const DOOMED = 'session-5cde2538-5999-4f36-8810-e1514eb953d4';
const SURVIVOR = 'session-11111111-2222-3333-4444-555555555555';
const TASK_TARGETED = 'schedule-d535059b-afbb-4a29-91ae-a3ddaa979432';
const TASK_NEW = 'schedule-newmode-0000-0000-000000000000';
const TASK_CLEAN = 'schedule-clean-0000-0000-000000000000';
const ORIGINAL_UPDATED_AT = '2026-01-01T00:00:00.000Z';

/* ── isolation first: point $DSH_HOME at a temp dir before importing the store */
const { home, storages, cleanup } = makeTempHome('sp-sched-');
const FILE = join(storages, 'schedule.json');

const store = await import('../lib/store.js');

const checker = makeChecker('schedule');
const { check, group } = checker;

/** The schedule store snapshot as the Host writes it. */
function seed() {
  return {
    unit: { name: 'schedule', version: 1 },
    tables: {
      tasks: {
        [TASK_TARGETED]: {
          record: { id: TASK_TARGETED, title: '清理测试任务' },
          target: { kind: 'session', sessionId: DOOMED },
          involvedSessionIds: [DOOMED, SURVIVOR],
          status: 'ended',
          updatedAt: ORIGINAL_UPDATED_AT,
          pendingDelivery: { targetSessionId: DOOMED },
          lastDelivery: { at: 1, targetSessionId: DOOMED, ok: true },
          deliveryHistory: {
            records: [
              { at: 1, targetSessionId: DOOMED },
              { at: 2, targetSessionId: SURVIVOR }
            ]
          }
        },
        [TASK_NEW]: {
          record: { id: TASK_NEW, title: '每次新建' },
          target: { kind: 'new', create: { cwd: 'C:\\x' } },
          involvedSessionIds: [DOOMED],
          status: 'active'
        },
        [TASK_CLEAN]: {
          record: { id: TASK_CLEAN, title: '无关任务' },
          target: { kind: 'session', sessionId: SURVIVOR },
          involvedSessionIds: [SURVIVOR],
          status: 'active'
        }
      }
    }
  };
}

try {
  writeJson(FILE, seed());

  group('1. rewriting a task that targeted the deleted session');
  const result = await store.editScheduleRefs(home, [DOOMED]);
  const raw = readFileSync(FILE, 'utf8');
  const after = JSON.parse(raw);
  const tasks = after.tables.tasks;

  check('reports the targeted task',
    result.targets.length === 1 && result.targets[0].taskId === TASK_TARGETED,
    JSON.stringify(result.targets));
  check('reports a title', Boolean(result.targets[0]) && result.targets[0].title === '清理测试任务');
  check('keeps every task', Object.keys(tasks).length === 3, Object.keys(tasks).join(','));

  const targeted = tasks[TASK_TARGETED];
  check('target re-pointed to new_once', targeted.target.kind === 'new_once', JSON.stringify(targeted.target));
  check('target sessionId is the reserved id',
    targeted.target.sessionId === reservedScheduleId(TASK_TARGETED), targeted.target.sessionId);
  check('target keeps create object',
    Boolean(targeted.target.create) && typeof targeted.target.create === 'object');
  check('involvedSessionIds drops the deleted id',
    JSON.stringify(targeted.involvedSessionIds) === JSON.stringify([SURVIVOR]),
    JSON.stringify(targeted.involvedSessionIds));
  check('pendingDelivery rewritten',
    targeted.pendingDelivery.targetSessionId === reservedScheduleId(TASK_TARGETED),
    JSON.stringify(targeted.pendingDelivery));
  check('lastDelivery rewritten',
    targeted.lastDelivery.targetSessionId === reservedScheduleId(TASK_TARGETED),
    JSON.stringify(targeted.lastDelivery));
  check('lastDelivery keeps its other fields', targeted.lastDelivery.at === 1 && targeted.lastDelivery.ok === true,
    JSON.stringify(targeted.lastDelivery));
  check('deliveryHistory rewritten',
    targeted.deliveryHistory.records[0].targetSessionId === reservedScheduleId(TASK_TARGETED),
    JSON.stringify(targeted.deliveryHistory.records[0]));
  check('deliveryHistory survivor untouched',
    targeted.deliveryHistory.records[1].targetSessionId === SURVIVOR,
    JSON.stringify(targeted.deliveryHistory.records[1]));
  check('updatedAt refreshed', targeted.updatedAt !== ORIGINAL_UPDATED_AT, targeted.updatedAt);

  group('2. the kind:new branch and unrelated tasks');
  const newMode = tasks[TASK_NEW];
  check('kind:new target stays kind:new', newMode.target.kind === 'new', JSON.stringify(newMode.target));
  check('kind:new drops sessionId', newMode.target.sessionId === undefined, JSON.stringify(newMode.target));
  check('kind:new keeps create', Boolean(newMode.target.create) && newMode.target.create.cwd === 'C:\\x',
    JSON.stringify(newMode.target));
  check('kind:new involved list emptied',
    Array.isArray(newMode.involvedSessionIds) && newMode.involvedSessionIds.length === 0,
    JSON.stringify(newMode.involvedSessionIds));

  check('unrelated task untouched',
    JSON.stringify(tasks[TASK_CLEAN]) === JSON.stringify(seed().tables.tasks[TASK_CLEAN]),
    JSON.stringify(tasks[TASK_CLEAN]));
  check('no deleted id anywhere in the file',
    !raw.includes(DOOMED) && !raw.includes(bareId(DOOMED)), 'file still contains the id');

  group('3. idempotency');
  const again = await store.editScheduleRefs(home, [DOOMED]);
  check('second run is a no-op', again.touched === false && again.stripped === 0, JSON.stringify(again));
  const rawAgain = readFileSync(FILE, 'utf8');
  check('file byte-identical after no-op', rawAgain === raw,
    `length ${rawAgain.length} vs ${raw.length}`);
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
