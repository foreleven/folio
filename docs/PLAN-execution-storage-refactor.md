# Execution 存储重构计划

状态：已实现。下文保留设计、验收要求和对应实现索引。

新 Vault 初始化已收敛为 `0001_vault`：直接创建最终表结构，不创建后再删除旧 messages/checkpoint 表，也不保留旧开发 Vault 的升级步骤。SQLite 元数据比对确认重构前后的最终列、约束、索引与触发器一致。

## 1. 目标与边界

把一次执行的持久状态统一到 Vault 的 `runs`；少量临时运行信息使用本地 JSON 文件；处理过程使用 JSONL 日志。删除独立的 execution 表体系及全局事件数据库。

沿用本轮约定：只支持新建 Vault，不迁移旧数据，不保留新旧双写。保留全局跨 Vault 并发调度、同 Task 执行互斥、取消、失败恢复、Routine 窗口合并和 Git 收尾语义。

消息存储保持现有约定：ACP 流式更新在内存聚合，完成后写 `messages`；工具调用也属于 message；取消或异常时保存已收到的部分内容。运行日志不重复保存消息流或 Agent 原始归档。

## 2. 存储归属

| 当前对象 | 重构后的归属 |
| --- | --- |
| `execution_requests` | 合并到 `runs`，提交时即创建 queued Run |
| `execution_workers` | 每次执行的 `state.json` |
| `execution_processes` | 同一 `state.json` 的进程数组 |
| 全局 `execution_events` | 删除；生命周期直接更新 Vault，过程记录到 JSONL |
| `execution_event_cursor` | 删除；没有事件消费或重放进度 |
| `execution_process_groups` | 删除相关中间建表迁移；它目前不是最终独立表 |
| `runs` | 唯一持久执行记录 |
| `sessions` | 继续保存外部 Agent session ID 和模型信息 |

Task 状态仍独立。Run 执行成功不等于 Task 已完成；Git 同步及工作树清理仍由既有服务负责。

## 3. 合并后的 runs

保留现有 `id / sequence / task_id / session_id / prompt / purpose / resumes_run_id / baseline_commit / sync_state / created_at / ended_at / error`，增加或调整：

- `state`：`queued | preparing | running | succeeded | failed | cancelled | interrupted`。
- `source`：保留现有 manual、routine、recovery、conflict-resolution 来源。
- `owner`：本次领取的随机执行令牌，仅用于阻止过期 Worker 更新；不承载 PID。
- `cancel_requested`：持久化取消意图。
- `started_at`：领取时间，queued 时为空。
- `baseline_commit`：queued 和早期 preparing 时允许为空；进入 running 前必须具备既有 Git 前置条件。

约束：

1. `id` 继续作为提交幂等键；相同 ID 必须对应相同不可变请求参数。
2. 同 Task 最多一个 preparing/running Run，通过部分唯一索引约束；允许多个 queued Run。
3. 领取通过 SQL 条件更新完成。后续更新均验证 `run_id + owner + 预期状态`。
4. queued 无 owner、started_at；preparing/running 必须有 owner、started_at；终态必须有 ended_at。
5. 普通失败重试创建新 Run，保留前一次结果；恢复执行继续使用 `purpose/recovery + resumes_run_id` 的现有语义。
6. Agent 的执行结果与资源清理分开：收到结果后，清理未完成时仍占有执行权，不允许下一次执行进入同一 Task。
7. 无 baseline 的准备失败不得生成 Git 同步工作；已有 baseline 的同步约束保留。

`reserveRun` 不再 INSERT 第二条记录，改为给已领取 Run 补齐准备结果。Routine 状态、历史、全局计数及 RPC 均直接读取 runs，删除请求与 Run 的双份 DTO/状态映射。

## 4. 本地文件布局

每个 Vault 自己持有运行文件，全局调度器只负责汇总和分配，不另存全局执行状态：

```text
<vault>/runtime/runs/<run-id>/<owner>/state.json
<vault>/logs/runs/<run-id>/<owner>.jsonl
```

`state.json` 仅包含恢复必需信息：

- formatVersion、vaultId、taskId、sessionId、runId、owner。
- 应用实例 ID、主进程 PID、Worker thread ID。
- 子进程列表：PID、进程组及可获取的启动身份、是否已确认退出。
- 启动阶段、清理进度、更新时间。
- 待提交的外部 Session 绑定和执行结果回执（如果有）。

不复制 prompt、消息内容、模型配置或完整数据库记录。运行阶段用于恢复资源，不成为面向 UI 的另一份 Run 状态。

写入规则：

- 主进程中的单一运行记录服务负责写入，Worker 通过现有 IPC 上报；同一次执行串行更新。
- 同目录临时文件写完并同步后原子 rename；在平台支持时同步目录。关键写入必须等待完成，不能 fire-and-forget。
- 通过应用单实例/既有 Vault 锁约束写入所有权；执行令牌同时验证数据库归属。原子 rename 本身不是并发锁。
- 活跃运行文件禁止按 TTL 清理；终态落库且进程退出确认后才删除。数据库已终态但文件遗留时，重启可幂等清理。
- 状态文件损坏、缺失或 Vault 无法读取，均不等价于“没有进程”。不能据此直接重发 prompt 或释放未知所有权。

