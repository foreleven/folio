# Task 全局调度迭代计划

日期：2026-09-16。状态：四个迭代已实现并通过验收；不处理 Agent 打包问题。

## 目标与职责

所有执行先持久化，再由全局 Scheduler 分配 Worker。Vault 订阅全局执行事件，将属于自己的消息写入本地 `messages` 表。

```text
手动提交 / Routine 触发 / 重试
  → Vault：事务保存 Task、Session 元数据和 queued 执行请求
  → 全局 Scheduler：领取请求，分配并发名额
  → Worker：准备资源，启动 Agent 子进程，发布执行事件
  → Vault 订阅者：保存事件、更新 messages 和执行状态
  → UI：读取 Vault 数据库
```

- **Vault**：拥有业务数据、执行请求和消息投影；通过主进程注入的 VaultContext 确定归属。
- **全局 Scheduler**：统一调度所有 Vault 的请求，管理并发、领取、取消和恢复。
- **Worker Pool**：应用级共享；每次执行隔离工作目录、Session 和凭据，沿用 Agent 子进程。
- **全局事件流**：传递可重放的执行事件；Worker 不直接写各 Vault 的 `messages`。
- **Routine 触发器**：只产生执行请求，不直接启动 Agent。

队列单位是一次 Run 的执行请求，不是 Task 本身。同一 Task 可以有多个 Run，但串行执行。
第一版采用各 Vault 数据库保存请求、全局统一消费的逻辑队列，避免 Task 与全局数据库跨库双写。内存通知只负责唤醒，数据库才是排队事实来源。

## 迭代 1：统一持久化提交

1. 为执行请求增加 `queued` 状态，保存稳定请求 ID、Task/Session 关联、prompt、Agent/模型选择、来源和提交时间。
2. 手动执行、Run once、Routine 定时触发、恢复和冲突修复统一走提交入口；重复请求返回同一记录。
3. 提交事务成功即返回“已排队”。打开 Session 只保存或读取元数据；资源准备、运行环境检查和 Agent 启动推迟到领取后。
4. 将当前 Run 对已启动 ACP Session、worktree 和 baseline 的前置要求拆到执行准备阶段，保留既有 Git 校验。

验收：Agent 不可启动时仍可成功提交；重启后请求仍在；重复提交不产生第二次执行。Task 和执行请求之间不存在已确认提交却缺少记录的窗口。

## 迭代 2：全局 Scheduler 与 Worker Pool

1. 在应用主进程作用域创建唯一 Scheduler 和 Worker Pool，替换各入口直接调用 `runs.start` 的路径。
2. 全局并发上限可配置；在 Vault 之间轮转，同一 Task 保持串行。
3. 从数据库原子领取请求并记录执行所有权；Worker 通过 VaultRuntime 获取准备执行所需的上下文。
4. 并发名额覆盖资源准备、Agent 执行和进程清理全过程。Routine 扫描与执行调度分离。

验收：两个 Vault 同时提交时总执行数不超过上限；同一 Task 不并行；关闭窗口不影响排队和执行；单个请求失败不阻塞其他请求。

## 迭代 3：Vault 订阅消息并落库

1. 定义统一事件信封：`eventId`、`vaultId`、`taskId`、`sessionId`、`runId`、执行 attempt 标识、序号、类型和 payload。归属由主进程生成，不能由 renderer 任意指定。
2. Worker 发布 Session 绑定、消息增量、工具调用和生命周期事件。Vault 订阅者复用 HarnessEventStore 的投影逻辑写入 `messages`，同时更新 Run/Routine 状态。
3. 订阅者属于应用持有的 VaultRuntime，不属于窗口；派发前确保订阅已就绪。
4. 事件先进入持久化日志再通知订阅者，订阅者在同一事务中完成幂等落库和消费游标更新。优先复用现有 Agent archive，补足其未覆盖的启动失败和生命周期事件。
5. 按执行顺序消费，重复事件不重复拼接，缺失事件先补放。UI 只在 Vault 提交事务后看到对应更新。

验收：消息只进入所属 Vault；断开订阅再恢复能补齐；重放不重复；消息先落库，再展示最终状态。订阅写入失败可单独重试，无需重新运行 Agent。

## 迭代 4：取消、恢复与界面收口

