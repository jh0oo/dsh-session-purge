/**
 * dsh-session-purge — host half.
 *
 * Responsibilities, and nothing else:
 *   1. build the purge service (policy + filesystem orchestration),
 *   2. mount the private HTTP route the client half calls,
 *   3. tear both down cleanly when the plugin is disabled.
 *
 * The plugin registers no tool, no command and no prompt hook: it is purely a
 * UI-driven destructive utility, and giving a model a "delete sessions" tool
 * would be a licence the user never asked for.
 */
import { createHttpHandler } from './lib/http.js';
import { createPurgeService } from './lib/service.js';

export const name = 'session-purge';
export const inject = [];

/** The one route this plugin owns. Chosen to be unmistakable in a log. */
export const routePath = '/dsh-session-purge';

function warn(ctx, text, error) {
  try {
    const detail = error && error.message ? `：${error.message}` : '';
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[session-purge] ${text}${detail}`);
    else console.warn(`[session-purge] ${text}${detail}`);
  } catch {
    /* logging must never break activation */
  }
}

export function apply(ctx, config) {
  let service;
  try {
    service = createPurgeService(ctx, config);
  } catch (error) {
    warn(ctx, '删除服务初始化失败', error);
    return;
  }

  const mountRoute = (hostCtx) => {
    const server = hostCtx && hostCtx.webServer;
    if (!server || typeof server.register !== 'function') {
      warn(ctx, 'webServer 不可用，删除入口无法工作');
      return;
    }
    let dispose;
    try {
      const handler = createHttpHandler(ctx, service);
      dispose = server.register({
        kind: 'exact',
        path: routePath,
        handler: (req, res) => handler(req, res)
      });
    } catch (error) {
      warn(ctx, '删除路由注册失败', error);
      return;
    }
    ctx.effect(() => () => {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        /* already gone */
      }
    }, 'session-purge.webRoute');
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoute);
  } else if (typeof ctx.get === 'function') {
    mountRoute(ctx);
  }
}
