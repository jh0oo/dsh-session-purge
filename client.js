/**
 * dsh-session-purge — browser half.
 *
 * Seats used (all declared by the host bundles):
 *   sidebar.panellist  → the 「删除会话」row, above 工作区 in the sidebar column
 *   main               → the page that lists every session of the workspace
 *   shell.overlay      → the confirmation dialog and the result toast
 *
 * `sidebar.workspaces` is deliberately NOT used: it is a single-occupant seat
 * and taking it would hide the official workspace list.
 *
 * The browser cannot touch the disk, so every destructive action goes through
 * the plugin's own POST route (`/dsh-session-purge`) on the same origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    var inject = ['slots', 'locale', 'sessions', 'layout'];
    var NS = 'session-purge';
    var PANEL_ID = 'session-purge';
    var API = '/dsh-session-purge';
    /* Sits after every shipped panel row and immediately above 工作区. */
    var ORDER = 58;

    var zh = {
      label: '删除会话',
      title: '删除会话',
      subtitle: '列出工作区内的全部会话。删除先移入回收站，可随时还原；在回收站里彻底删除才会清空日志、缓存、登记与记账。',
      tabSessions: '会话',
      tabTrash: '回收站',
      trashIntro: '已删除的会话暂存在这里，可以完整还原。到期或点「彻底删除」后才会真正清除。',
      trashEmptyHint: '回收站是空的。',
      trashEmpty: '清空回收站',
      trashEmptyTitle: '是否确认清空回收站',
      trashEmptyBody: '回收站里的 {n} 个会话将被彻底清除，无法恢复。',
      restore: '还原',
      purgeForever: '彻底删除',
      purgeForeverTitle: '是否彻底删除此会话',
      purgeForeverBody: '该会话将被彻底清除，无法恢复。',
      trashedAt: '删除于 {when}',
      expiresAt: '{n} 天后到期',
      expiresToday: '今天到期',
      restoreDone: '已还原 {n} 个会话',
      purgeForeverDone: '已彻底删除 {n} 个会话',
      trashedTitle: '已移入回收站 {n} 个会话',
      purging: '正在彻底删除…',
      summaryTrash: '共 {total} 个会话 · {bytes}',
      trashSweepNote: '回收站默认保留 {days} 天，到期自动清除。',
      selectAll: '全选',
      clearAll: '取消全选',
      refresh: '刷新',
      delete: '删除',
      cancel: '取消',
      confirm: '确认',
      loading: '正在读取会话列表…',
      empty: '工作区内没有可删除的会话。',
      retry: '重试',
      columnHint: '单击选中，再次单击取消选中',
      summaryNone: '未选择会话 · 共 {total} 个会话',
      summarySome: '已选 {n} / {total} 个 · 共 {bytes}',
      groupUnknown: '未登记会话',
      tagLive: '运行中',
      tagCurrent: '当前会话',
      tagArchived: '已归档',
      tagPinned: '已固定',
      tagOrphan: '未归属',
      untitled: '未命名会话',
      untitledBlank: '新会话',
      orphansShow: '显示未归属工作区的会话（{n} 个 · {bytes}）',
      orphansHide: '隐藏未归属工作区的会话',
      dialogTitle: '是否确认删除此会话',
      dialogBodyOne: '该会话会被移入回收站，之后可以随时还原。',
      dialogBodyMany: '已选中 {n} 个会话，它们会被移入回收站，之后可以随时还原。',
      dialogScope: '移动的内容：会话日志目录、投影缓存、会话策略、工作区登记、成本记账与无主附件。',
      dialogKeep: '你在自己的工作区里创建的文档不会被删除。',
      dialogRecycleNote: '回收站默认保留 {days} 天，也可以在回收站里立即彻底删除。',
      dialogMore: '…以及另外 {n} 个会话',
      deleting: '正在移入回收站…',
      doneTitle: '已彻底删除 {n} 个会话',
      doneBytes: '释放 {bytes}',
      doneClean: '残留检查：未发现残留。',
      doneLeft: '残留检查：仍有 {n} 项需要处理。',
      doneSchedule: '另有 {n} 条定时任务原本指向这些会话，已改为它们各自的保留目标，任务本身保留。',
      failedTitle: '删除失败',
      liveBlocked: '该会话正在运行，不能删除。',
      currentBlocked: '当前正在查看的会话不能删除。',
      loadFailed: '读取会话列表失败'
    };

    var en = {
      label: 'Delete sessions',
      title: 'Delete sessions',
      subtitle: 'Lists every session of the workspace. Deleting moves it to the recycle bin, where it can be restored; purging from there erases logs, caches, registration and cost entries.',
      tabSessions: 'Sessions',
      tabTrash: 'Recycle bin',
      trashIntro: 'Deleted sessions wait here and can be restored in full. They are only erased when they expire or you purge them.',
      trashEmptyHint: 'The recycle bin is empty.',
      trashEmpty: 'Empty the bin',
      trashEmptyTitle: 'Empty the recycle bin?',
      trashEmptyBody: 'All {n} sessions in the recycle bin will be erased permanently. This cannot be undone.',
      restore: 'Restore',
      purgeForever: 'Purge',
      purgeForeverTitle: 'Purge this session permanently?',
      purgeForeverBody: 'This session will be erased for good. This cannot be undone.',
      trashedAt: 'Deleted {when}',
      expiresAt: 'Expires in {n} days',
      expiresToday: 'Expires today',
      restoreDone: 'Restored {n} sessions',
      purgeForeverDone: 'Purged {n} sessions',
      trashedTitle: 'Moved {n} sessions to the recycle bin',
      purging: 'Purging…',
      summaryTrash: '{total} sessions · {bytes}',
      trashSweepNote: 'The recycle bin keeps sessions for {days} days, then clears them automatically.',
      selectAll: 'Select all',
      clearAll: 'Clear all',
      refresh: 'Refresh',
      delete: 'Delete',
      cancel: 'Cancel',
      confirm: 'Confirm',
      loading: 'Reading sessions…',
      empty: 'This workspace has no sessions to delete.',
      retry: 'Retry',
      columnHint: 'Click to select, click again to deselect',
      summaryNone: 'Nothing selected · {total} sessions',
      summarySome: '{n} / {total} selected · {bytes}',
      groupUnknown: 'Unregistered sessions',
      tagLive: 'Running',
      tagCurrent: 'Current',
      tagArchived: 'Archived',
      tagPinned: 'Pinned',
      tagOrphan: 'Unclaimed',
      untitled: 'Untitled session',
      untitledBlank: 'New session',
      orphansShow: 'Show sessions outside any workspace ({n} · {bytes})',
      orphansHide: 'Hide sessions outside any workspace',
      dialogTitle: 'Delete this session?',
      dialogBodyOne: 'The session moves to the recycle bin, where you can restore it at any time.',
      dialogBodyMany: '{n} sessions are selected. They move to the recycle bin, where you can restore them at any time.',
      dialogScope: 'Moves: session log directory, projection cache, session policy, workspace registration, cost entries and orphaned attachments.',
      dialogKeep: 'Documents you created inside your own workspace are left untouched.',
      dialogRecycleNote: 'The recycle bin keeps them for {days} days; you can also purge them there right away.',
      dialogMore: '…and {n} more sessions',
      deleting: 'Moving to the recycle bin…',
      doneTitle: 'Deleted {n} sessions',
      doneBytes: 'Freed {bytes}',
      doneClean: 'Residue check: nothing left behind.',
      doneLeft: 'Residue check: {n} item(s) still need attention.',
      doneSchedule: '{n} scheduled task(s) pointed at these sessions; they now use their own reserved destination and stay intact.',
      failedTitle: 'Delete failed',
      liveBlocked: 'This session is running and cannot be deleted.',
      currentBlocked: 'The session you are viewing cannot be deleted.',
      loadFailed: 'Could not read the session list'
    };

    var CSS = [
      'html .__sp_page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5}',
      'html .__sp_head{display:flex;align-items:flex-start;gap:12px;padding:18px 22px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      'html .__sp_head_text{flex:1;min-width:0}',
      'html .__sp_h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}',
      'html .__sp_sub{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      'html .__sp_head_actions{display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}',
      'html .__sp_btn{appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;transition:background .12s ease,border-color .12s ease,opacity .12s ease}',
      'html .__sp_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      'html .__sp_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      'html .__sp_btn:disabled{opacity:.45;cursor:not-allowed}',
      'html .__sp_btn.__sp_danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      'html .__sp_btn.__sp_danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      'html .__sp_btn.__sp_solidDanger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
      'html .__sp_btn.__sp_solidDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);opacity:.9}',
      'html .__sp_caption{display:flex;align-items:center;gap:8px;padding:8px 22px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      'html .__sp_caption_hint{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      'html .__sp_link{flex:none;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}',
      'html .__sp_link:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      'html .__sp_link_on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      'html .__sp_body{flex:1;min-height:0;overflow:auto;padding:8px 14px 18px}',
      'html .__sp_group{margin:6px 0 2px}',
      'html .__sp_group_head{display:flex;align-items:baseline;gap:8px;padding:8px 8px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      'html .__sp_group_title{color:var(--dsw-alias-label-secondary);font-weight:600}',
      'html .__sp_group_path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      'html .__sp_row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer;user-select:none;-webkit-user-select:none;border:1px solid transparent;transition:background .1s ease,border-color .1s ease}',
      'html .__sp_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      'html .__sp_row[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2)}',
      'html .__sp_row[aria-disabled="true"]{cursor:not-allowed;opacity:.55}',
      'html .__sp_row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      'html .__sp_box{flex:none;width:16px;height:16px;border-radius:5px;border:1px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary-foreground)}',
      'html .__sp_row[aria-checked="true"] .__sp_box{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      'html .__sp_row_main{flex:1;min-width:0}',
      'html .__sp_row_title{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      'html .__sp_row_meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      'html .__sp_row_bench{overflow:hidden;text-overflow:ellipsis}',
      'html .__sp_row_when{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      'html .__sp_row_blank .__sp_row_title{color:var(--dsw-alias-label-tertiary);font-style:italic}',
      'html .__sp_tags{flex:none;display:flex;align-items:center;gap:5px}',
      'html .__sp_tag{display:inline-block;padding:0 7px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      'html .__sp_tag.__sp_tag_live{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      'html .__sp_tag.__sp_tag_current{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      'html .__sp_foot{display:flex;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l2)}',
      'html .__sp_foot_text{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      'html .__sp_placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:180px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:24px}',
      'html .__sp_mask{position:fixed;inset:0;background:rgba(3,7,12,.62);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1200}',
      'html .__sp_dialog{width:min(470px,92vw);max-height:84vh;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:18px;padding:22px 24px 18px;display:flex;flex-direction:column;gap:11px;box-shadow:0 18px 48px rgba(0,0,0,.36)}',
      'html .__sp_dialog_title{font-size:15px;font-weight:600}',
      'html .__sp_dialog_body{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65}',
      'html .__sp_dialog_scope{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      'html .__sp_dialog_list{margin:0;padding:8px 10px;list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);max-height:150px;overflow:auto;font-size:12px}',
      'html .__sp_dialog_list li{padding:3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      'html .__sp_dialog_error{padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}',
      'html .__sp_dialog_actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:3px}',
      'html .__sp_dialog_actions .__sp_btn{padding:7px 16px}',
      'html .__sp_toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1300;max-width:min(560px,92vw);display:flex;align-items:flex-start;gap:9px;padding:11px 15px;border-radius:12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px rgba(0,0,0,.3);font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
      'html .__sp_toast.__sp_toast_error{border-color:var(--dsw-alias-state-error-primary)}',
      'html .__sp_toast_dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:7px;background:var(--dsw-alias-state-success-primary)}',
      'html .__sp_toast.__sp_toast_error .__sp_toast_dot{background:var(--dsw-alias-state-error-primary)}',
      'html .__sp_tabs{display:flex;align-items:center;gap:4px;padding:10px 22px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      'html .__sp_tab{appearance:none;-webkit-appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12.5px;padding:6px 10px 8px;cursor:pointer;border-radius:0}',
      'html .__sp_tab:hover{color:var(--dsw-alias-label-primary)}',
      'html .__sp_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      'html .__sp_tab_on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}',
      'html .__sp_tab_count{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      'html .__sp_trashrow{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;border:1px solid transparent}',
      'html .__sp_trashrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      'html .__sp_trashrow_main{flex:1;min-width:0}',
      'html .__sp_trashrow_actions{flex:none;display:flex;align-items:center;gap:6px}',
      'html .__sp_trashrow_actions .__sp_btn{padding:4px 10px;font-size:11.5px}',
      'html .__sp_expiry{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      'html .__sp_expiry_soon{color:var(--dsw-alias-state-warn-primary)}',
      'html .__sp_banner{display:flex;align-items:center;gap:8px;padding:8px 22px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      'html .__sp_page_inner{flex:1;min-height:0;display:flex;flex-direction:column}',
      'html .__sp_row_tag{display:inline-block;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      'html .__sp_tag_warn{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground)}'
    ].join('\n');

    /* ------------------------------------------------------------------ */
    /* utilities                                                          */
    /* ------------------------------------------------------------------ */

    function installStyles() {
      var existing = document.querySelector('style[data-dsh-plugin="' + NS + '"]');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      var node = document.createElement('style');
      node.setAttribute('data-dsh-plugin', NS);
      node.textContent = CSS;
      document.head.appendChild(node);
      return function dispose() {
        try {
          if (node.parentNode) node.parentNode.removeChild(node);
        } catch (error) {
          /* already detached */
        }
      };
    }

    async function api(method, params) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller
        ? setTimeout(function () {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }, 60000)
        : null;
      var response;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ method: method }, params || {})),
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        throw new Error(error && error.name === 'AbortError' ? '请求超时' : String((error && error.message) || error));
      } finally {
        if (timer) clearTimeout(timer);
      }
      var payload = await response.json().catch(function () {
        return {};
      });
      if (!response.ok || payload.ok === false) {
        var failure = new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
        failure.code = payload && payload.code;
        throw failure;
      }
      return payload.data;
    }

    function fmtBytes(value) {
      var size = Number(value) || 0;
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
      return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    /*
     * Mirrors the sidebar's own timestamp wording (「59分钟」/「1小时」/「3天前」),
     * so a row reads the same in the dialog as it does in the sidebar.
     */
    function relTime(ms, lang) {
      var value = Number(ms) || 0;
      if (!value) return '';
      var delta = Date.now() - value;
      if (delta < 0) delta = 0;
      var minute = 60000;
      var hour = minute * 60;
      var day = hour * 24;
      var chinese = lang !== 'en';
      if (delta < minute) return chinese ? '刚刚' : 'just now';
      var count = Math.floor(delta / minute);
      if (delta < hour) return chinese ? count + '分钟' : count + ' min ago';
      count = Math.floor(delta / hour);
      if (delta < day) return chinese ? count + '小时' : count + ' h ago';
      count = Math.floor(delta / day);
      if (delta < day * 30) return chinese ? count + '天前' : count + ' d ago';
      var date = new Date(value);
      return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    }

    function fill(template, params) {
      var text = typeof template === 'string' ? template : String(template == null ? '' : template);
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    function createStore(initial) {
      var state = initial || {};
      var listeners = [];
      return {
        get: function () {
          return state;
        },
        set: function (patch) {
          var next = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch);
          state = next;
          for (var index = 0; index < listeners.length; index += 1) {
            try {
              listeners[index](state);
            } catch (error) {
              /* a broken subscriber must not break the rest */
            }
          }
        },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        }
      };
    }

    function useStore(store) {
      var pair = useState(store.get());
      useEffect(
        function () {
          return store.subscribe(function (next) {
            pair[1](next);
          });
        },
        [store]
      );
      return pair[0];
    }

    function useLocale(locale) {
      var ticket = useState(0);
      useEffect(
        function () {
          if (!locale || typeof locale.subscribe !== 'function') return undefined;
          return locale.subscribe(function () {
            ticket[1](function (value) {
              return value + 1;
            });
          });
        },
        [locale]
      );
      return ticket[0];
    }

    /** The active locale id, so row timestamps can be worded to match it. */
    function useLang(locale) {
      useLocale(locale);
      try {
        if (locale && typeof locale.getLocale === 'function') {
          var current = locale.getLocale();
          return typeof current === 'string' ? current : '';
        }
      } catch {
        /* fall through to the default wording */
      }
      return '';
    }

    function useMountedRef() {
      var ref = useRef(false);
      useEffect(function () {
        ref.current = true;
        return function () {
          ref.current = false;
        };
      }, []);
      return ref;
    }

    /* ------------------------------------------------------------------ */
    /* the sidebar row glyph                                              */
    /* ------------------------------------------------------------------ */

    function PanelGlyph(props) {
      var size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', { d: 'M3 4.6h10', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', {
          d: 'M6.6 4.6V3.5a.9.9 0 0 1 .9-.9h1a.9.9 0 0 1 .9.9v1.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round'
        }),
        h('path', {
          d: 'M4.8 4.6l.5 7.8a1.1 1.1 0 0 0 1.1 1h3.2a1.1 1.1 0 0 0 1.1-1l.5-7.8',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round'
        }),
        h('path', { d: 'M6.9 7.2v4M9.1 7.2v4', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })
      );
    }

    function CheckGlyph() {
      return h(
        'svg',
        { width: 11, height: 11, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M2.5 6.3l2.3 2.3 4.7-4.9', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    /* ------------------------------------------------------------------ */
    /* the page                                                           */
    /* ------------------------------------------------------------------ */

    function SessionRow(props) {
      var row = props.row;
      var t = props.t;
      var selected = Boolean(props.selected);
      var blocked = !row.deletable;
      var tags = [];
      if (row.orphan) tags.push({ key: 'orphan', label: t('tagOrphan'), className: '__sp_tag' });
      if (row.live) tags.push({ key: 'live', label: t('tagLive'), className: '__sp_tag __sp_tag_live' });
      if (row.current) tags.push({ key: 'current', label: t('tagCurrent'), className: '__sp_tag __sp_tag_current' });
      if (row.archived) tags.push({ key: 'archived', label: t('tagArchived'), className: '__sp_tag' });
      if (row.pinned) tags.push({ key: 'pinned', label: t('tagPinned'), className: '__sp_tag' });

      /*
       * Match the sidebar row: a title on the left, a relative time on the
       * right. The sidebar uses the last prompt time, so this does too; rows
       * that never got a prompt (blank / background) fall back to the log mtime.
       */
      var stamp = row.lastPromptAt || row.mtimeMs;
      var when = stamp ? relTime(stamp, props.lang) : '';
      var label = row.title || (row.blank ? t('untitledBlank') : t('untitled'));
      var bench = [row.agentPreset ? row.agentPreset : '', fmtBytes(row.sizeBytes)].filter(Boolean).join(' · ');

      return h(
        'div',
        {
          className: '__sp_row' + (row.blank ? ' __sp_row_blank' : ''),
          role: 'checkbox',
          tabIndex: blocked ? -1 : 0,
          'aria-checked': selected ? 'true' : 'false',
          'aria-disabled': blocked ? 'true' : 'false',
          title: [label, row.dirPath].filter(Boolean).join('\n'),
          onClick: function () {
            if (blocked) {
              props.onBlocked(row);
              return;
            }
            props.onToggle(row.id);
          },
          onKeyDown: function (event) {
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            event.preventDefault();
            if (blocked) {
              props.onBlocked(row);
              return;
            }
            props.onToggle(row.id);
          }
        },
        h('span', { className: '__sp_box' }, selected ? h(CheckGlyph, null) : null),
        h(
          'span',
          { className: '__sp_row_main' },
          h('span', { className: '__sp_row_title' }, label),
          tags.length > 0 || bench
            ? h(
                'span',
                { className: '__sp_row_meta' },
                tags.length > 0
                  ? tags.map(function (tag) {
                      return h('span', { key: tag.key, className: tag.className }, tag.label);
                    })
                  : null,
                bench ? h('span', { className: '__sp_row_bench' }, bench) : null
              )
            : null
        ),
        when ? h('span', { className: '__sp_row_when' }, when) : null
      );
    }

    function PurgePage(props) {
      var t = props.t;
      var ctx = props.ctx;
      var store = props.store;
      var state = useStore(store);
      var alive = useMountedRef();
      var lang = useLang(ctx && ctx.locale);

      var runLoad = useCallback(
        function (silent) {
          var orphans = Boolean(store.get().showOrphans);
          if (!silent) store.set({ phase: 'loading', error: '' });
          api('list', { includeOrphans: orphans })
            .then(function (data) {
              if (!alive.current) return;
              var previous = store.get().selected || {};
              var kept = {};
              var rows = Array.isArray(data.sessions) ? data.sessions : [];
              for (var index = 0; index < rows.length; index += 1) {
                var row = rows[index];
                if (previous[row.id] && row.deletable) kept[row.id] = true;
              }
              store.set({ phase: 'ready', data: data, selected: kept, error: '' });
            })
            .catch(function (error) {
              if (!alive.current) return;
              store.set({ phase: 'error', error: String((error && error.message) || error) });
            });
        },
        [store, alive]
      );

      useEffect(
        function () {
          if (store.get().phase === 'idle') runLoad(false);
        },
        [store, runLoad]
      );

      /* A successful purge parks the page on `stale` so it re-reads the list. */
      useEffect(
        function () {
          if (state.phase === 'stale') runLoad(true);
        },
        [state.phase, runLoad]
      );

      var data = state.data;
      var rows = data && Array.isArray(data.sessions) ? data.sessions : [];
      var selected = state.selected || {};
      var deletableRows = rows.filter(function (row) {
        return row.deletable;
      });
      var selectedRows = rows.filter(function (row) {
        return Boolean(selected[row.id]);
      });
      var selectedBytes = selectedRows.reduce(function (sum, row) {
        return sum + (Number(row.sizeBytes) || 0);
      }, 0);
      var allSelected = deletableRows.length > 0 && selectedRows.length === deletableRows.length;

      var toggle = useCallback(
        function (id) {
          var next = Object.assign({}, store.get().selected || {});
          if (next[id]) delete next[id];
          else next[id] = true;
          store.set({ selected: next });
        },
        [store]
      );

      var toggleAll = useCallback(
        function () {
          var current = store.get();
          var list = current.data && Array.isArray(current.data.sessions) ? current.data.sessions : [];
          var usable = list.filter(function (row) {
            return row.deletable;
          });
          var picked = current.selected || {};
          var every = usable.length > 0 && usable.every(function (row) {
            return Boolean(picked[row.id]);
          });
          var next = {};
          if (!every) {
            for (var index = 0; index < usable.length; index += 1) next[usable[index].id] = true;
          }
          store.set({ selected: next });
        },
        [store]
      );

      var notify = useCallback(
        function (kind, text) {
          store.set({ toast: { kind: kind, text: text, at: Date.now() } });
        },
        [store]
      );

      var onBlocked = useCallback(
        function (row) {
          notify('error', row.live ? t('liveBlocked') : t('currentBlocked'));
        },
        [notify, t]
      );

      var openConfirm = function () {
        if (selectedRows.length === 0) return;
        store.set({ confirmOpen: true });
      };

      var header = h(
        'div',
        { className: '__sp_head' },
        h(
          'div',
          { className: '__sp_head_text' },
          h('h1', { className: '__sp_h1' }, t('title')),
          h('p', { className: '__sp_sub' }, t('subtitle'))
        ),
        h(
          'div',
          { className: '__sp_head_actions' },
          h(
            'button',
            {
              type: 'button',
              className: '__sp_btn',
              onClick: toggleAll,
              disabled: state.phase !== 'ready' || deletableRows.length === 0,
              title: allSelected ? t('clearAll') : t('selectAll'),
              'aria-pressed': allSelected ? 'true' : 'false'
            },
            allSelected ? t('clearAll') : t('selectAll')
          ),
          h(
            'button',
            {
              type: 'button',
              className: '__sp_btn',
              onClick: function () {
                runLoad(false);
              },
              disabled: state.phase === 'loading' || state.busy
            },
            t('refresh')
          )
        )
      );

      var body;
      if (state.phase === 'loading' && !data) {
        body = h('div', { className: '__sp_placeholder' }, h('span', null, t('loading')));
      } else if (state.phase === 'error' && !data) {
        body = h(
          'div',
          { className: '__sp_placeholder' },
          h('span', null, t('loadFailed') + '：' + state.error),
          h(
            'button',
            {
              type: 'button',
              className: '__sp_btn',
              onClick: function () {
                runLoad(false);
              }
            },
            t('retry')
          )
        );
      } else if (rows.length === 0) {
        body = h('div', { className: '__sp_placeholder' }, h('span', null, t('empty')));
      } else {
        var groups = data && Array.isArray(data.groups) ? data.groups : [];
        var multiGroup = groups.length > 1;
        body = h(
          'div',
          { className: '__sp_body' },
          groups.map(function (group) {
            return h(
              'div',
              { className: '__sp_group', key: group.id },
              multiGroup || group.orphan
                ? h(
                    'div',
                    { className: '__sp_group_head' },
                    h(
                      'span',
                      { className: '__sp_group_title' },
                      group.title || t('groupUnknown')
                    ),
                    group.path ? h('span', { className: '__sp_group_path' }, group.path) : null,
                    h('span', null, String(group.sessions.length))
                  )
                : null,
              group.sessions.map(function (row) {
                return h(SessionRow, {
                  key: row.id,
                  row: row,
                  t: t,
                  lang: lang,
                  selected: Boolean(selected[row.id]),
                  onToggle: toggle,
                  onBlocked: onBlocked
                });
              })
            );
          })
        );
      }

      var foot = h(
        'div',
        { className: '__sp_foot' },
        h(
          'div',
          { className: '__sp_foot_text' },
          selectedRows.length === 0
            ? fill(t('summaryNone'), { total: rows.length })
            : fill(t('summarySome'), { n: selectedRows.length, total: rows.length, bytes: fmtBytes(selectedBytes) })
        ),
        h(
          'button',
          {
            type: 'button',
            className: '__sp_btn __sp_solidDanger',
            disabled: selectedRows.length === 0 || Boolean(state.busy),
            onClick: openConfirm
          },
          t('delete')
        )
      );

      /*
       * Sessions on disk that no workspace claims are real residue, but they are
       * not what the sidebar shows. They stay behind an explicit toggle so the
       * list matches the sidebar by default and the extra rows are opt-in.
       */
      var orphanCount = Number(data && data.orphanCount) || 0;
      var orphanBytes = Number(data && data.orphanBytes) || 0;
      var caption = h(
        'div',
        { className: '__sp_caption' },
        h('span', { className: '__sp_caption_hint' }, t('columnHint')),
        orphanCount > 0
          ? h(
              'button',
              {
                type: 'button',
                className: '__sp_link' + (state.showOrphans ? ' __sp_link_on' : ''),
                onClick: function () {
                  store.set({ showOrphans: !store.get().showOrphans });
                  runLoad(true);
                }
              },
              state.showOrphans
                ? t('orphansHide')
                : fill(t('orphansShow'), { n: orphanCount, bytes: fmtBytes(orphanBytes) })
            )
          : null
      );

      var trashRows = state.trash && Array.isArray(state.trash.entries) ? state.trash.entries : [];
      var trashCount = trashRows.length;
      var retentionDays = Number(state.trash && state.trash.retentionDays) || 30;

      var tabs = h(
        'div',
        { className: '__sp_tabs', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: '__sp_tab' + (state.tab === 'sessions' ? ' __sp_tab_on' : ''),
            'aria-selected': state.tab === 'sessions' ? 'true' : 'false',
            onClick: function () {
              if (store.get().tab === 'sessions') return;
              store.set({ tab: 'sessions', selected: {} });
            }
          },
          t('tabSessions'),
          h('span', { className: '__sp_tab_count' }, String(rows.length))
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: '__sp_tab' + (state.tab === 'trash' ? ' __sp_tab_on' : ''),
            'aria-selected': state.tab === 'trash' ? 'true' : 'false',
            onClick: function () {
              if (store.get().tab === 'trash') return;
              store.set({ tab: 'trash', selected: {}, trashPhase: 'idle', trashToken: (store.get().trashToken || 0) + 1 });
            }
          },
          t('tabTrash'),
          trashCount > 0 ? h('span', { className: '__sp_tab_count' }, String(trashCount)) : null
        )
      );

      if (state.tab === 'trash') {
        return h(
          'div',
          { className: '__sp_page' },
          header,
          tabs,
          h(TrashView, { t: t, lang: lang, state: state, store: store, notify: notify })
        );
      }

      return h(
        'div',
        { className: '__sp_page' },
        header,
        tabs,
        caption,
        body,
        foot
      );
    }

    /* ------------------------------------------------------------------ */
    /* recycle bin view                                                   */
    /* ------------------------------------------------------------------ */

    /*
     * Restored rows are the only reversible operation this plugin has, so the
     * bin view is deliberately plain: one row per entry, two buttons, no
     * selection machinery. Purging is still gated behind the same red confirm
     * dialog the delete flow uses.
     */
    function TrashView(props) {
      var t = props.t;
      var lang = props.lang;
      var state = props.state;
      var store = props.store;
      var notify = props.notify;

      var loadTrash = useCallback(
        function (silent) {
          if (!silent) store.set({ trashPhase: 'loading', trashError: '' });
          api('trashList', {})
            .then(function (data) {
              store.set({ trashPhase: 'ready', trash: data, trashError: '' });
            })
            .catch(function (error) {
              store.set({ trashPhase: 'error', trashError: String((error && error.message) || error) });
            });
        },
        [store]
      );

      /*
       * `trashToken` is bumped by whoever changes the bin (page, restore, purge,
       * empty). Keying the effect on it means the list re-reads itself, instead
       * of showing stale rows until the panel is closed and reopened.
       */
      useEffect(
        function () {
          loadTrash(false);
        },
        [state.trashToken, loadTrash]
      );

      var restoreOne = function (entry) {
        store.set({ trashBusy: entry.entryId, trashError: '' });
        api('restore', { entryIds: [entry.entryId] })
          .then(function (result) {
            var done = Array.isArray(result.restored) ? result.restored.length : 0;
            var warned = [];
            for (var index = 0; index < (result.restored || []).length; index += 1) {
              for (var w = 0; w < ((result.restored[index] || {}).warnings || []).length; w += 1) {
                warned.push(result.restored[index].warnings[w]);
              }
            }
            for (var f = 0; f < (result.failed || []).length; f += 1) {
              warned.push(((result.failed[f] || {}).warnings || []).join('；'));
            }
            store.set({ trashBusy: '' });
            notify(
              done > 0 && warned.length === 0 ? 'ok' : 'error',
              fill(t('restoreDone'), { n: done }) + (warned.length > 0 ? ' · ' + warned.join('；') : '')
            );
            setTimeout(function () {
              store.set({ trashPhase: 'idle', phase: 'stale', trashToken: (store.get().trashToken || 0) + 1 });
            }, 0);
          })
          .catch(function (error) {
            store.set({ trashBusy: '', trashError: String((error && error.message) || error) });
          });
      };

      var askPurge = function (entry) {
        store.set({ confirmOpen: true, confirmMode: 'purgeForever', confirmEntry: entry });
      };

      var askEmpty = function () {
        store.set({ confirmOpen: true, confirmMode: 'emptyTrash', confirmEntry: null });
      };

      var rows = state.trash && Array.isArray(state.trash.entries) ? state.trash.entries : [];
      var totalBytes = Number(state.trash && state.trash.totalBytes) || 0;
      var retention = Number(state.trash && state.trash.retentionDays) || 30;

      var head = h(
        'div',
        { className: '__sp_caption' },
        h('span', { className: '__sp_caption_hint' }, t('trashIntro')),
        rows.length > 0
          ? h(
              'button',
              { type: 'button', className: '__sp_link', onClick: askEmpty },
              t('trashEmpty')
            )
          : null
      );

      var body;
      if (state.trashPhase === 'loading' && !state.trash) {
        body = h('div', { className: '__sp_placeholder' }, h('span', null, t('loading')));
      } else if (state.trashPhase === 'error' && !state.trash) {
        body = h(
          'div',
          { className: '__sp_placeholder' },
          h('span', null, t('loadFailed') + '：' + state.trashError),
          h(
            'button',
            { type: 'button', className: '__sp_btn', onClick: function () { loadTrash(false); } },
            t('retry')
          )
        );
      } else if (rows.length === 0) {
        body = h(
          'div',
          { className: '__sp_placeholder' },
          h('span', null, t('trashEmptyHint')),
          h('span', { className: '__sp_caption_hint' }, fill(t('trashSweepNote'), { days: retention }))
        );
      } else {
        body = h(
          'div',
          { className: '__sp_body' },
          rows.map(function (entry) {
            var when = Number(entry.deletedAt) || 0;
            var daysLeft = Math.max(0, Math.ceil((Number(entry.expiresAt) - Date.now()) / 86400000));
            return h(
              'div',
              { className: '__sp_trashrow', key: entry.entryId },
              h(
                'div',
                { className: '__sp_trashrow_main' },
                h(
                  'div',
                  { className: '__sp_row_title' },
                  entry.title || t('untitled')
                ),
                h(
                  'div',
                  { className: '__sp_row_meta' },
                  h('span', { className: '__sp_row_tag' }, fill(t('trashedAt'), { when: relTime(when, lang) })),
                  h('span', null, fmtBytes(entry.bytes)),
                  entry.missing
                    ? h('span', { className: '__sp_row_tag __sp_tag_warn' }, '文件缺失')
                    : h(
                        'span',
                        {
                          className:
                            '__sp_expiry' + (daysLeft <= 3 ? ' __sp_expiry_soon' : '')
                        },
                        daysLeft <= 0
                          ? t('expiresToday')
                          : fill(t('expiresAt'), { n: daysLeft })
                      )
                )
              ),
              h(
                'div',
                { className: '__sp_trashrow_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: '__sp_btn',
                    disabled: state.trashBusy === entry.entryId || Boolean(entry.missing),
                    onClick: function () {
                      restoreOne(entry);
                    }
                  },
                  t('restore')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: '__sp_btn __sp_solidDanger',
                    disabled: state.trashBusy === entry.entryId,
                    onClick: function () {
                      askPurge(entry);
                    }
                  },
                  t('purgeForever')
                )
              )
            );
          })
        );
      }

      var foot = h(
        'div',
        { className: '__sp_foot' },
        h(
          'div',
          { className: '__sp_foot_text' },
          rows.length === 0
            ? t('trashEmptyHint')
            : fill(t('summaryTrash'), { total: rows.length, bytes: fmtBytes(totalBytes) })
        ),
        rows.length > 0
          ? h(
              'button',
              { type: 'button', className: '__sp_btn __sp_solidDanger', onClick: askEmpty },
              t('trashEmpty')
            )
          : null
      );

      return h('div', { className: '__sp_page_inner' }, head, body, foot);
    }

    /* ------------------------------------------------------------------ */
    /* confirmation dialog                                                */
    /* ------------------------------------------------------------------ */

    function ConfirmHost(props) {
      var t = props.t;
      var ctx = props.ctx;
      var store = props.store;
      var state = useStore(store);
      var open = Boolean(state.confirmOpen);
      var dialogRef = useRef(null);
      var cancelRef = useRef(null);

      var rows = (state.data && Array.isArray(state.data.sessions) ? state.data.sessions : []).filter(function (row) {
        return Boolean(state.selected && state.selected[row.id]);
      });

      var close = useCallback(
        function () {
          if (store.get().busy) return;
          store.set({ confirmOpen: false, confirmMode: '', confirmEntry: null, error: '' });
        },
        [store]
      );

      useEffect(
        function () {
          if (!open) return undefined;
          var node = dialogRef.current;
          var previous = document.activeElement;
          if (cancelRef.current) {
            try {
              cancelRef.current.focus();
            } catch (error) {
              /* ignore */
            }
          }
          var onKeyDown = function (event) {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key !== 'Tab' || !node) return;
            var focusable = node.querySelectorAll('button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0) return;
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          };
          document.addEventListener('keydown', onKeyDown, true);
          return function () {
            document.removeEventListener('keydown', onKeyDown, true);
            try {
              if (previous && typeof previous.focus === 'function') previous.focus();
            } catch (error) {
              /* ignore */
            }
          };
        },
        [open, close]
      );

      var confirm = function () {
        if (store.get().busy) return;

        /* ── bin: purge one entry ─────────────────────────────────────── */
        if (state.confirmMode === 'purgeForever') {
          var entry = state.confirmEntry;
          if (!entry || !entry.entryId) {
            store.set({ confirmOpen: false, confirmMode: '', confirmEntry: null });
            return;
          }
          store.set({ busy: true, error: '' });
          api('purgeForever', { entryIds: [entry.entryId], confirm: true })
            .then(function (result) {
              var done = Array.isArray(result.destroyed) ? result.destroyed.length : 0;
              var bytes = Number(result.bytes) || 0;
              var parts = [fill(t('purgeForeverDone'), { n: done })];
              if (bytes > 0) parts.push(fill(t('doneBytes'), { bytes: fmtBytes(bytes) }));
              var attachments = result.attachments && Number(result.attachments.removed);
              if (attachments > 0) parts.push((result.attachments.notes || []).join('；'));
              var problems = (Array.isArray(result.failed) ? result.failed : []).map(function (item) {
                return (item.warnings || []).join('；');
              });
              if (problems.length > 0) parts.push(problems.join('；'));
              store.set({
                busy: false,
                confirmOpen: false,
                confirmMode: '',
                confirmEntry: null,
                error: '',
                toast: {
                  kind: problems.length === 0 ? 'ok' : 'error',
                  text: parts.join(' · '),
                  at: Date.now()
                }
              });
              setTimeout(function () {
                store.set({ trashPhase: 'idle', phase: 'stale', trashToken: (store.get().trashToken || 0) + 1 });
              }, 0);
            })
            .catch(function (error) {
              store.set({ busy: false, error: String((error && error.message) || error) });
            });
          return;
        }

        /* ── bin: empty everything ────────────────────────────────────── */
        if (state.confirmMode === 'emptyTrash') {
          store.set({ busy: true, error: '' });
          api('emptyTrash', { confirm: true })
            .then(function (result) {
              var done = Array.isArray(result.destroyed) ? result.destroyed.length : 0;
              var bytes = Number(result.bytes) || 0;
              var problems = (Array.isArray(result.failed) ? result.failed : []).map(function (item) {
                return (item.warnings || []).join('；');
              });
              var parts = [fill(t('purgeForeverDone'), { n: done })];
              if (bytes > 0) parts.push(fill(t('doneBytes'), { bytes: fmtBytes(bytes) }));
              if (problems.length > 0) parts.push(problems.join('；'));
              store.set({
                busy: false,
                confirmOpen: false,
                confirmMode: '',
                confirmEntry: null,
                error: '',
                toast: {
                  kind: problems.length === 0 ? 'ok' : 'error',
                  text: parts.join(' · '),
                  at: Date.now()
                }
              });
              setTimeout(function () {
                store.set({ trashPhase: 'idle', phase: 'stale', trashToken: (store.get().trashToken || 0) + 1 });
              }, 0);
            })
            .catch(function (error) {
              store.set({ busy: false, error: String((error && error.message) || error) });
            });
          return;
        }

        /* ── default: move the selection into the bin ─────────────────── */
        var ids = rows.map(function (row) {
          return row.id;
        });
        if (ids.length === 0) {
          store.set({ confirmOpen: false });
          return;
        }
        store.set({ busy: true, error: '' });
        api('trash', { sessionIds: ids, confirm: true })
          .then(function (result) {
            var trashed = Array.isArray(result.trashed) ? result.trashed.length : 0;
            var remaining = Array.isArray(result.remaining) ? result.remaining.length : 0;
            var failed = Array.isArray(result.failed) ? result.failed.length : 0;
            var parts = [fill(t('trashedTitle'), { n: trashed })];
            if (result.bytes) parts.push(fill(t('doneBytes'), { bytes: fmtBytes(result.bytes) }));
            if (failed > 0) {
              parts.push(
                result.failed
                  .map(function (entry) {
                    return String(entry.id).slice(0, 12) + '：' + (entry.warnings || []).join('；');
                  })
                  .join('\n')
              );
            }
            /* A ledger that lost its race with the Host shows up as a scolding
               note rather than as leftover rows, so treat it as a failure too. */
            var ledgerProblems = (Array.isArray(result.ledgers) ? result.ledgers : []).filter(function (note) {
              return String(note).indexOf('失败') >= 0;
            });
            if (ledgerProblems.length > 0) parts.push(ledgerProblems.join('；'));
            var clean = remaining === 0 && failed === 0 && ledgerProblems.length === 0;
            store.set({
              busy: false,
              confirmOpen: false,
              confirmMode: '',
              confirmEntry: null,
              error: '',
              selected: {},
              toast: { kind: clean ? 'ok' : 'error', text: parts.join(' · '), at: Date.now() }
            });
            try {
              if (ctx.sessions && typeof ctx.sessions.refresh === 'function') ctx.sessions.refresh();
            } catch (error) {
              /* best effort */
            }
            setTimeout(function () {
              store.set({ phase: 'stale', trashPhase: 'idle', trashToken: (store.get().trashToken || 0) + 1 });
            }, 0);
          })
          .catch(function (error) {
            store.set({ busy: false, error: String((error && error.message) || error) });
          });
      };

      if (!open) return null;

      var binMode = state.confirmMode === 'purgeForever' || state.confirmMode === 'emptyTrash';

      if (binMode) {
        var entryRow = state.confirmEntry;
        var title =
          state.confirmMode === 'emptyTrash'
            ? t('trashEmptyTitle')
            : t('purgeForeverTitle');
        var bodyText =
          state.confirmMode === 'emptyTrash'
            ? fill(t('trashEmptyBody'), { n: (state.trash && state.trash.entries ? state.trash.entries.length : 0) })
            : t('purgeForeverBody');
        return h(
          'div',
          {
            className: '__sp_mask',
            onMouseDown: function (event) {
              if (event.target !== event.currentTarget) return;
              close();
            }
          },
          h(
            'div',
            {
              className: '__sp_dialog',
              ref: dialogRef,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': '__sp_dialog_title'
            },
            h('div', { className: '__sp_dialog_title', id: '__sp_dialog_title' }, title),
            h('div', { className: '__sp_dialog_body' }, bodyText),
            entryRow
              ? h('ul', { className: '__sp_dialog_list' }, h('li', null, entryRow.title || t('untitled')))
              : null,
            state.error ? h('div', { className: '__sp_dialog_error' }, state.error) : null,
            h(
              'div',
              { className: '__sp_dialog_actions' },
              h(
                'button',
                { type: 'button', className: '__sp_btn', ref: cancelRef, disabled: Boolean(state.busy), onClick: close },
                t('cancel')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: '__sp_btn __sp_solidDanger',
                  disabled: Boolean(state.busy),
                  onClick: confirm
                },
                state.busy ? t('purging') : t('confirm')
              )
            )
          )
        );
      }

      var preview = rows.slice(0, 6);
      var more = rows.length - preview.length;

      return h(
        'div',
        {
          className: '__sp_mask',
          onMouseDown: function (event) {
            if (event.target !== event.currentTarget) return;
            close();
          }
        },
        h(
          'div',
          {
            className: '__sp_dialog',
            ref: dialogRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': '__sp_dialog_title'
          },
          h('div', { className: '__sp_dialog_title', id: '__sp_dialog_title' }, t('dialogTitle')),
          h(
            'div',
            { className: '__sp_dialog_body' },
            rows.length > 1 ? fill(t('dialogBodyMany'), { n: rows.length }) : t('dialogBodyOne')
          ),
          preview.length > 0
            ? h(
                'ul',
                { className: '__sp_dialog_list' },
                preview.map(function (row, index) {
                  return h('li', { key: row.id || index }, row.title || t('untitled'));
                }),
                more > 0 ? h('li', { key: '__more' }, fill(t('dialogMore'), { n: more })) : null
              )
            : null,
          h('div', { className: '__sp_dialog_scope' }, t('dialogScope')),
          h('div', { className: '__sp_dialog_scope' }, t('dialogKeep')),
          state.error ? h('div', { className: '__sp_dialog_error' }, state.error) : null,
          h(
            'div',
            { className: '__sp_dialog_actions' },
            h(
              'button',
              {
                type: 'button',
                className: '__sp_btn',
                ref: cancelRef,
                disabled: Boolean(state.busy),
                onClick: close
              },
              t('cancel')
            ),
            h(
              'button',
              {
                type: 'button',
                className: '__sp_btn __sp_solidDanger',
                disabled: Boolean(state.busy),
                onClick: confirm
              },
              state.busy ? t('deleting') : t('confirm')
            )
          )
        )
      );
    }

    /* ------------------------------------------------------------------ */
    /* result toast                                                       */
    /* ------------------------------------------------------------------ */

    function ToastHost(props) {
      var store = props.store;
      var state = useStore(store);
      var toast = state.toast;

      useEffect(
        function () {
          if (!toast) return undefined;
          var timer = setTimeout(function () {
            store.set({ toast: null });
          }, 6000);
          return function () {
            clearTimeout(timer);
          };
        },
        [toast, store]
      );

      if (!toast) return null;
      return h(
        'div',
        {
          className: '__sp_toast' + (toast.kind === 'error' ? ' __sp_toast_error' : ''),
          role: 'status',
          'aria-live': 'polite'
        },
        h('span', { className: '__sp_toast_dot' }),
        h('span', { style: { whiteSpace: 'pre-wrap' } }, toast.text)
      );
    }

    /* ------------------------------------------------------------------ */
    /* plugin entry                                                       */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      var disposeStyles = installStyles();
      ctx.effect(function () {
        return disposeStyles;
      }, NS + ': styles');

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, NS + ': dictionaries');

      var t = ctx.locale.bind(NS);
      var store = createStore({
        phase: 'idle',
        data: null,
        error: '',
        selected: {},
        confirmOpen: false,
        busy: false,
        toast: null,
        showOrphans: false,
        /* recycle bin */
        tab: 'sessions',
        trashPhase: 'idle',
        trashToken: 0,
        trash: null,
        trashError: '',
        trashBusy: '',
        confirmMode: '',
        confirmEntry: null
      });

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: ORDER, label: t('label'), locale: NS },
          PanelGlyph
        );
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function PurgePageBound() {
          useLocale(ctx.locale);
          return h(PurgePage, { t: t, ctx: ctx, store: store });
        });
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'session-purge.dialog', locale: NS }, function DialogBound() {
          useLocale(ctx.locale);
          return h(ConfirmHost, { t: t, ctx: ctx, store: store });
        });
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'session-purge.toast', locale: NS }, function ToastBound() {
          useLocale(ctx.locale);
          return h(ToastHost, { t: t, ctx: ctx, store: store });
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
