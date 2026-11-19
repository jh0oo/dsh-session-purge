/**
 * test/guard.test.mjs — the "never orphan the ledger" guard.
 *
 * CONTEXT (why this file exists)
 * -----------------------------
 * DSH validates every workspace-ledger member at boot:
 *
 *   WorkspaceRegistry.init → indexLiveSessions → attachSession
 *     → readSessionHeader(id) → throw "cannot validate session '<id>':
 *       session persistence holds no such session"
 *
 * Thrown there = `dsh: fatal load failure`; the app will not start. On this
 * machine that happened twice, both times because a ledger row outlived its log.
 *
 * `detachFromRegistry()` is a best-effort API dance that deliberately swallows
 * errors — if the registry refuses, it returns quietly and the caller would move
 * the bytes anyway, manufacturing exactly that boot-killer.
 *
 * The guard (`stillRegistered` + `forceDetach`) closes the hole: bytes do not
 * move while any ledger still names the session, and the operation fails loudly
 * instead. These tests pin that behaviour, and pin that a *successful* detach
 * still lets the delete through (no over-blocking).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bareId, makeChecker, makeCtx, makeRegistry, makeTempHome, readJsonAt, workspaceLedger } from './helpers.mjs';
import { createPurgeService } from '../lib/service.js';

const { home, storages, cleanup } = makeTempHome('sp-guard-');
const checker = makeChecker('guard');
const { check, group } = checker;

const SLUG = '--guard-slug--';
const SESSIONS = join(home, 'sessions', SLUG);
const PROCACHE = join(home, 'storages', 'session_projcache', 'sessions');
const POLICIES = join(home, 'storages', 'vision_router_session_policy', 'policies');
const LEDGER = join(storages, 'workspace.json');

/** A synthetic session on disk, with the log file the boot validator looks for. */
function seedSession(name) {
  const id = `session-${name}`;
  const dir = join(SESSIONS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), `${JSON.stringify({ type: 'session', version: 4, id: name })}\n`, 'utf8');
  mkdirSync(PROCACHE, { recursive: true });
  writeFileSync(join(PROCACHE, `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { val: name } } } }), 'utf8');
  mkdirSync(POLICIES, { recursive: true });
  writeFileSync(join(POLICIES, `${name}.json`), JSON.stringify({ mode: 'auto' }), 'utf8');
  return { id, bare: name, dir, log: join(dir, 'session.v4.jsonl.zstd') };
}

const logStillThere = (entry) => existsSync(entry.log);

/**
 * A registry whose `detachSession` silently does nothing — the in-memory entity
 * keeps naming the session, which is what would let the host re-persist a
 * dangling row after the log is gone.
 */
function makeStubbornRegistry(ledger) {
  const registry = makeRegistry(ledger);
  for (const entity of registry.entities) {
    entity.detachSession = function detachSession() {
      /* refuses: entity.sessionIds unchanged */
    };
  }
  return registry;
}

/* ── 1. a registry that refuses to detach must block the delete ───────────── */

group('1. stubborn registry: bytes stay put');

const stuck = seedSession('guardstuck');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([stuck.id]), null, 2)}\n`, 'utf8');

const stubbornService = createPurgeService(makeCtx({ workspaceRegistry: makeStubbornRegistry(readJsonAt(LEDGER)) }));
const stuckOutcome = await stubbornService.trash([stuck.id]);
const stuckRow = stuckOutcome.results.find((row) => row.id === stuck.id);

/* `trash()` reports per-session failures in `results` instead of throwing, so a
   single bad row cannot abort the rest of the batch. What matters here is that
   the row is reported failed AND its bytes never left the live store. */
check('trash reports the session as failed', Boolean(stuckRow && stuckRow.ok === false), stuckRow && stuckRow.warnings.join(' | '));
check('the reason names the ledger, not a random error', Boolean(stuckRow && stuckRow.warnings.some((line) => line.includes('登记表'))), stuckRow && stuckRow.warnings.join(' | '));
check('the log was NOT moved away', logStillThere(stuck), 'log still on disk');
check('nothing was parked in the bin', readdirCount(join(storages, 'dsh-session-purge', 'trash')) === 0, 'bin empty');
/* `forceDetach` repairs the on-disk ledger even when the API dance fails, so the
   next boot is safe regardless; the move is still refused because the host's
   in-memory entity could re-persist the row. */
check('the on-disk ledger was repaired anyway', !readJsonAt(LEDGER).tables.workspaces['ws-1'].sessionIds.includes(stuck.id));

/* ── 2. a normal registry: the guard must not block a healthy delete ──────── */

group('2. cooperative registry: delete proceeds');

const healthy = seedSession('guardok');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([healthy.id]), null, 2)}\n`, 'utf8');

const goodService = createPurgeService(makeCtx({ workspaceRegistry: makeRegistry(readJsonAt(LEDGER)) }));
const outcome = await goodService.trash([healthy.id]);

check('trash succeeds', outcome.ok === true, JSON.stringify(outcome.trashed));
check('the session left the live store', !logStillThere(healthy), 'log gone');
check('the ledger no longer names it', !readJsonAt(LEDGER).tables.workspaces['ws-1'].sessionIds.includes(healthy.id));
check('it is restorable from the bin', (await goodService.trashList()).entries.some((entry) => entry.id === healthy.id));

/* ── 3. purging a session the ledger names but disk never had ────────────── */

group('3. purge honours the same guard');

const named = seedSession('guardpurge');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([named.id]), null, 2)}\n`, 'utf8');

