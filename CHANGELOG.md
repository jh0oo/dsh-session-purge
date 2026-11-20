# 更新日志

本文件记录 **dsh-session-purge**（DSH 插件：删除会话）的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.10] - 2026-11-20

### 修复 —— 彻底删除、还原之后列表不刷新

回收站页签读列表的那个 `useEffect` 只依赖 `[store, loadTrash]`，两者在组件生命周期里都是
稳定引用，所以它实际只在挂载时跑一次。之后 `purgeForever` / `emptyTrash` / `restore` 虽然把
store 改成 `trashPhase: 'idle'` 并触发重渲染，组件却不会再去问一次列表 —— 已删的行要等用户
关掉面板、重新点进「删除会话」才会消失。

现在引入递增的 `trashToken`：凡是改动回收站的地方（切到回收站页签、还原、彻底删除、清空）
都把它 `+1`，`TrashView` 的 effect 依赖 `state.trashToken`。效果是操作完成即可看到列表变成
它应有的样子，不必退出重进。

## [0.1.9] - 2026-11-19

### 补齐上架元数据

纯元数据版本，不含行为变更。`repository` / `homepage` / `bugs` 指向
`github.com/jh0oo/dsh-session-purge`，`author` 与 `dshhub` 块就位（分类 `session`、
中英双语 `displayName` / `summary`、声明能力 `fs-read` `fs-write` `network` 与三条红线）。
市场条目草稿见 `marketplace-entry.json`。

## [0.1.8] - 2026-11-19

### 修复 —— 还原时不再把宿主进程打死（第六次启动崩溃的根因）

`restore()` 调用 `target.attachSession(entry.id)` 时**没有 `await`**。该方法是 async，
当宿主认不出这个会话时它会 `throw`（`dsh-workspace/lib/index.js:113` →
`readSessionHeader` `:933`，`cannot validate session '…': session persistence holds no
such session`）。未 await 的调用让这个 rejection 绕过了外层 `try/catch`，以
unhandled rejection 的形式打到宿主进程 —— 于是下次启动或当场就是
`dsh: fatal load failure`。

`detachFromRegistry()` 里有同一类错误：它裸调 async 的 `entity.detachSession()`。
两处都已补 `await`，`detachFromRegistry()` 本身也改为 `async`（两个调用点同步补 await）。

### 新增 —— `hostKnows()`：不认识的会话不往侧栏塞

即使补了 `await`，给一个持久化目录里从未出现过的 id 调 `attachSession` 也是**必然
抛错**。还原字节永远安全，把它宣告给侧栏则不是。所以 `restore()` 现在先问
`ctx.sessionPersistence.stat(id)`，宿主不认识就只还原文件、跳过挂载，并在提示里说明
「会话文件已还原，但宿主索引里没有它的记录，未自动放回侧栏（重启后会按磁盘重新收录）」。

### 新增 —— `test/restore-unknown.test.mjs`（23 条断言）

钉死三件事：① 宿主不认识的 id 绝不传给 `attachSession`；② 宿主认识的会话仍正常挂载；
③ 一个真的会 reject 的 `attachSession` 被 `await` 接住并降级为警告，而不是变成
unhandled rejection。已用「把 `await` 拿掉」的方式反向验证过：该测试立刻报
`the rejection did not escape as unhandled` 失败。

### 校验

- 七套测试：`atomic(26) + schedule(21) + trash(59) + order(18) + e2e(47) + guard(17) + restore-unknown(23)` = **211 条断言全过**
- `node --check` 全部源码通过
- 真实 home：`auditclean.mjs` → `STORE IS CONSISTENT`（ORPHAN 0 / DANGLING 0 / TEMP 0 / EMPTY SLUG 0）；`repair-ledger.mjs` → `NOTHING TO REPAIR`

## [0.1.7] - 2026-11-19

### 修复 —— 除名失败时不再「继续删字节」

0.1.6 把删除顺序改成了「先除名、后删字节」，但除名的实现是 `detachFromRegistry`，它按设计
吞掉所有宿主拒绝（`try { … } catch { /* 稍后重写账本兜底 */ }`）。于是出现一条仍会崩机的路径：
宿主拒绝除名 → 函数静默返回成功 → 调用方照样移动或删除字节 → 登记表留着 id、日志没了 →
下次启动 fatal。

- 新增 `stillRegistered(sessionId)`：直接读 registry 反查，`registry.list()` 本身抛错时
  **返回 true**（无法证明已除名即视为仍登记，安全那一侧倒）。