复用现有 `SessionLeaseStore` 和 Agent 原始会话归档。进程是否属于本次执行不能只依据 `kill(pid, 0)`；可用的启动身份与原生租约一起核验。无法确认时保留待恢复状态，不根据复用的 PID 杀进程。

## 5. JSONL 处理日志

每行一个版本化结构：`timestamp / level / vaultId / taskId / sessionId / runId / owner / event / data`。

记录领取、准备阶段、启动、绑定、取消、Agent 结果、清理、数据库提交失败、恢复判定等关键过程。不记录凭据、完整环境变量和逐 token 内容；stdout/stderr 如需保存使用独立受限日志。

- 主进程单写者负责追加，按执行分文件；不做全局 sequence，不做消费游标。
- 普通日志缓冲批量写；执行结束时尝试 flush。日志写入失败应产生可见诊断，但不改变已确定的执行结果。
- 日志不作为数据库恢复的唯一依据。读取时忽略崩溃留下的不完整尾行；中间坏行报告损坏，不静默当作正常记录。
- 建议默认终态日志保留 7 天、单个文件上限 10 MiB、每 Vault 总预算 100 MiB；实施时常量集中定义。超限轮转/删除已终态日志，不删除活跃 state 文件。
- “同时活跃执行有限”不代表历史日志有限；需明确轮转和清理，否则 JSONL 仍会无限增长。

## 6. 生命周期与写入顺序

### 提交与启动

1. 在 Vault 事务中创建 queued Run；提交成功即表示已接受请求。
2. 全局调度器原子领取，写 owner、started_at，进入 preparing。
3. 持久化初始 state 文件后创建 Worker；启动 Agent 时使用既有原生租约，并记录进程身份。
4. 持久化外部 Session 绑定回执，再幂等写入 sessions；绑定确认、baseline 和运行记录准备就绪后，才允许发送 prompt。
5. Run 进入 running；IPC 更新内存消息聚合器，完成消息才落库。

进程 spawn 与 PID 落盘之间存在无法用普通文件事务消除的窗口。实施时必须检查并补齐启动握手及原生租约：在身份登记确认前不得允许 Agent 接受 prompt。若主进程此时崩溃，依赖原生租约/父进程退出机制发现或结束子进程；无法证明退出则禁止自动重复执行。

### 完成与取消

1. 保存已完成消息或中断部分消息，然后把 Agent 结果回执原子写入 state 文件。
2. 完成 Worker、子进程及租约清理；在清理确认之前保持执行占位。
3. 使用 owner 校验，在数据库事务中写入 Run 终态及对应持久状态。
4. 事务成功后删除 state 文件，保留受限 JSONL 日志，唤醒调度器。

清理或数据库写入失败时保留 state 及执行占位，由恢复流程继续。queued 取消可直接在数据库完成，无需启动 Worker 或创建状态文件；运行中取消先持久化 cancel_requested，再通知 Worker。

Agent 成功但随后收到取消请求时，沿用既有结果优先规则，避免把已完成的副作用误记为未执行。取消和成功竞争必须通过测试固定语义。

## 7. 启动恢复

扫描数据库未终结 Run 和 runtime 文件的并集，而不是只扫描其中一边：

| 情况 | 处理 |
| --- | --- |
| queued，无运行文件 | 正常等待调度 |
| preparing/running，确认仍有归属进程 | 保留占位，不重复启动 |
| preparing/running，有结果回执，已确认进程退出 | 幂等补交数据库结果并清理文件 |
| preparing/running，无结果，已确认进程退出 | 核对 Agent 归档与租约，能确认结果则补交，否则记 interrupted |
| Run 已终态，残留运行文件 | 核对并清理资源及文件，不再执行 prompt |
| 文件损坏、归属不明或数据库不可读 | 报告待恢复并保守占位，不自动重试 |

自动恢复只恢复状态和清理，不自动重放可能已经执行过的 prompt。恢复不承诺外部副作用 exactly-once。

## 8. 分步实施

1. **统一 Run 模型和新 Vault schema**：修改 shared harness/execution、vault-migrations、HarnessStore 与队列接口；移除第二次 Run 插入。先验证排队、领取、取消、幂等与准备失败。
2. **建立文件记录服务**：实现 state 原子更新、归属校验、进程列表、待提交回执、JSONL 追加与清理。沿用现有服务和 Schema 风格，不引入通用事件框架。
3. **接入 Worker 生命周期**：调整 ExecutionEventSink、AgentWorkerPool、HarnessRuns、Worker 协议，直接调用数据库与文件服务。明确启动握手和单写者边界。
4. **替换恢复流程**：重写 execution-recovery；复用 SessionLeaseStore/Agent 归档；全局调度汇总各 Vault 的 queued Run 和未清理执行占位。
5. **切换调用方并删除旧路径**：TaskService、RoutineStore、RPC、renderer 历史/计数改读 runs；删除 VaultExecutionEvents、ExecutionEventLog 及全部 execution 建表、游标、全局数据库初始化。
6. **故障验证和文档**：更新测试、存储说明及诊断路径，确认不存在旧表查询或兼容双写。

