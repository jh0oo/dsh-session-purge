#!/usr/bin/env node
/**
 * Repair a DSH data directory that can no longer boot.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH validates every workspace-ledger member at boot:
 *
 *   WorkspaceRegistry.init → indexLiveSessions → WorkspaceEntity.attachSession
 *     → readSessionHeader(id) → throw "cannot validate session '<id>':
 *       session persistence holds no such session"
 *
 * A thrown error there is `dsh: fatal load failure` — the app does not start.
 * The ledger can end up naming a session for two reasons we have actually seen:
 *
 *   1. Something wrote a member into workspace.json without telling the host,
 *      so the host's persistence index never learned that session.
 *   2. The app was interrupted between "log moved away" and "ledger updated".
 *
 * A plugin cannot fix this: plugins load *after* the failing step. So the repair
 * has to be a script you run from a terminal while the app is closed.
 *
 * WHAT IT DOES
 * ------------
 *   - Drops ledger members (and archived / pinned entries) whose session has no
 *     log on disk — the members that make the host throw.
 *   - Removes projection-cache and session-policy records that name a session
 *     with no log — orphan index rows left by an interrupted delete.
 *   - Prunes session directories that are empty, and empty slug directories.
 *
 * Every write is atomic (temp file + rename, with retries), and the ledger is
 * rewritten at most once.
 *
 * USAGE
 * -----
 *   node tools/repair-ledger.mjs              # report only, change nothing
 *   node tools/repair-ledger.mjs --apply      # write the repairs
 *   node tools/repair-ledger.mjs --apply --home "D:\\other\\.dsh"
 */
import { readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SESSION_LOG = 'session.v4.jsonl.zstd';
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE']);
const RENAME_TRIES = 6;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const homeIndex = argv.indexOf('--home');
const HOME = resolve(
  homeIndex >= 0 && argv[homeIndex + 1] ? argv[homeIndex + 1] : process.env.DSH_HOME || join(homedir(), '.dsh')
);

const log = (text) => console.log(text);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const bareId = (value) => String(value).replace(/^session-/, '');

async function renameWithRetry(from, to) {
  let last;
  for (let attempt = 0; attempt < RENAME_TRIES; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      last = error;
      if (!RETRYABLE.has(error.code)) throw error;
      await delay(60 * 2 ** attempt);
    }
  }
  throw last;
}

async function writeJsonAtomic(target, value) {
  const temp = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Every session directory on disk, keyed by both spellings of its id. */
async function scanSessions() {
  const root = join(HOME, 'sessions');
  const known = new Map();
  const ids = new Set();
  const emptyDirs = [];
  const emptySlugs = [];

  if (!existsSync(root)) return { known, ids, emptyDirs, emptySlugs, slugs: 0, dirs: 0 };

  const slugs = await readdir(root, { withFileTypes: true });
  let slugCount = 0;
  let dirCount = 0;

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    slugCount += 1;
    const slugPath = join(root, slug.name);
    const entries = await readdir(slugPath, { withFileTypes: true });
    let kept = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      dirCount += 1;
      const dirPath = join(slugPath, entry.name);
      const logPath = join(dirPath, SESSION_LOG);
      if (!existsSync(logPath)) {
        emptyDirs.push(dirPath);
        continue;
      }
      kept += 1;
      const bare = bareId(entry.name);
      ids.add(entry.name);
      known.set(entry.name, dirPath);
      known.set(bare, dirPath);
      known.set(`session-${bare}`, dirPath);
    }

    if (kept === 0) emptySlugs.push(slugPath);
  }

  return { known, ids, emptyDirs, emptySlugs, slugs: slugCount, dirs: dirCount };
}