- 新增 `forceDetach(homePath, sessionId)`：绕过宿主 API，直接原子重写磁盘账本。
- `purge` / `trash` 在移动字节前检查：仍登记 → 先 `forceDetach` → 再查一次 → 仍登记就
  **放弃这个会话**并报告 `登记表仍登记该会话，已放弃删除以免下次启动失败`（`code: registered`，HTTP 409）。
- 取舍：宁可留下一个删不掉的会话，也不制造一个让人开不了机的状态。

### 新增 —— `tools/repair-ledger.mjs` 急救脚本

插件本身救不了「已经起不来」的机器（插件要等宿主启动完成才加载），宿主
`recoverPendingMutation` 又只处理未完成的工作区创建。所以新增一个**不依赖插件运行**的
终端脚本：

- 剔除 `workspace.json` 里日志已不存在的成员（含 archived / pinned）。
- 清理 `session_projcache` 与 `vision_router_session_policy` 里指向不存在会话的记录，
  含宿主 `invalidRecords: 'backup-and-skip'` 产生的 `.bak.<stamp>` 变体。
- 清理空会话目录与空 slug 目录。
- 写入走 `.tmp` + 退避重试 + 原子改名；退出码 0/1/2/3 分别表示干净、可修未修、路径不对、异常。

### 新增 —— `test/guard.test.mjs`（17 条断言）

用一个「拒绝除名」的假 registry 复现上面那条崩溃路径，断言：字节没有移动、回收站里没有
半成品、磁盘账本仍被强制修好、下一次启动不会看到悬挂登记。

### 修复 —— 测试里的「真实 profile 未被触碰」断言过强

原来断言 `~/.dsh/storages/dsh-session-purge` 不存在，一旦用户真的用过回收站功能就必然失败。
改为按**本次测试的会话 id** 回查真实 profile，这才是真正的不变式。

### 校验

```
atomic(26) + schedule(21) + trash(59) + order(18) + e2e(47) + guard(17) = 188 条断言全过
auditclean.mjs  : ORPHAN 0 / DANGLING 0 / TEMP 0 / EMPTY SLUG 0 → STORE IS CONSISTENT
repair-ledger   : NOTHING TO REPAIR
```

## [0.1.6] - 2026-11-19

### 修复 —— 删除顺序（启动崩溃的根因）

这一版修的是**一个会让应用起不来的 bug**，不是体验问题。

- **症状**：删会话的过程中应用被打断（断电、杀进程、崩溃、我们自己测试脚本超时退出）后，
  下次启动直接失败，报
  `dsh: fatal load failure: Error: cannot validate session '<id>': session persistence holds no such session`，
  堆栈指向 `WorkspaceRegistry.readSessionHeader` → `WorkspaceEntity.attachSession`。
- **根因**：原来的顺序是「先删字节、后清登记表」。宿主启动时会遍历工作区登记表里的每个成员，
  逐个读会话头做校验；一旦登记表里还留着 id、而它的日志已经被删掉，这个校验就会抛错，
  而宿主把它当成 fatal。反过来（日志没了、登记表没这行）只是孤儿日志，无害且可清扫。
  **两侧不对称，所以顺序不能反**。
- **修复**：`purge` 与 `trash` 都改为
  `宿主释放 → 登记表除名 → 投影缓存/会话策略 → 会话目录（或移入回收站）`。
  `restore` 方向同理：先还原字节，再 `attachSession` 把登记补回去。
- **回归测试**：新增 `test/order.test.mjs`（18 条断言）。它不只验证终态，而是在
  `detachSession` 被调用的那一瞬间回查会话日志是否还在磁盘上——这条断言在修复前必然失败，
  正是它把「顺序」而不是「结果」固定了下来。

### 修复 —— `.bak` 变体残留

- 投影缓存遇到无法解析的记录时，宿主会把它改名成 `<key>.json.bak.<stamp>` 留在原地
  （`@deepseek-ai/dsh-session-projection-cache` 的 `invalidRecords: 'backup-and-skip'`）。
  原来的清理只删 `<key>.json`，于是被删会话的标题、工作目录仍以 `.bak` 文件留在磁盘上。
- `removeProjectionCache` / `removePolicyRecord` 改为经 `removeRecordVariants` 处理，
  用 `readdir` 匹配 `<key>.json` 与所有 `<key>.json.*` 变体。

### 修复 —— 回收站丢失工作区位置

- 顺序调整后 `placeOf()` 在登记表除名之后才调用，导致回收站条目记录成
  `{"workspaceId":"","index":-1}`，还原时无法回到原工作区。
