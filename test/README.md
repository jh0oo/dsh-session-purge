# 测试

零依赖，只用 Node 内置模块（`node:fs`、`node:path`、`node:os`、`node:child_process`、`node:zlib`）。
不需要 `node --test`，每个文件都能直接跑：

```powershell
node test/atomic.test.mjs
node test/schedule.test.mjs
node test/e2e.test.mjs
```

三个脚本各自独立：通过时打印 `ALL CHECKS PASSED — N passed, 0 failed` 并 `exit 0`，
失败时列出每一条挂掉的断言并 `exit 1`。也可以一次跑完：

```powershell
node test/atomic.test.mjs && node test/schedule.test.mjs && node test/e2e.test.mjs
```

## 隔离：绝不碰真实的 `~/.dsh`

三个脚本在**做任何事之前**先 `mkdtemp` 一个临时目录，然后
`process.env.DSH_HOME = <临时目录>`，再动态 `await import('../lib/store.js')`。
`lib/store.js` 的 `resolveHome()` 每次都读 `process.env.DSH_HOME`，所以临时 home 会被全程使用。

每个脚本开头都有 `assertIsolated()`：如果探测到临时 home 落在
`%USERPROFILE%\.dsh` 或 `os.homedir()/.dsh` 里面，立刻抛错退出，不会开始跑。
`e2e.test.mjs` 结束时还会再检查一遍真实 home 从未被写入。

临时目录在脚本收尾时 `rmSync(..., { recursive: true, force: true })` 删除，
异常退出（`process.on('exit')` 兜底）也会删。

## 各文件覆盖什么

| 文件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `atomic.test.mjs` | 26 | `writeJsonAtomic` 的正常写入、`expectedStamp` 过期（`STALE`）、有界竞争者下收敛、独占文件句柄下 `rename` 退避重试、写后校验（verify）收敛、cost ledger 的 `usageCursors` 键与 `days[*].sessions[]` 清理。 |
| `schedule.test.mjs` | 21 | `editScheduleRefs` 把 `target.sessionId` 重写到 `session-schedule-<sha256(taskId)>`；`pendingDelivery` / `lastDelivery` / `deliveryHistory` 同步改写；`kind: 'new'` 保持且不带 `sessionId`；无关任务字节不变；第二次运行是 no-op（`touched === false`，文件字节全等）。 |
| `e2e.test.mjs` | 47 | 端到端：合成 `$DSH_HOME`（会话目录 + 投影缓存 + 会话策略 + `workspace.json` + cost ledger + overview cache + `schedule.json` + 内容寻址附件），用 stub `ctx` 调 `createPurgeService(ctx).purge()`，然后逐项断言残留探针全为 `false`、存活会话完好、共享附件保留、真实 home 未被触碰。不起 HTTP。 |

## `_scratch/metadata-snippet.json` 里的占位符

该文件是准备合并进 `package.json` 的字段片段，JSON 不能写注释，所以说明放在这里：

- `repository.url` / `homepage` / `bugs.url` 里的 `REPLACE_OWNER` 是**占位符**，
  发布前替换成真实的 GitHub 所有者（或整个换成别的托管地址）。
- `author.email` 的 `REPLACE_EMAIL@example.com` 同样是占位符；不打算公开邮箱时，
  删掉 `email` 字段只留 `name` 即可。
- `os` 是空数组，表示不限制平台（`lib/store.js` 用的是纯 `node:fs`，没有平台专属路径）。
- `publishConfig.registry` 指向公共 npm；发布到私有源时改这里。
- `scripts.test` 就是上面三条命令用 `&&` 串起来的版本。

## 参考

`_scratch/` 下保留着这些测试的前身（`atomic.mjs` / `schedtest.mjs` / `e2e.mjs` / `listcheck2.mjs`），
它们依赖真实的 `~/.dsh` 和真实 HTTP 路由，只适合手工排查，不要拿它们当回归测试跑。