const purgeService = createPurgeService(makeCtx({ workspaceRegistry: makeStubbornRegistry(readJsonAt(LEDGER)) }));
const purged = await purgeService.purge([named.id]);
const purgedRow = purged.results.find((row) => row.id === named.id);

check('purge reports the session as failed', purgedRow && purgedRow.ok === false, purgedRow && purgedRow.warnings.join(' | '));
check('purge did not delete the log', logStillThere(named), 'log still on disk');
/* purge's ledger pass runs after the loop, so the row is stripped even when the
   session itself was refused — the app must boot, and a row without a log is the
   fatal shape. The log surviving is what keeps this recoverable. */
check('purge left no dangling ledger row', !readJsonAt(LEDGER).tables.workspaces['ws-1'].sessionIds.includes(named.id));

/* ── 4. the missing-log case the boot validator actually chokes on ────────── */

group('4. dangling ledger row is detectable');

const ghost = seedSession('guardghost');
writeFileSync(LEDGER, `${JSON.stringify(workspaceLedger([ghost.id]), null, 2)}\n`, 'utf8');
rmSyncSafe(ghost.dir);

const dangling = readJsonAt(LEDGER).tables.workspaces['ws-1'].sessionIds.filter((id) => id === ghost.id && !existsSync(join(SESSIONS, id)));
check('the row now points at nothing (the fatal shape)', dangling.length === 1, `${dangling.length} dangling`);

const salvage = createPurgeService(makeCtx({ workspaceRegistry: makeRegistry(readJsonAt(LEDGER)) }));
const already = await salvage.purge([ghost.id]);
check('purging a ghost still clears the ledger row', !readJsonAt(LEDGER).tables.workspaces['ws-1'].sessionIds.includes(ghost.id));
check('purging a ghost does not throw', already !== null);

/* ── 5. bareId round-trip the guard relies on ─────────────────────────────── */

group('5. id spelling');

check('bareId strips only the session- prefix', bareId('session-abc') === 'abc', bareId('session-abc'));
check('bareId leaves other families alone', bareId('mnemon-run-v1-abc') === 'mnemon-run-v1-abc', bareId('mnemon-run-v1-abc'));

/* ── finish ──────────────────────────────────────────────────────────────── */

const ok = checker.finish();
cleanup();
process.exit(ok ? 0 : 1);

/* ── tiny fs helpers kept local so the file reads top-down ───────────────── */

function readdirCount(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function rmSyncSafe(target) {
  rmSync(target, { recursive: true, force: true });
}
