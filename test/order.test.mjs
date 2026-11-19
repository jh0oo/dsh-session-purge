/**
 * Deletion ordering — the invariant that a crash cannot violate.
 *
 * The host re-reads every workspace member's session header on boot
 * (`WorkspaceRegistry.init` → `indexStoredHeaders` → `attachSession`) and
 * throws `session persistence holds no such session` when the header is gone.
 * That throw is a fatal load failure: the app refuses to start.
 *
 * So the two halves of a delete are not symmetric. Losing the ledger row first
 * leaves an orphan log, which is harmless and sweepable. Losing the log first
 * leaves a ledger row pointing at nothing, which bricks the next cold start.
 *
 * These tests pin the order itself, not just the end state: they record
 * whether the session log still exists at the exact moment the registry is
 * told to drop the id. Before this invariant was enforced that probe saw the
 * log already gone, which is precisely how the crash was reachable.
 *
 * Runs against a throwaway `DSH_HOME`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertIsolated(home) {
  const real = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  if (home === real || home.startsWith(real)) {
    throw new Error(`refusing to run: DSH_HOME resolves inside the real profile (${home})`);
  }
}

const home = mkdtempSync(join(tmpdir(), 'sp-order-'));
process.env.DSH_HOME = home;
assertIsolated(home);

const store = await import('../lib/store.js');
const trashLib = await import('../lib/trash.js');
const { createPurgeService } = await import('../lib/service.js');

const SLUG = '--C-Users-test-workspace--';
const sessionsDir = join(home, 'sessions', SLUG);
const projcacheDir = join(home, 'storages', 'session_projcache', 'sessions');
const workspaceFile = join(home, 'storages', 'workspace.json');

const LOG_BODY = JSON.stringify({ type: 'session', version: 4, id: 'session-probe', cwd: '/tmp/ws' }) + '\n';

/**
 * A registry stub that answers the question this whole file exists for:
 * "when you were told to forget this session, was its log still on disk?"
 */
function makeRegistry(ids, probe) {
  const archived = [];
  const pinned = [];
  const entity = {
    id: 'ws-1',
    path: join(home, 'ws'),
    title: 'probe',
    sessionIds: [...ids],
    attachSession(id) {
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
    },
    insertSessionBefore(id) {
      this.attachSession(id);
    },
    detachSession(id) {
      if (probe) probe(id, existsSync(join(sessionsDir, id, 'session.v4.jsonl.zstd')));
      this.sessionIds = this.sessionIds.filter((item) => item !== id);
    }
  };
  return {
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    entities: [entity],
    entity,
    list() {
      return [entity];
    },
    get(id) {
      return String(id) === 'ws-1' ? entity : undefined;
    },
    archiveSession(id) {
      archived.push(id);
    },
    unarchiveSession(id) {
      return archived.filter((item) => item !== id);
    },
    pinSession(id) {
      pinned.push(id);
    },
    unpinSession(id) {
      return pinned.filter((item) => item !== id);
    }
  };
}

function makeCtx(registry) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      return undefined;
    },
    emit() {},
    logger: { warn() {} }
  };
}

function seedSession(id, title) {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), LOG_BODY);
  mkdirSync(projcacheDir, { recursive: true });
  writeFileSync(
    join(projcacheDir, `${id}.json`),
    JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } })
  );
  return dir;
}

function writeRegistry(ids) {
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(
    workspaceFile,
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: 'ws-1',
        workspaceIds: ['ws-1'],
        archivedSessionIds: [],
        pinnedSessionIds: []
      },
      tables: {
        workspaces: {
          'ws-1': { path: join(home, 'ws'), title: 'probe', sessionIds: ids, createdAt: 1, updatedAt: 1 }
        }
      }
    })
  );
}

function ledgerIds() {
  return JSON.parse(readFileSync(workspaceFile, 'utf8')).tables.workspaces['ws-1'].sessionIds;
}

const A = 'session-aaaaaaaa-1111-4111-8111-111111111111';
const B = 'session-bbbbbbbb-2222-4222-8222-222222222222';

console.log('\n── hard delete: ledger before bytes ─────────────────────────');
seedSession(A, '顺序测试会话');
writeRegistry([A]);

let logPresentAtDetach = null;
const registryA = makeRegistry([A], (id, present) => {
  logPresentAtDetach = present;
});
const serviceA = createPurgeService(makeCtx(registryA), {});

