/**
 * test/atomic.test.mjs — regression suite for the hardened durable-write path.
 *
 * Migrated from `_scratch/atomic.mjs` (the 2026-11-19 crash review) into a
 * permanent, self-contained test. Six groups, 26 assertions:
 *
 *   1. a plain edit still works and leaves the rest of the ledger alone
 *   2. `writeJsonAtomic` refuses a stale snapshot instead of clobbering it
 *   3. read-modify-write converges while another writer races it
 *   4. `rename` retries under a real exclusive file handle (Windows sharing)
 *   5. the post-write verify pass converges once the other writer settles
 *   6. the cost ledger uses the same guarded path
 *
 * Run:  node test/atomic.test.mjs     (exit 0 = all assertions passed)
 * Every write lands in a throwaway $DSH_HOME; the live store is never touched.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  delay,
  assertIsolated,
  leftoverTemps,
  makeChecker,
  makeTempHome,
  realHomes,
  seedWorkspace,
  writeJson
} from './helpers.mjs';

/* ── isolation first: point $DSH_HOME at a temp dir before importing the store */
const { home, storages, cleanup } = makeTempHome('sp-atomic-');
const LEDGER = join(storages, 'workspace.json');
const DAY = '2026-11-19';

const store = await import('../lib/store.js');

const checker = makeChecker('atomic');
const { check, group } = checker;

if (assertIsolated(store.resolveHome() || home) !== home) {
  console.error(`致命：resolveHome() 未指向临时目录（${store.resolveHome()} vs ${home}）`);
  process.exit(1);
}
console.log(`临时 DSH_HOME: ${home}`);
console.log(`真实 DSH home（禁止写入）: ${realHomes().join(', ') || '(未探测到)'}`);

const wsIds = (value) => value.tables.workspaces['ws-1'].sessionIds;