1. 排队请求直接取消；执行中请求先停止并清理进程，再释放名额。
2. 应用启动重新扫描 queued 请求；对上次 preparing/running 的请求核对执行所有权和日志，确认停止后标记 interrupted，不盲目重跑可能已有外部副作用的指令。
3. UI 统一展示 queued、preparing、running 和终态，提交成功与执行成功分开表达；用户重试创建新的执行 attempt 并保留历史。
4. 删除绕过 Scheduler 的启动路径，保留现有 Session 隔离、Git 写入边界与进程清理约束。

验收：覆盖提交后崩溃、领取后崩溃、Agent 退出、消息落库失败和取消竞态；重启无丢单、无重复自动执行、无并发名额泄漏。

## 实施顺序

按 1 → 2 → 3 → 4 分批提交。前两步建立持久化调度，第三步切换消息归属，第四步完成恢复和用户体验；全局事件订阅投入使用前必须同时具备持久化重放，不能只接一个内存 PubSub。
本轮不引入 Redis 等外部队列，不更换 Agent SDK，也不扩大到打包或 Git 同步规则重设计。

## 实施记录

- 已实现 `execution_requests` 迁移和 Vault 级 ExecutionQueue：持久化提交、意图去重、原子领取、同 Task 串行、所有权校验和取消意图。
- 已实现全局调度核心：共享并发上限、Vault 轮转、通知唤醒与补偿扫描；并发名额保持到 Worker 清理结束。
- 已验证数据库重新打开后的队列恢复、并发领取、错误所有权拒绝、取消与清理边界。
- 已接入 Task、Routine、恢复指令和冲突修复入口：提交返回执行请求，Session 只保存元数据，worktree 和 Agent 延迟到 Worker 内准备。Routine 的 Task、Session 和请求在同一事务中提交；手动 Run once 带稳定请求 ID。
- 应用启动已连接全局 Scheduler。全局配置 `executionConcurrency` 可设置为 1–32，缺省为 2。Routine 触发不再直接执行，排队后的 prompt/时间窗口保持不变，失败或不确定执行不由定时器盲目重跑。
- UI 已显示排队和启动失败，支持取消排队及创建新请求重试；遗留 Run 记录仍可查看与检查。
- 已接入全局 ExecutionEventLog、Worker 事件出口与 VaultExecutionEvents 订阅者。Agent 消息、协议帧和生命周期先落全局日志，Vault 校验执行归属后更新本地数据；消息投影和消费游标同事务提交。消息入口不等待 UI 投影，关键执行边界会等待已提交事件完成投影。
- 已验证无订阅者时记录保留、跨 Vault 隔离、精确去重、断开订阅后按序补放；注入消息投影失败时原始消息和游标一起回滚，恢复后可重试消费而无需重跑 Agent。
- 已记录 Agent 进程启动/停止事实；发送 ACP 握手前先持久化进程身份。恢复先补放事件，再核对进程/进程组和原有 Session lease/archive；确认停止后标记 interrupted，不重放原指令。此前存活或尚未核实的 Worker 继续占用全局并发名额。
- 已验证领取后、启动前的重启恢复、未领取请求保留、存活旧进程拒绝接管，以及跨 Vault 调度不漏算旧进程名额。真实 Agent 协议 fixture 覆盖运行成功、取消清理及原生进程崩溃；故障注入覆盖 Run 终态和请求终态日志缺失后的恢复，确认不重复派发。请求身份检查拒绝复用历史 Run ID，已确认成功不会被迟到取消覆盖。

验证记录：主进程及 renderer 类型检查通过；桌面全套测试 56 个文件通过，345 项通过、1 项跳过。最终请求身份、事件投影与冲突界面补验 22 项通过，VaultRuntime 运行及恢复补验 6 项通过，`git diff --check` 通过。生成测试需要的 Agent CLI 后，在允许嵌套 Node 子进程的环境中验证真实协议 fixture；不调用真实模型服务。沙箱环境会阻止该子进程并返回 EPERM，这类测试需在沙箱外运行；未修改应用打包方案。

最终链路审查：TaskService 的执行入口统一提交队列，只有被领取的 Worker 调用 `runs.execute`；Session 启动位于 Worker 内。Scheduler 和日志位于应用作用域，Vault 订阅者位于 VaultRuntime，窗口关闭不终止订阅。测试用事件出口仅由测试导入。进程清理证明覆盖 Folio 管理的进程及进程组；工具主动脱离进程组的行为不在此证明范围内。

实现细化：执行请求与 Run 分开存储，请求 ID 对应后续 Run ID。前者可以在没有 Agent 和 Git baseline 时入库；后者继续保留现有 Git/ACP 约束。启动准备失败只产生终态执行请求，不伪造 Run 或 baseline。