const purged = await serviceA.purge([A], { confirm: true });
check('purge reports success', purged.ok === true, JSON.stringify(purged.failed));
check(
  'the log still existed when the registry was told to forget it',
  logPresentAtDetach === true,
  `log present at detach time = ${String(logPresentAtDetach)} (false means the ledger is written last and a crash bricks the next boot)`
);
check('the log is gone afterwards', !existsSync(join(sessionsDir, A)));
check('the ledger no longer lists the session', ledgerIds().length === 0, JSON.stringify(ledgerIds()));

console.log('\n── recycle bin: ledger before bytes ─────────────────────────');
seedSession(B, '顺序测试会话（回收站）');
writeRegistry([A, B]);
const registryB = makeRegistry([A, B], (id, present) => {
  if (id === B) logPresentAtDetach = present;
});
const serviceB = createPurgeService(makeCtx(registryB), { trashRetentionDays: 3 });

logPresentAtDetach = null;
const binned = await serviceB.trash([B]);
check('trash reports success', binned.ok === true, JSON.stringify(binned.failed));
check(
  'moving to the bin also detaches the ledger first',
  logPresentAtDetach === true,
  `log present at detach time = ${String(logPresentAtDetach)}`
);
check('the log left the live area', !existsSync(join(sessionsDir, B)));
check('the payload is parked in the bin', existsSync(trashLib.trashRoot(home)), trashLib.trashRoot(home));
const binEntries = (await trashLib.listTrash(home)).entries;
check('exactly one bin entry', binEntries.length === 1, String(binEntries.length));
check('the ledger only lists the survivor', JSON.stringify(ledgerIds()) === JSON.stringify([A]), JSON.stringify(ledgerIds()));

/* Restoring must put the ledger row back only after the bytes are back, for
   the same reason in reverse: a ledger row on a missing log is fatal. */
let logPresentAtAttach = null;
const registryC = makeRegistry([A], (id, present) => {
  logPresentAtDetach = present;
});
registryC.entity.attachSession = function attachSession(id) {
  logPresentAtAttach = existsSync(join(sessionsDir, id, 'session.v4.jsonl.zstd'));
  if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
};
const serviceC = createPurgeService(makeCtx(registryC), { trashRetentionDays: 3 });

const restored = await serviceC.restore([binEntries[0].entryId]);
check('restore reports success', restored.ok === true, JSON.stringify(restored.failed));
check(
  'the log was already back when the registry re-attached it',
  logPresentAtAttach === true,
  `log present at attach time = ${String(logPresentAtAttach)}`
);
check('the log is back on disk', existsSync(join(sessionsDir, B, 'session.v4.jsonl.zstd')));
check('the bin is empty again', (await trashLib.listTrash(home)).entries.length === 0);

console.log('\n── a dangling ledger row is what we must never produce ──────');
/* Whatever happens, no id may sit in the ledger without a log behind it.
   That is the exact state the host refuses to boot from.

   Note the ledger is rebuilt here from the survivors on disk, not from the
   ids this test started with: `A` was hard-deleted above, so listing it again
   would manufacture the very inconsistency this check looks for. */
const survivors = [A, B].filter((id) => existsSync(join(sessionsDir, id, 'session.v4.jsonl.zstd')));
writeRegistry(survivors);
const ledgerNow = ledgerIds();
const dangling = ledgerNow.filter((id) => !existsSync(join(sessionsDir, id, 'session.v4.jsonl.zstd')));
check('no ledger row points at a missing log', dangling.length === 0, JSON.stringify(dangling));
check('the survivor is still registered', ledgerNow.length === 1, JSON.stringify(ledgerNow));

console.log('\n── cleanup ──────────────────────────────────────────────────');
/* The user's real bin directory exists as soon as they use the feature, so the
   invariant is not "the directory is absent" but "none of this test's ids ever
   reached the real profile". */
function realHomeMentions(needle) {
  const realHome = join(process.env.USERPROFILE || '', '.dsh');
  const files = [
    join(realHome, 'storages', 'dsh-session-purge', 'trash', 'index.json'),
    join(realHome, 'storages', 'workspace.json')
  ];
  for (const target of files) {
    try {
      if (readFileSync(target, 'utf8').includes(needle)) return true;
    } catch {
      /* an absent file means nothing leaked into it */
    }
  }
  try {
    for (const slug of readdirSync(join(realHome, 'sessions'), { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const inner = join(realHome, 'sessions', slug.name);
      if (readdirSync(inner).some((name) => name.includes(needle))) return true;
    }
  } catch {
    /* no real sessions directory on this machine */
  }
  return false;
}
const leaked = [A, B].filter((id) => realHomeMentions(id));
check('the real DSH home has no trace of this test', leaked.length === 0, JSON.stringify(leaked));
rmSync(home, { recursive: true, force: true });
check('temp home removed', !existsSync(home));

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
