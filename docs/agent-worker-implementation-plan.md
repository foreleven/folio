# Agent Worker 执行改造

状态：已实现；Linux 开发构建与打包运行验收通过。

## 执行链路

`Vault 提交 → 数据库 execution_requests → 全局 Scheduler → Worker Thread → 全局事件日志 → Vault messages / runs / tasks`

1. **先持久化**：手动执行和 Routine 都先写入执行请求。提交接口不直接调用 Agent；请求 ID 用于去重。
2. **全局调度**：应用级 Scheduler 跨 Vault 领取请求，统一控制并发。同一个 Task 不同时执行两个请求；准备、执行、取消和清理都占用名额，清理完成才释放。
3. **应用内执行**：Agent 包提供独立于 CLI 的执行接口，复用现有 Codex/Pi SDK、会话、archive 和取消逻辑。主进程创建 Worker，每个线程持有一个 Session，只传配置快照、参数和事件，不传 VaultContext 或数据库连接。
4. **事件落库**：Worker 发出事件，主进程持久化到全局日志后确认。Vault 按游标订阅、幂等写入本地表；订阅恢复只补放事件，不重新执行 Agent。
5. **回收与恢复**：线程归属和原生进程 PID 分别记录。取消、崩溃及应用退出时，确认线程和子进程退出后才写清理回执。无法确认的执行保留占用，恢复时核对；不自动重跑可能已产生副作用的请求。

## 为什么仍有 Worker 入口文件

移除的是桌面应用寻找 `out/main/agent.js`、另起 Folio Agent CLI 并通过 ACP 通信的路径。

`agent-worker.ts` 是应用源码，由 electron-vite 与主进程一起构建为 `agent-worker.js`，供 Node Worker Thread 加载。它不是单独安装、构建或寻找的 CLI。独立 Agent 包的 CLI 可以保留给其他用途，但桌面执行不依赖它。

打包时将主进程运行文件、依赖和 package.json 解包到 `app.asar.unpacked`；Worker 入口解析指向这个真实目录。这避免 Electron 的 ESM Worker 在 ASAR 内读取包作用域失败。NodeServices 使用明确子路径导入，避免加载无关的 Redis 可选模块。

Worker 中运行 SDK 的会话和模型逻辑。SDK 所需的 Codex 原生进程、Pi 工具 I/O 由主进程持有并回收，通过流和消息供 Worker 使用。原因是实际测试发现：在线程内创建子进程后强制终止线程，可能留下僵尸进程。主进程持有 ChildProcess 才能可靠等待操作系统回收。

## 实施顺序

1. 抽出 Agent 直接执行模块与结构化线程协议。
2. 增加应用级 Worker 管理，接入现有 Scheduler、事件日志和 Vault 投影。
3. 补齐取消、崩溃清理、会话锁释放及重启恢复。
4. 切换生产入口，移除桌面旧 CLI 启动路径，集成桌面构建。
5. 验证真实 Worker、两种 Agent、跨 Vault 并发、持久化失败和构建产物。

以上步骤已完成。跨 Vault 调度由 Scheduler 测试覆盖；真实 SDK Worker 的执行、取消和崩溃回收由集成测试覆盖。

## 验收记录

- Agent 全量首次运行：156 项通过、3 项 CLI 用例失败。修正启动依赖导入后，Pi CLI 3 项通过；Codex CLI 测试改为等待独立终态通知，会话锁与 Codex CLI 复查 9 项通过（含新增启动前退出测试）。不将 ACP 提交确认误认为执行完成。
- 桌面全量：325 项通过、1 项跳过，3 项失败来自旧入口断言及测试与构建重叠造成产物暂时缺失。更新入口测试，在构建完成后复查相关 4 个文件，15 项全部通过。
- 真实构建 Worker 已验证：Codex 执行与取消、线程崩溃后的原生进程回收和 Session 恢复；真实 Pi SDK 使用本地模型夹具执行 bash，工具执行中终止线程后正常回收。
- VaultRuntime 的执行与恢复、会话生命周期、持久化事件重放、跨 Vault Scheduler 公平调度和清理期间保留并发名额已验证。新增多 PID 回执及旧版无 PID 停止回执兼容测试通过。
- 主进程、renderer 类型检查，Agent 编译，桌面构建和 Linux 目录打包通过。
- 使用实际 Electron 加载 `app.asar.unpacked/out/main/agent-worker.js`，通过本地 Codex 协议夹具执行完整任务并退出：`{"packagedWorkerExecuted":true,"exitCode":0}`。未调用远程模型。
- Linux 上验证子进程回收；Windows 的 taskkill 分支尚未实机验证。

## 使用与范围

重新启动桌面开发进程后使用新 Worker 入口。之前已失败的请求不会自动重跑，需用户主动重试。

这次改造保留现有 Vault 数据归属和 SDK。关闭窗口后的应用生命周期、应用完全退出时 Routine 是否触发，仍由现有全局调度和应用运行策略决定，不由 Worker 改造额外保证。