- 改为在动登记表**之前**先快照全部 `placeOf` / `flagsOf`，循环里改用快照。
  这条由 `test/trash.test.mjs` 的「entry keeps the workspace slot」断言守住。

### 校验

- `atomic` 26、`schedule` 21、`trash` 59、`order` 18、`e2e` 47 —— 共 171 条断言全过。
- `_scratch/auditclean.mjs` 复跑：`ORPHAN 0 / DANGLING 0 / TEMP 0 / EMPTY SLUG 0`，
  221 个会话目录与 221 个投影缓存严格 1:1。

## [0.1.5] - 2026-11-19

### 新增 —— 回收站

删除会话不再只有「立刻销毁」一条路：新增回收站，删掉的会话先躺进去，想清楚再决定。

- **回收站**：新增 `trash`，把选中的会话移入
  `$DSH_HOME/storages/dsh-session-purge/trash`，回收站条目记录删除时间、标题、
  原始工作区位置、体积，以及附件与账本的清理情况。
- **可还原**：`restore` 把回收站条目原样搬回 `~/.dsh/sessions/<slug>/<id>/`，
  连同投影缓存与会话策略一起，字节完全一致；并向工作区登记重新挂上该会话，
  恢复它原来的归档 / 置顶状态，会话重新出现在侧边栏，标题不变。
  **不还原的**：成本记账、上下文概览缓存与定时任务引用——这些在移入回收站时
  已经清理，还原不会逆向补回（记账是账户历史，重写它反而会造假账）。
- **可彻底删除**：`purgeForever` 对回收站条目执行真正的硬删除，
  语义等同 0.1.4 及更早版本的 `purge`；`emptyTrash` 一次清空整个回收站。
- **默认保留 30 天**：回收站条目的 `expiresAt = deletedAt + retentionDays`，
  默认 `retentionDays = 30`（`RETENTION_DEFAULT_DAYS`），可通过插件配置项
  `trashRetentionDays` 调整，取值被夹在 `[1, 3650]` 之间（`clampRetention`）。
  过期条目在下次读取回收站时被自动清扫（`sweepExpired`），回收站里不会
  出现「点了才报错」的过期条目。

### 变更

- `createPurgeService(ctx, config)` 新增第二个参数 `config`，
  目前只读取 `trashRetentionDays`（`retentionFrom(config)`）。
  `index.js` 的 `apply(ctx, config)` 已同步透传。
- 服务对象上新增 `trash`、`trashList`、`restore`、`purgeForever`、`emptyTrash`、
  `retentionDays` 六个方法；原有 `list` / `inspect` / `purge` 的签名与返回结构保持不变，
  0.1.4 的硬删除行为仍然由 `purge` 提供。
- 回收站索引带 `INDEX_VERSION = 1` 版本标记，写入同样走快照比对 + 重试的原子写。

### 未变

- 整批预检、活跃/当前会话/路径围栏/静默检查四道闸门对 `trash` 与 `purgeForever` 同样有效。
- 有意不动的东西（用户自己的文档、按天聚合的成本数字、定时任务本身）依旧不动。

### 修复

- **空目录残留**：`pruneEmptyDirs` 原来用 `rm(dir, { recursive: false, force: true })`，
  在 Windows 上对目录一律抛 `ERR_FS_EISDIR` 并被 `catch` 吞掉，等于永不生效，
  删完会话会留下空的 slug 目录。改用 `rmdir`，并补了两道边界：起点已不存在时
  继续上溯（正常情形，不是停止条件），以及遇到 `~/.dsh`、`sessions`、`storages`、
  插件存储根、`trash` 一律停手，绝不把 `sessions` 根本身删掉。

### 测试

- 新增 `test/trash.test.mjs`（59 条断言）：回收 → 列表 → 还原的字节往返、
  工作区重挂、彻底删除、清空、到期清扫、以及路径越界与空选择两种拒绝。
- 新增 `test/atomic.test.mjs`（26 条）、`test/schedule.test.mjs`（21 条）、
  `test/e2e.test.mjs`（47 条），全部在临时 `DSH_HOME` 上运行，开头断言不在真实 profile 内。
- `npm test` 一次跑完四套。

### 打包

- 补齐 `repository` / `homepage` / `author` / `bugs` / `dshhub` 元数据块与 `scripts.test`，
  `files[]` 增加 `CHANGELOG.md` 与 `test`；新增 `LICENSE`（MIT）。

## [0.1.4] - 2026-11-19

### 修复

