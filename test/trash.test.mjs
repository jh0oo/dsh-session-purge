/**
 * Recycle-bin round trip.
 *
 * The bin exists for exactly one promise: what went in can come back out
 * byte-for-byte, in the same place, under the same title. Everything else here
 * is the negative half of that promise — a purged entry is gone, an expired
 * entry is gone, and a path that points outside the DSH home is refused.
 *
 * Runs against a throwaway `DSH_HOME`; touching the real profile would delete
 * the user's sessions if any assertion is wrong.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
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

const home = mkdtempSync(join(tmpdir(), 'sp-trash-'));
process.env.DSH_HOME = home;
assertIsolated(home);

const store = await import('../lib/store.js');
const trash = await import('../lib/trash.js');
const { createPurgeService } = await import('../lib/service.js');

const SLUG = '--C-Users-test-workspace--';
const sessionsDir = join(home, 'sessions', SLUG);
const projcacheDir = join(home, 'storages', 'session_projcache', 'sessions');
const policyDir = join(home, 'storages', 'vision_router_session_policy', 'policies');
const workspaceFile = join(home, 'storages', 'workspace.json');

const LOG_BODY = JSON.stringify({ type: 'session', version: 4, id: 'session-probe', cwd: '/tmp/ws' }) + '\n';
const PROJ_BODY = JSON.stringify({ version: 7, record: { rows: { title: { val: '回收站测试会话' } } } });
const POLICY_BODY = JSON.stringify({ provider: 'probe' });

/** A workspace registry stub: the service only needs list/get/attach/detach. */
function makeRegistry(ids) {
  const attached = [];
  const archived = [];
  const pinned = [];
  const entity = {
    id: 'ws-1',
    path: join(home, 'ws'),
    title: 'probe',
    sessionIds: [...ids],
    attachSession(id) {
      attached.push(id);
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
    },
    insertSessionBefore(id) {
      this.attachSession(id);
    },
    detachSession(id) {
      this.sessionIds = this.sessionIds.filter((item) => item !== id);
    }
  };
  return {
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    entities: [entity],
    attached,
    list() {
      return [entity];
    },
    get(id) {
      return String(id) === 'ws-1' ? entity : undefined;
    },
    archiveSession(id) {
      archived.push(id);
    },
    pinSession(id) {
      pinned.push(id);
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

function seedSession(id, { title, projcache = true, policy = true } = {}) {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), LOG_BODY);
  if (projcache) {
    mkdirSync(projcacheDir, { recursive: true });
    writeFileSync(join(projcacheDir, `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } }));
  }
  if (policy) {
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, `${id}.json`), POLICY_BODY);
  }
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

const A = 'session-aaaaaaaa-1111-4111-8111-111111111111';
const B = 'session-bbbbbbbb-2222-4222-8222-222222222222';

console.log('\n── round trip ───────────────────────────────────────────────');
seedSession(A, { title: '第一个会话' });
seedSession(B, { title: '第二个会话' });
writeRegistry([A, B]);

const registry = makeRegistry([A, B]);
const service = createPurgeService(makeCtx(registry), { trashRetentionDays: 7 });

const before = await store.listSessionDirs(home);
check('two session dirs seeded', before.length === 2, JSON.stringify(before.map((d) => d.name)));

const listingBefore = await service.list();
check('both rows listed', listingBefore.sessions.length === 2, String(listingBefore.sessions.length));
const titlesBefore = listingBefore.sessions.map((row) => row.title).sort();
check('titles come from the projection cache', titlesBefore.join('|') === '第一个会话|第二个会话', titlesBefore.join('|'));

const logBefore = readFileSync(join(sessionsDir, A, 'session.v4.jsonl.zstd'));
const projBefore = readFileSync(join(projcacheDir, `${A}.json`));

console.log('\n── move to bin ──────────────────────────────────────────────');
const moved = await service.trash([A]);
check('trash reports success', moved.ok === true, JSON.stringify(moved.failed));
check('one session trashed', moved.trashed.length === 1 && moved.trashed[0] === A);
check('one bin entry created', moved.entryIds.length === 1, JSON.stringify(moved.entryIds));
check('retention comes from config', moved.retentionDays === 7, String(moved.retentionDays));

check('session dir left the live tree', !existsSync(join(sessionsDir, A)));
check('projection cache left the live tree', !existsSync(join(projcacheDir, `${A}.json`)));
check('policy record left the live tree', !existsSync(join(policyDir, `${A}.json`)));
check('the other session is untouched', existsSync(join(sessionsDir, B, 'session.v4.jsonl.zstd')));

const indexAfterMove = await trash.readTrashIndex(home);
check('index holds one entry', indexAfterMove.entries.length === 1, String(indexAfterMove.entries.length));
const entry = indexAfterMove.entries[0];
check('entry keeps the title', entry.title === '第一个会话', entry.title);
check('entry keeps the workspace slot', entry.workspace && entry.workspace.workspaceId === 'ws-1', JSON.stringify(entry.workspace));
check('entry records its bytes', Number(entry.bytes) > 0, String(entry.bytes));
check('entry has an expiry in the future', Number(entry.expiresAt) > Date.now(), String(entry.expiresAt));
check(
  'expiry is exactly the configured retention',
  Math.round((Number(entry.expiresAt) - Number(entry.deletedAt)) / 86400000) === 7,
  String((Number(entry.expiresAt) - Number(entry.deletedAt)) / 86400000)
);

const payloadFiles = readdirSync(join(trash.trashRoot(home), entry.entryId, 'payload'));
check('payload directory holds the moved bytes', payloadFiles.length === 3, payloadFiles.join(','));

const listedAfterMove = await service.trashList();
check('bin lists the entry', listedAfterMove.entries.length === 1, String(listedAfterMove.entries.length));
check('bin reports the retention policy', listedAfterMove.retentionDays === 7, String(listedAfterMove.retentionDays));

const rowsAfterMove = await service.list();
check('the session is gone from the live list', rowsAfterMove.sessions.length === 1, String(rowsAfterMove.sessions.length));
check('the survivor is the other session', rowsAfterMove.sessions[0].id === B, rowsAfterMove.sessions[0].id);
check(
  'workspace ledger dropped the id',
  !readFileSync(workspaceFile, 'utf8').includes(A),
  'workspace.json still mentions the trashed id'
);

console.log('\n── restore ──────────────────────────────────────────────────');
const restored = await service.restore([entry.entryId]);
check('restore reports success', restored.ok === true, JSON.stringify(restored.failed));
check('one entry restored', restored.restored.length === 1, String(restored.restored.length));
check('warning list is empty for a clean round trip', restored.restored[0].warnings.length === 0, JSON.stringify(restored.restored[0].warnings));

check('session dir is back', existsSync(join(sessionsDir, A, 'session.v4.jsonl.zstd')));
check('log bytes are identical', readFileSync(join(sessionsDir, A, 'session.v4.jsonl.zstd')).equals(logBefore));
check('projection cache is back', existsSync(join(projcacheDir, `${A}.json`)));
check('projection cache bytes are identical', readFileSync(join(projcacheDir, `${A}.json`)).equals(projBefore));
check('policy record is back', existsSync(join(policyDir, `${A}.json`)));
check('bin is empty afterwards', (await trash.listTrash(home)).entries.length === 0);
check('index file is empty', (await trash.readTrashIndex(home)).entries.length === 0);
check('the workspace was told to re-attach it', registry.attached.includes(A), JSON.stringify(registry.attached));

const rowsAfterRestore = await service.list();
check('both rows are listed again', rowsAfterRestore.sessions.length === 2, String(rowsAfterRestore.sessions.length));
const restoredRow = rowsAfterRestore.sessions.find((row) => row.id === A);
check('the restored row kept its title', restoredRow && restoredRow.title === '第一个会话', restoredRow && restoredRow.title);

console.log('\n── purge forever ────────────────────────────────────────────');
const second = await service.trash([B]);
check('trash the second session', second.ok === true && second.entryIds.length === 1);
const entryB = (await trash.readTrashIndex(home)).entries[0];
const purged = await service.purgeForever([entryB.entryId]);
check('purge reports success', purged.ok === true, JSON.stringify(purged.failed));
check('one entry destroyed', purged.destroyed.length === 1, String(purged.destroyed.length));
check('purged bytes are reported', Number(purged.bytes) > 0, String(purged.bytes));
check('payload is gone from disk', !existsSync(join(trash.trashRoot(home), entryB.entryId)));
check('session dir stays gone', !existsSync(join(sessionsDir, B)));
check('bin is empty after purge', (await trash.listTrash(home)).entries.length === 0);
check('nothing remains in the bin index', (await trash.readTrashIndex(home)).entries.length === 0);

console.log('\n── empty the bin ────────────────────────────────────────────');
seedSession(B, { title: '再删一次' });
writeRegistry([A, B]);
await service.trash([B]);
const emptied = await service.emptyTrash();
check('empty reports success', emptied.ok === true, JSON.stringify(emptied.failed));
check('empty destroyed the entry', emptied.destroyed.length === 1, String(emptied.destroyed.length));
check('empty leaves the bin empty', emptied.remaining === 0, String(emptied.remaining));
const emptiedAgain = await service.emptyTrash();
check('emptying an empty bin is a no-op', emptiedAgain.ok === true && emptiedAgain.destroyed.length === 0);

console.log('\n── expiry sweep ─────────────────────────────────────────────');
seedSession(B, { title: '会过期' });
writeRegistry([A, B]);
const third = await service.trash([B]);
const staleEntry = (await trash.readTrashIndex(home)).entries.find((row) => row.entryId === third.entryIds[0]);
check('expiring entry exists', Boolean(staleEntry), JSON.stringify(third.entryIds));

/* Age the entry by rewriting the index: deletedAt and expiresAt in the past. */
const indexNow = await trash.readTrashIndex(home);
const aged = indexNow.entries.map((row) =>
  row.entryId === staleEntry.entryId
    ? { ...row, deletedAt: Date.now() - 40 * 86400000, expiresAt: Date.now() - 86400000 }
    : row
);
await trash.writeTrashIndexAt(home, { version: indexNow.version, entries: aged });
check('aged entry is on disk before the sweep', existsSync(join(trash.trashRoot(home), staleEntry.entryId)));

const swept = await service.trashList();
check('sweep removed the expired entry', swept.swept === 1, String(swept.swept));
check('sweep reports the freed bytes', Number(swept.sweptBytes) > 0, String(swept.sweptBytes));
check('expired payload is gone from disk', !existsSync(join(trash.trashRoot(home), staleEntry.entryId)));
check('bin is empty after the sweep', swept.entries.length === 0, String(swept.entries.length));

console.log('\n── refusals ─────────────────────────────────────────────────');
let rejected = '';
try {
  await service.trash([]);
} catch (error) {
  rejected = String(error && error.code);
}
check('an empty selection is refused', rejected === 'empty', rejected);

rejected = '';
try {
  await service.restore(['not-an-entry']);
} catch (error) {
  rejected = String(error && error.code);
}
check('restoring a missing entry reports a failure rather than throwing', rejected === '', rejected);

let outside = '';
try {
  await trash.moveIntoTrash(home, {
    sessionDirs: [{ from: join(home, '..', 'outside-target'), name: 'outside-target' }],
    files: []
  });
} catch (error) {
  outside = String(error && error.code);
}
check('a path outside the data home is refused', String(outside).startsWith('TRASH_'), outside);

console.log('\n── cleanup ──────────────────────────────────────────────────');
/* Assert on our own test ids rather than on "the real bin directory does not
   exist": the user's bin legitimately exists once they have used the feature.
   What must never happen is one of *these* ids leaking into the real profile. */
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