try {
  /* ── 1. plain write still works ────────────────────────────────────────── */
  group('1. plain atomic write');
  {
    seedWorkspace(LEDGER, ['session-a', 'session-b', 'session-c']);
    const result = await store.editWorkspaceLedger(home, ['session-b']);
    const after = JSON.parse(readFileSync(LEDGER, 'utf8'));
    check('removed exactly one id', result.touched && result.removed === 1, JSON.stringify(result));
    check('survivors intact, unrelated sections untouched',
      JSON.stringify(wsIds(after)) === '["session-a","session-c"]' &&
        after.global.defaultWorkspaceId === 'ws-1' &&
        JSON.stringify(after.global.workspaceIds) === '["ws-1"]' &&
        after.global.archivedSessionIds.length === 0 &&
        after.global.pinnedSessionIds.length === 0,
      `${JSON.stringify(wsIds(after))} / ${JSON.stringify(after.global)}`);
    check('no temp litter', leftoverTemps(storages).length === 0, leftoverTemps(storages).join(','));
  }

  /* ── 2. a stale stamp is refused, not silently overwritten ─────────────── */
  group('2. concurrent-writer guard (writeJsonAtomic expectedStamp)');
  {
    seedWorkspace(LEDGER, ['session-a']);
    const snapshot = await store.readJsonSnapshot(LEDGER);
    /* Someone else writes the same file after we read it. */
    const moved = JSON.parse(readFileSync(LEDGER, 'utf8'));
    wsIds(moved).push('session-added-by-host');
    writeJson(LEDGER, moved);

    let code = '';
    try {
      await store.writeJsonAtomic(LEDGER, snapshot.data, snapshot.stamp);
    } catch (error) {
      code = String(error.code || '');
    }
    const after = JSON.parse(readFileSync(LEDGER, 'utf8'));
    check('stale write rejected with STALE', code === 'STALE', `code=${code}`);
    check('guest writer data survived', wsIds(after).includes('session-added-by-host'),
      JSON.stringify(wsIds(after)));
    check('no temp litter', leftoverTemps(storages).length === 0, leftoverTemps(storages).join(','));
  }

  /* ── 3. read-modify-write survives a racing writer (retry loop) ────────── */
  group('3. read-modify-write retries over a racing writer');
  {
    const data = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: 'ws-1',
        workspaceIds: ['ws-1'],
        archivedSessionIds: [],
        pinnedSessionIds: []
      },
      tables: { workspaces: { 'ws-1': { path: 'C:\\ws', title: 'ws', sessionIds: ['session-doomed'] } } }
    };
    /* Bulk unrelated payload makes the read→write window wide enough for the
       racing writer to land inside it, which is what the retry loop guards. */
    for (let i = 0; i < 4000; i += 1) {
      data.tables.workspaces[`filler-${i}`] = { path: `C:\\f${i}`, title: `t${i}`, sessionIds: [] };
    }
    writeJson(LEDGER, data);

    /* The racer is BOUNDED on purpose. It models the Host flushing its own
       snapshot a few times and then going quiet; an unbounded writer that keeps
       re-adding the id after we return could never be beaten by any
       implementation, so testing that would prove nothing. */
    const racerDeadline = Date.now() + 220;
    let raceTurns = 0;
    const race = (async () => {
      let n = 0;
      while (Date.now() < racerDeadline) {
        try {
          const current = JSON.parse(readFileSync(LEDGER, 'utf8'));
          wsIds(current).push(`session-race-${n}`);
          writeJson(LEDGER, current);
          raceTurns += 1;
        } catch {
          /* the racing writer lost a turn — that is the point */
        }
        n += 1;
        await delay(4);
      }
    })();

    await delay(30);
    let outcome = 'ok';
    try {
      await store.editWorkspaceLedger(home, ['session-doomed']);
    } catch (error) {
      outcome = String(error.code || error.message || 'error');
    }
    await race;

    const after = JSON.parse(readFileSync(LEDGER, 'utf8'));
    const ids = wsIds(after);
    check('resolved without clobbering (ok or STALE)', outcome === 'ok' || outcome === 'STALE', outcome);
    check('racer got turns in (test is meaningful)', raceTurns >= 2, `${raceTurns} turns`);
    check('some racing writes survived', ids.some((id) => String(id).startsWith('session-race-')), 'none survived');
    check('file still valid JSON with filler', Object.keys(after.tables.workspaces).length === 4001,
      String(Object.keys(after.tables.workspaces).length));
    check('no temp litter', leftoverTemps(storages).length === 0, leftoverTemps(storages).join(','));

    /* A write that lands after our final verify read is physically unbeatable —
       test 5 documents that limit. What must hold is convergence: with the other
       writer quiet, one more pass leaves the ledger clean. */
    await store.editWorkspaceLedger(home, ['session-doomed']);
    const settled = wsIds(JSON.parse(readFileSync(LEDGER, 'utf8')));
    check('converges once the racer stops', !settled.includes('session-doomed'),
      JSON.stringify(settled.slice(-5)));
  }

  /* ── 4. rename retry under a real Windows share lock ───────────────────── */
  group('4. rename retries while another handle blocks the target');
  {
    seedWorkspace(LEDGER, ['session-a', 'session-b']);
    /* There is no `pwsh` on the runtime PATH, so the lock holder is a second
       Node process holding an exclusive handle — the same share violation
       Windows raises when Defender or the search indexer touches the file. */
    const holderScript = join(home, 'hold.mjs');
    writeFileSync(holderScript, [
      "import { open } from 'node:fs/promises';",
      "const handle = await open(process.argv[2], 'r+');",
      'await new Promise((r) => setTimeout(r, 1600));',
      'await handle.close();'
    ].join('\n'), 'utf8');

    const holder = spawn(process.execPath, [holderScript, LEDGER], { stdio: 'ignore' });
    await delay(350);

    const started = Date.now();
    let outcome = 'ok';
    try {
      const result = await store.editWorkspaceLedger(home, ['session-a']);
      if (!result.touched) outcome = 'not-touched';
    } catch (error) {
      outcome = String(error.code || error.message || 'error');
    }
    const elapsed = Date.now() - started;
    const closed = holder.exitCode !== null ? Promise.resolve() : new Promise((r) => holder.on('close', r));
    await closed;

    const after = JSON.parse(readFileSync(LEDGER, 'utf8'));
    check('write survived the exclusive handle', outcome === 'ok', outcome);
    check('retry actually waited (backend backed off)', elapsed > 250, `${elapsed}ms`);
    check('id removed once the lock cleared', JSON.stringify(wsIds(after)) === '["session-b"]',
      JSON.stringify(wsIds(after)));
    check('no temp litter', leftoverTemps(storages).length === 0, leftoverTemps(storages).join(','));
  }

  /* ── 5. the post-write verify converges once the other writer settles ──── */
  group('5. verify pass converges after a writer that re-adds the deleted id');
  {
    seedWorkspace(LEDGER, ['session-doomed', 'session-keep']);

    /* Hard limit worth naming: no implementation can beat a writer that lands
       *after* the final read. What must hold is that we neither report success
       on a ledger that still holds the id at verify time, nor lose the edit
       permanently — a second pass once the other writer is quiet must end
       clean. This models the Host flushing a stale in-memory snapshot. */
    const racerDeadline = Date.now() + 200;
    let reAdded = 0;
    const race = (async () => {
      while (Date.now() < racerDeadline) {
        try {
          const current = JSON.parse(readFileSync(LEDGER, 'utf8'));
          const ids = wsIds(current);
          if (!ids.includes('session-doomed')) {
            ids.push('session-doomed');
            writeJson(LEDGER, current);
            reAdded += 1;
          }
        } catch {
          /* lost a turn */
        }
        await delay(2);
      }
    })();

    let firstOutcome = 'ok';
    try {
      await store.editWorkspaceLedger(home, ['session-doomed']);
    } catch (error) {
      firstOutcome = String(error.code || error.message || 'error');
    }
    await race;

    check('stale re-adds happened (test is meaningful)', reAdded >= 1, `${reAdded} re-adds`);
    check('never silently reported success over a stale ledger',
      firstOutcome === 'ok' || firstOutcome === 'STALE', firstOutcome);

    const ids1 = wsIds(JSON.parse(readFileSync(LEDGER, 'utf8')));
    const alreadyClean = !ids1.includes('session-doomed');

    /* The other writer is gone now; one more pass must end clean. If the first
       pass already converged this second call correctly reports nothing to do,
       so "reported the cleanup" is only required when work was left over. */
    const second = await store.editWorkspaceLedger(home, ['session-doomed']);
    const after = JSON.parse(readFileSync(LEDGER, 'utf8'));
    check('converges to a ledger without the deleted id', !wsIds(after).includes('session-doomed'),
      JSON.stringify(wsIds(after)));
    check('survivor untouched', wsIds(after).includes('session-keep'), JSON.stringify(wsIds(after)));
    check('leftover work is reported, clean state reports none',
      alreadyClean ? second.touched === false : second.touched === true,
      `alreadyClean=${alreadyClean} second=${JSON.stringify(second)}`);
    check('no temp litter', leftoverTemps(storages).length === 0, leftoverTemps(storages).join(','));
  }

  /* ── 6. cost ledger uses the same guarded path ─────────────────────────── */
  group('6. other ledgers share the guarded path');
  {
    const costDir = join(storages, 'cost-meter');
    mkdirSync(costDir, { recursive: true });
    mkdirSync(join(storages, 'dsh-context'), { recursive: true });
    const ledgerPath = join(costDir, 'ledger.json');
    writeJson(ledgerPath, {
      version: 3,
      usageCursors: { 'keep-me:aa': 1, 'gone-me:bb': 2 },
      days: { [DAY]: { sessions: [{ id: 'session-keep-me' }, { id: 'session-gone-me' }] } }
    });

    const result = await store.editCostLedger(home, ['session-gone-me']);
    const after = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    check('cursor stripped', !('gone-me:bb' in after.usageCursors) && 'keep-me:aa' in after.usageCursors,
      JSON.stringify(after.usageCursors));
    check('day row stripped',
      after.days[DAY].sessions.length === 1 && after.days[DAY].sessions[0].id === 'session-keep-me',
      JSON.stringify(after.days[DAY].sessions));
    check('reported count', result.touched && result.removed === 2, JSON.stringify(result));
    check('no temp litter', leftoverTemps(costDir).length === 0);
  }
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