async function repairLedger({ known, emptySlugs }) {
  const target = join(HOME, 'storages', 'workspace.json');
  if (!existsSync(target)) return { status: 'missing', dropped: [], archived: 0, pinned: 0 };
  const ledger = JSON.parse(await readFile(target, 'utf8'));
  const dropped = [];
  const isKnown = (id) => known.has(String(id)) || known.has(bareId(id));

  for (const [workspaceId, table] of Object.entries(ledger.tables?.workspaces || {})) {
    if (!Array.isArray(table.sessionIds)) continue;
    const keep = [];
    for (const id of table.sessionIds) {
      if (isKnown(id)) keep.push(id);
      else dropped.push({ workspaceId, id });
    }
    table.sessionIds = keep;
  }

  /* Empty slug directories mean every session under them is gone; their members
     are covered by the loop above, and the directories themselves are pruned by
     pruneDirs(), so nothing extra is needed here. */

  const before = {
    archived: Array.isArray(ledger.global?.archivedSessionIds) ? ledger.global.archivedSessionIds.length : 0,
    pinned: Array.isArray(ledger.global?.pinnedSessionIds) ? ledger.global.pinnedSessionIds.length : 0
  };
  if (Array.isArray(ledger.global?.archivedSessionIds)) {
    ledger.global.archivedSessionIds = ledger.global.archivedSessionIds.filter(isKnown);
  }
  if (Array.isArray(ledger.global?.pinnedSessionIds)) {
    ledger.global.pinnedSessionIds = ledger.global.pinnedSessionIds.filter(isKnown);
  }
  const after = {
    archived: Array.isArray(ledger.global?.archivedSessionIds) ? ledger.global.archivedSessionIds.length : 0,
    pinned: Array.isArray(ledger.global?.pinnedSessionIds) ? ledger.global.pinnedSessionIds.length : 0
  };

  if (dropped.length > 0 || before.archived !== after.archived || before.pinned !== after.pinned) {
    if (APPLY) await writeJsonAtomic(target, ledger);
    return {
      status: APPLY ? 'repaired' : 'would-repair',
      dropped,
      archived: before.archived - after.archived,
      pinned: before.pinned - after.pinned
    };
  }
  return { status: 'clean', dropped: [], archived: 0, pinned: 0 };
}

async function repairRecords(dir, label, known) {
  const orphans = [];
  if (!existsSync(dir)) return orphans;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const base = entry.name.replace(/\.json(\..*)?$/, '');
    if (!/^[0-9a-zA-Z._-]+$/.test(base)) continue;
    if (known.has(base) || known.has(bareId(base))) continue;
    orphans.push(join(dir, entry.name));
  }
  if (APPLY) for (const path of orphans) await rm(path, { force: true });
  return orphans.map((path) => `${label}/${path.slice(path.lastIndexOf('\\') + 1)}`);
}

async function pruneDirs({ emptyDirs, emptySlugs }) {
  const removed = [];
  for (const dirPath of emptyDirs) {
    if (APPLY) await rm(dirPath, { recursive: true, force: true });
    removed.push(dirPath);
  }
  for (const slugPath of emptySlugs) {
    try {
      if (APPLY) await rmdir(slugPath);
      removed.push(slugPath);
    } catch {
      /* not empty after all, or already gone */
    }
  }
  return removed;
}

async function main() {
  log(`DSH home : ${HOME}`);
  log(`mode     : ${APPLY ? 'APPLY (writes repairs)' : 'report only (pass --apply to write)'}`);
  if (!existsSync(join(HOME, 'storages'))) {
    log('\nNo storages directory here. Point --home at the right data directory.');
    process.exit(2);
  }

  const scan = await scanSessions();
  log(`\nsessions : ${scan.dirs} directories, ${scan.ids.size} unique ids`);

  const ledger = await repairLedger(scan);
  const cache = await repairRecords(join(HOME, 'storages', 'session_projcache', 'sessions'), 'projection-cache', scan.known);
  const policy = await repairRecords(
    join(HOME, 'storages', 'vision_router_session_policy', 'policies'),
    'session-policy',
    scan.known
  );
  const pruned = await pruneDirs(scan);

  log('\n--- ledger ---');
  if (ledger.status === 'missing') log('no workspace.json, nothing to repair');
  else if (ledger.status === 'clean') log('members all resolve to a session on disk');
  else {
    log(`${ledger.status === 'repaired' ? 'dropped' : 'would drop'} ${ledger.dropped.length} dangling member(s):`);
    for (const item of ledger.dropped) log(`  ${item.workspaceId}  ${item.id}`);
    if (ledger.archived) log(`archived entries dropped: ${ledger.archived}`);
    if (ledger.pinned) log(`pinned entries dropped: ${ledger.pinned}`);
  }

  log('\n--- orphan index rows ---');
  if (cache.length === 0 && policy.length === 0) log('none');
  for (const item of cache) log(`  ${item}`);
  for (const item of policy) log(`  ${item}`);

  log('\n--- empty directories ---');
  if (pruned.length === 0) log('none');
  for (const item of pruned) log(`  ${item}`);

  const dirty = ledger.status === 'repaired' || ledger.status === 'would-repair' || cache.length + policy.length + pruned.length > 0;
  log(`\n${dirty ? (APPLY ? 'REPAIRED' : 'REPAIRABLE — rerun with --apply') : 'NOTHING TO REPAIR'}`);
  process.exit(dirty && !APPLY ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nrepair failed: ${error && error.message ? error.message : error}`);
  process.exit(3);
});