- **启动崩溃**：宿主自己的 `dsh-storage-json` 在写 `workspace.json` 时
  `rename` 撞上 Windows 文件占用（`EPERM / errno -4048`），它没有重试，直接 fatal。
  插件也要覆写同样的账本文件，因此针对同类风险补齐了四层保护。

### 新增 —— 写入健壮性

| 保护 | 做法 |
| --- | --- |
| rename 退避重试 | `EPERM / EACCES / EBUSY / EAGAIN / ENOENT / EMFILE` 时按 60 ms 起指数退避重试 6 次；最终仍失败则抛出可读中文错误（503）。 |
| 快照比对 | 读账本时同时记下 `mtimeMs + size`；落盘前若发现文件已被别人改过，就放弃本次写入（`STALE`），绝不覆盖宿主刚写入的新数据。 |
| 写后校验 | 写完再读一遍确认目标 id 真的消失了；若宿主用旧快照把 id 又写了回去，就重新读取并重做修改。 |
| 临时文件同构 | 临时文件改用宿主的 `.${uuid}.tmp` 命名，任何异常路径都会清理，不留 `.tmp` 垃圾。 |

- 目录删除同样带退避重试（4 轮，遇到 `EPERM/EACCES/EBUSY` 时重试），
  失败时返回「请暂时关闭杀毒软件实时防护」的可操作提示。

## [0.1.3] - 2026-11-19

### 修复

- **定时任务悬空引用**：删除会话后，`~/.dsh/storages/schedule.json` 里指向它的
  `target.sessionId` 会变成空指针。现在任务**保留**，只把 `target` 改用该任务自带的
  保留目标 `session-schedule-<sha256(任务 id)>`（与 Harness 自己的 `defaultSessionId`
  算法一致），并同时改写 `pendingDelivery` / `lastDelivery` / `deliveryHistory`
  中指向被删会话的 `targetSessionId`。文件里不再留下该 id 的任何痕迹。
- `kind: 'new'` 模式的定时任务只清空 `sessionId`、保留 `create`，`involvedSessionIds`
  中的被删 id 一并剔除。

## [0.1.2] - 2026-11-19

### 新增

- **附件引用计数清理**：删除会话时扫描 `$DSH_HOME/attachments/v1` 与
  `$DSH_HOME/cache/attachments/request-images`，按 sha256 内容寻址，
  只有当**没有任何存活会话**再引用该 blob 时才删除，避免误删共享附件。
- **上下文概览缓存**：清理 `~/.dsh/storages/dsh-context/overview-cache.v1.json`
  中该会话的条目。
- **会话策略**：清理 `~/.dsh/storages/vision_router_session_policy/policies/<id>.json`。

### 修复

- 成本记账清理不再只删 `days[*].sessions[]` 行，还会删 `usageCursors` 中
  `<id>:<hash>` 形式的键；按天汇总的 `days.<date>` 数字保持不动，避免账目失真。

## [0.1.1] - 2026-11-19

### 新增

- **安全闸门**：整批预检（选中项里有任何一个不可删就整批不动）、活跃判定
  （`running / streaming / pending`）、当前会话拒绝删除、路径围栏
  （目标必须位于 `~/.dsh/sessions` 之内）、静默检查（删除前后各读两次日志的
  大小 + mtime，间隔 240 ms，不一致则拒绝该批）。
- **单一入口**：只注册一个 `POST /dsh-session-purge` 路由，仅回环地址可访问
  （优先用宿主 `connection.requestRejection`，否则校验 Host 头）；请求体 ≤ 256 KB，
  单次最多 200 个会话；`purge` 要求请求体带 `confirm: true`，缺少就返回 400。
- **残留复查**：删除后全量复查一遍，把「仍然能匹配到该 id 的残留项」数量返回给界面显示。

### 变更

- 删除顺序固定为：宿主释放 → 登记表摘除 → 会话目录 → 投影缓存 → 会话策略 →
  工作区登记 → 成本记账 → 上下文概览 → 定时任务引用 → 无主附件。

## [0.1.0] - 2026-11-19

### 新增

- 首个可用版本：在侧边栏「工作区」上方新增 **删除会话** 入口，列出工作区内的全部会话，
  支持多选、全选与确认弹窗，一键彻底删除会话日志、投影缓存、工作区登记与相关记账。
- 宿主半部（`index.js` + `lib/`）负责磁盘操作，浏览器半部（`client.js`）只负责界面与调用路由。
- 有意不动：用户自己工作区里的文档、按天聚合的成本数字、定时任务本身。

[未发布]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/REPLACE_OWNER/dsh-session-purge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/REPLACE_OWNER/dsh-session-purge/releases/tag/v0.1.0