依赖按上述顺序推进；中间实现可分提交，但最终交付必须整条执行与恢复链路一起切换，不能留下半套事件系统。

## 9. 验收

- 新 Vault 不含 execution_* 表，不创建全局 execution-events.db。
- 提交至执行结束只有一条 Run，准备失败也可查询；重试保留独立历史。
- 多 Vault 公平调度、全局并发上限、同 Task 互斥、Routine 合并窗口行为保持正确。
- 流式消息不新增逐片段 SQL 或 JSONL 写入。
- 领取后、spawn 后登记前、Session 绑定后、结果落盘后、清理后、终态事务后分别注入崩溃，验证无自动重复 prompt、无错误释放占位。
- 覆盖磁盘满、原子替换失败、坏 JSON、JSONL 残尾、PID 复用、旧 owner 延迟回调、数据库不可用、取消与完成竞争。
- 清理失败的执行继续占位；活跃恢复文件不会被日志保留策略误删。
- 运行相关单元/集成测试、桌面前后端类型检查、lint 和构建通过。涉及 Worker 的测试使用重新构建的入口。

## 10. 实现索引与运维约定

- `shared/harness.ts`：统一 RunRecord，queued 与 preparing 可以没有 baseline；running/succeeded 必须有 baseline。
- `execution-queue.ts`：在 runs 上提交、领取、取消和终结；跳过 Git 保存/同步尚未结束的 Task。
- `harness-store.ts`：只为已领取且 owner 匹配的 Run 填充经过校验的 baseline，不再维护第二套状态迁移。
- `run-files.ts`：原子 JSON、进程身份、结果回执；JSONL 缓冲、flush、轮转与总预算。日志超过预算时可以舍弃诊断，不能舍弃恢复状态。
- `execution-event-sink.ts`：直接更新 Vault 和本地回执；会话回调捕获 owner，拒绝过期 Worker。
- `execution-recovery.ts`：扫描 Run 与文件的并集，复用原生 Session 租约；不依据缺失文件推断资源已退出。
- `main/index.ts`：Electron 单实例锁确保应用侧只有一个运行文件写入者。
- `TaskConversation` / `TaskWikiChangesPanel`：只使用 runs，移除 executions 与 runs 的合并显示逻辑。

每个日志文件最多 10 MiB，同一次执行保留当前与 previous 两段；每 Vault 总日志预算 100 MiB。超出预算停止追加诊断，已终态日志按 7 天保留期和总预算清理。运行文件不参与日志清理。没有自动修复损坏状态文件的逻辑：归属不明时保留占位，防止重复发送指令。

旧 Vault、旧全局事件数据库不转换，也不会自动删除用户磁盘上的旧文件；验证和使用本实现需新建 Vault。

## 11. 验收证据

2026-09-18 在 macOS 开发环境验证：

| 要求 | 证据 |
| --- | --- |
| 单一 Run，旧执行表与全局数据库不再创建 | execution-queue.test 的 schema/同一行断言；vault-runtime.test 的全局数据库不存在断言；生产源码无旧表查询 |
| 领取互斥、幂等、取消、跨 Vault 调度 | execution-queue.test、execution-scheduler.test、vault-runtime.test |
| Git/Routine 行为 | task-worktrees.test、task-git-synchronization.test、git-change-applications.test、routine-store.test |
| 流式消息不写 SQL/运行文件/JSONL | execution-event-sink.test 中 100 次增量更新前后数据库计数、运行文件和日志内容相同 |
| 领取后、启动登记窗口、绑定/结果回执、终态提交/文件删除之间的恢复 | execution-recovery.test 的持久快照故障场景；vault-runtime.test 的真实 Worker 终态提交故障与重启 |
| 磁盘满、原子替换失败、坏 JSON、JSONL 残尾 | run-files.test |
| PID 复用、活进程、过期 owner、数据库不可读、取消/成功竞争 | execution-recovery.test、execution-event-sink.test、process-identity.test |
| 清理未完成不释放占位，日志保留不删除恢复文件 | execution-event-sink.test、run-files.test |
| UI 只读取 Run | TaskConversation.test、TaskWikiChangesPanel.test |

全量桌面测试：58 个文件、347 项通过。最后的文件校验调整另经 17 项存储/恢复定向测试通过。前后端类型检查、相关 ESLint、差异空白检查和桌面构建作为交付检查执行。Worker 测试必须在构建结束后运行，不能与清理 out 目录的构建并发。
