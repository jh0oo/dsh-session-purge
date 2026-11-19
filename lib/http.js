/**
 * dsh-session-purge — the HTTP bridge.
 *
 * The client half runs in the browser and therefore cannot touch the disk. It
 * talks to this route instead, one POST per operation, with a JSON envelope.
 *
 * Threat model: the route is registered on the local Harness web server, so it
 * is reachable by anything that can reach that server. Three gates keep it
 * honest — loopback-only via the host's own `connection` check when available,
 * POST-only so a stray GET or a prefetcher cannot trigger it, and an explicit
 * `confirm: true` for the destructive call. That last gate is what stops a
 * mis-wired button from deleting anything: the client only sends `confirm`
 * after the user presses the red key.
 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 200;

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Reject non-loopback callers.
 *
 * Preference order: the host's own `connection.requestRejection` (it knows
 * about auth), then a literal Host-header check. Returns 0 when the request is
 * acceptable.
 */
function rejectStatus(ctx, req) {
  const connection = (() => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    } catch {
      return undefined;
    }
  })();
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const verdict = connection.requestRejection({ headers: req.headers });
      if (verdict === undefined || verdict === null || verdict === false) return 0;
      return Number(verdict) || 403;
    } catch {
      return 403;
    }
  }
  const host = String((req.headers && req.headers.host) || '');
  return LOOPBACK.test(host) ? 0 : 403;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体太大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.status = 400;
    throw error;
  }
}

function idsOf(value, field) {
  const name = typeof field === 'string' && field ? field : 'sessionIds';
  if (!Array.isArray(value)) {
    const error = new Error(`缺少 ${name}`);
    error.status = 400;
    throw error;
  }
  const ids = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_BATCH) {
    const error = new Error(`一次最多处理 ${MAX_BATCH} 个会话`);
    error.status = 400;
    throw error;
  }
  return ids;
}

/** `confirm: true` is the only thing standing between a stray request and data loss. */
function requireConfirm(body, text) {
  if (body && body.confirm === true) return;
  const error = new Error(text || '该操作需要 confirm=true');
  error.status = 400;
  error.code = 'unconfirmed';
  throw error;
}

/**
 * Build the request handler bound to one service instance.
 * @param {object} ctx - Cordis host context.
 * @param {object} service - from `createPurgeService`.
 */
export function createHttpHandler(ctx, service) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        send(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }
      const rejected = rejectStatus(ctx, req);
      if (rejected) {
        send(res, rejected, { ok: false, error: 'request rejected', code: 'forbidden' });
        return;
      }

      const body = await readJson(req);
      const method = typeof body.method === 'string' ? body.method : '';

      switch (method) {
        case 'list': {
          send(res, 200, { ok: true, data: await service.list({ includeOrphans: body.includeOrphans === true }) });
          return;
        }
        case 'inspect': {
          const ids = idsOf(body.sessionIds);
          send(res, 200, { ok: true, data: await service.inspect(ids) });
          return;
        }
        case 'purge': {
          const ids = idsOf(body.sessionIds);
          requireConfirm(body, '彻底删除需要 confirm=true');
          send(res, 200, { ok: true, data: await service.purge(ids, { dryRun: body.dryRun === true }) });
          return;
        }
        /* ── recycle bin ─────────────────────────────────────────────────── */
        case 'trash': {
          const ids = idsOf(body.sessionIds);
          requireConfirm(body, '移入回收站需要 confirm=true');
          send(res, 200, { ok: true, data: await service.trash(ids, { dryRun: body.dryRun === true }) });
          return;
        }
        case 'trashList': {
          send(res, 200, { ok: true, data: await service.trashList() });
          return;
        }
        case 'restore': {
          const entryIds = idsOf(body.entryIds, 'entryIds');
          send(res, 200, { ok: true, data: await service.restore(entryIds) });
          return;
        }
        case 'purgeForever': {
          const entryIds = idsOf(body.entryIds, 'entryIds');
          requireConfirm(body, '彻底删除需要 confirm=true');
          send(res, 200, { ok: true, data: await service.purgeForever(entryIds) });
          return;
        }
        case 'emptyTrash': {
          requireConfirm(body, '清空回收站需要 confirm=true');
          send(res, 200, { ok: true, data: await service.emptyTrash() });
          return;
        }
        default: {
          send(res, 404, { ok: false, error: `未知方法：${method || '(空)'}`, code: 'unknown-method' });
        }
      }
    } catch (error) {
      const status = Number(error && error.status) >= 400 ? Number(error.status) : 500;
      send(res, status, {
        ok: false,
        error: error && error.message ? String(error.message) : String(error),
        code: error && error.code ? String(error.code) : undefined
      });
    }
  };
}

export { MAX_BATCH };
