/**
 * test/helpers.mjs — shared fixtures for the dsh-session-purge regression suite.
 *
 * The one rule every test in this directory obeys: **the suite never touches the
 * live store.** `makeTempHome()` creates a throwaway directory, points
 * `$DSH_HOME` at it (lib/store.js re-reads that variable on every
 * `resolveHome()` call, so setting it before the first store call is enough) and
 * refuses to continue if the path somehow resolves inside the real `~/.dsh`.
 *
 * Everything here is dependency-free: node:fs / node:os / node:path only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';

/* ── isolation guard ─────────────────────────────────────────────────────── */

const REAL_HOMES = (() => {
  const candidates = [];
  if (process.env.USERPROFILE) candidates.push(resolve(process.env.USERPROFILE, '.dsh'));
  candidates.push(resolve(homedir(), '.dsh'));
  return [...new Set(candidates)];
})();

/** The real store path(s) this suite must never write to. */
export function realHomes() {
  return [...REAL_HOMES];
}

/**
 * Throw unless `home` is strictly outside every real DSH home. Returns the
 * resolved path so callers can compare it with `resolveHome()`.
 */
export function assertIsolated(home) {
  const candidate = resolve(home);
  for (const real of REAL_HOMES) {
    if (candidate === real || candidate.startsWith(real + sep)) {
      throw new Error(`测试目录落在真实 DSH home 内，已中止：${candidate}（真实：${real}）`);
    }
  }
  return candidate;
}

/**
 * Create a throwaway `$DSH_HOME`, export it for `resolveHome()`, and return the
 * paths the fixtures need plus an idempotent cleanup.
 *
 * @param {string} prefix - temp directory prefix, e.g. `'sp-atomic-'`.
 */
export function makeTempHome(prefix = 'sp-test-') {
  const home = assertIsolated(mkdtempSync(join(tmpdir(), prefix)));
  process.env.DSH_HOME = home;
  const storages = join(home, 'storages');
  mkdirSync(storages, { recursive: true });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return true;
    cleaned = true;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
        return true;
      } catch {
        /* Windows may still hold a handle for a moment */
      }
    }
    return false;
  };
  return { home, storages, cleanup };
}

/* ── assertion tool ──────────────────────────────────────────────────────── */

/**
 * Counted assertion runner.
 *
 * `check()` never throws: the whole group runs, every failure is reported, and
 * `finish()` decides the process exit code. That is what makes a failing run
 * still print the failing assertion instead of stopping at the first one.
 */
export function makeChecker(title = '') {
  let pass = 0;
  const failures = [];

  return {
    title,
    /** Print a section header. */
    group(name) {
      console.log(`\n${name}`);
    },
    /** One assertion. `detail` is printed only on failure. */
    check(label, ok, detail) {
      if (ok) {
        pass += 1;
        console.log(`  PASS  ${label}`);
        return true;
      }
      failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
      console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
      return false;
    },
    get passed() {
      return pass;
    },
    get failed() {
      return failures.length;
    },
    get failures() {
      return [...failures];
    },
    /** Print the summary line; returns true when everything passed. */
    finish() {
      const ok = failures.length === 0;
      if (ok) {
        console.log(`\nALL CHECKS PASSED — ${pass} passed, 0 failed`);
      } else {
        console.log(`\n${failures.length} CHECK(S) FAILED — ${pass} passed, ${failures.length} failed`);
        for (const failure of failures) console.log(`  - ${failure}`);
      }
      return ok;
    }
  };
}

/* ── filesystem fixtures ─────────────────────────────────────────────────── */

export function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * JSON write with the same trailing newline the plugin's writer uses.
 * Missing parent directories are created so fixtures stay one-liners.
 */
export function writeJson(target, value, options) {
  const compact = Boolean(options && options.compact);
  const text = compact ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  return value;
}

/** JSON read that throws on a missing file (fixtures must exist). */
export function readJsonAt(target) {
  return JSON.parse(readFileSync(target, 'utf8'));
}

/** Raw text of a file. */
export function readTextAt(target) {
  return readFileSync(target, 'utf8');
}

/** Leftover `.<uuid>.tmp` files in a directory. */
export function leftoverTemps(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  } catch {
    return [];
  }
}

/** Recursively collect every `*.tmp` file under a directory. */
export function allTemps(dir) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The workspace ledger shape the Host writes (`workspace.json`).
 *
 * `ids` become the membership of one workspace; `options.archived` /
 * `options.pinned` seed the global flag lists.
 */
export function workspaceLedger(ids, options) {
  const archived = (options && options.archived) || [];
  const pinned = (options && options.pinned) || [];
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'ws-1',
      workspaceIds: ['ws-1'],
      archivedSessionIds: [...archived],
      pinnedSessionIds: [...pinned]
    },
    tables: {
      workspaces: {
        'ws-1': { path: 'C:\\ws', title: 'ws', sessionIds: [...ids] }
      }
    }
  };
}

/** Write a workspace ledger to `target` and return the object. */
export function seedWorkspace(target, ids, options) {
  return writeJson(target, workspaceLedger(ids, options));
}

/* ── host-context stubs ──────────────────────────────────────────────────── */

/**
 * Minimal Cordis-shaped context: `get(name)` resolves from `services`, and the
 * few members lib/service.js touches are harmless no-ops. Passing no services
 * models a headless host (no registry, no agents, no live sessions).
 */
export function makeCtx(services = {}) {
  const map = services || {};
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
    },
    emit() {
      /* no listeners is fine */
    },
    logger: { warn() {}, info() {}, error() {} }
  };
}

/**
 * In-memory `workspaceRegistry` stub seeded from a ledger object.
 *
 * Mirrors the four members lib/service.js uses: `list()`, the two flag arrays,
 * `unpinSession`/`unarchiveSession`, plus `entity.detachSession`. It mutates only
 * its own arrays — the on-disk rewrite is a separate (and also tested) path.
 */
export function makeRegistry(ledger) {
  const global = (ledger && ledger.global) || {};
  const archivedSessionIds = [...(global.archivedSessionIds || [])];
  const pinnedSessionIds = [...(global.pinnedSessionIds || [])];
  const tables = (ledger && ledger.tables) || {};
  const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {};

  const entities = Object.entries(workspaces).map(([id, record]) => ({
    id,
    path: (record && record.path) || '',
    title: (record && record.title) || '',
    sessionIds: [...((record && record.sessionIds) || [])],
    detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter((value) => value !== sessionId);
    }
  }));

  const drop = (list, value) => {
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
    return index;
  };

  return {
    archivedSessionIds,
    pinnedSessionIds,
    entities,
    list() {
      return entities;
    },
    unpinSession(sessionId) {
      return drop(pinnedSessionIds, sessionId);
    },
    unarchiveSession(sessionId) {
      return drop(archivedSessionIds, sessionId);
    }
  };
}

/** The reserved destination `schedule` derives for a `new_once` task. */
export function reservedScheduleId(taskId) {
  return `session-schedule-${createHash('sha256').update(String(taskId)).digest('hex')}`;
}

/** `session-<guid>` → `<guid>` (same rule as lib/store.js). */
export function bareId(sessionId) {
  return String(sessionId || '').replace(/^session-/, '');
}

/** sha256 of a buffer/string, hex — used for content-addressed attachments. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
