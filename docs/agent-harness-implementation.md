# Agent Harness 实现进展

依据：[Harness RFC](./RFC-agent-harness-execution-storage.md)。目标仍是完整推进 RFC 的执行和存储架构，以下探针不代表生产能力已经完成。

## 2026-09-10 — V0：真实协议与 Git 实验

### 阶段状态（最新；下文按实施顺序保留历史证据）

| 阶段                     | 当前状态                       | 证据 / 未完成项                                                                                                                                                                                                              |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V0 Git                   | 进行中，统一冲突结果方案已确认 | 11 个算法实验；选定文件快照、提交准备、源分支保存、手动 wiki canonical 状态机/恢复、stale reprepare、人工 resolver/abort 及受约束的 conflict-resolution Run 已验证；writer 停止证明仍待完成                                                         |
| V0 ACP                   | 进行中                         | Pi/Codex 统一 ACP、持久化与桌面消息投影已接通；Pi 原生工具及脚本化模型循环、Codex fixture 执行/恢复已验证；真实模型执行、完整事件审计和跨平台进程树仍待完成                                                                  |
| V1 Vault / DB            | 进行中                         | 新 Vault main、反向链接、领域表、Task worktree 创建、显式完成后的 durable 释放及手动 Task 重开已实现；Routine Task 重开仍暂不允许                                                                                                      |
| V2 手动任务              | 进行中                         | Task/Session、固定 Task Agent、显式模型选择、Run 执行/停止、消息 UI 与异常终止检查已接入；macOS arm64 运行时已验证；Run 结束保存编排、其他平台与真实模型验收待完成                                                           |
| V3 自动同步              | 进行中，手动 wiki 后端已接入   | 主工作区保存 UI/RPC、Task wiki 变更/差异、多 Run 来源显式保存、无变化确认、同步/reprepare/收据 RPC、canonical 发布/对齐、人工 resolver/abort、conflict-resolution Run、冲突上下文 UI 和 Run 同步状态投影已验证；普通 Run 自动保存和 writer quiescence 待完成 |
| V4 Routine / Integration | 定义、计划与合并派发已接入     | Vault 时区每日计划、离线合并补跑、稳定任务身份、冲突自动暂停已实现；Integration 资源按 Task 固定；最终同步/无变化收据后的 Task 自动完成及 tick 恢复已实现                                                                     |
| V5 第二种 Agent          | 进行中                         | Codex adapter 已接入统一 ACP CLI 并完成 fixture 联调；真实模型执行/恢复、完整事件映射待验证；沙箱仍为未来范围                                                                                                                |

### Git 证据

命令：`npm test --workspace=@folio/agent -- tests/git-sync-spike.test.ts`

测试使用独立临时仓库和真实 worktree；不修改开发仓库，不加载用户 Git 配置、签名或 hooks。

1. 不同文件的双向 cherry-pick 可得到一致树；提交 trailer 能识别已经应用的逻辑变更。
2. **同一文件分别解决冲突后，两边虽有相同变更 ID，却有不同树。** 该测试以捕获此风险为成功，不是 V0 同步门禁通过。
3. 同文件的未提交用户内容会阻止 cherry-pick，内容保持不变。
4. 不同文件的未提交内容不一定阻止 Git cherry-pick；Folio 必须自行执行更严格的干净工作区检查。
5. rename/delete 冲突可留在协调 worktree，main 的 HEAD 和工作区不受污染。
6. Git 已提交、DB receipt 丢失时，提交 trailer 可定位实际 SHA；这仅验证恢复所需证据，尚无数据库操作日志实现。

后续补充 5 项实验：统一冲突结果与第二轮同步、main 前进后重新准备、Task 草稿/新提交保护、rename/delete 后续编辑、单文件已提交快照导出，以及 raws 冲突保留（部分场景在同一用例内）。11 项均通过；详见[统一冲突结果提案](./git-sync-canonical-proposal.md)。已向用户提出此收敛规则，尚未把它当作确认后的生产算法。

本次实验补充后的验证：Agent 全量 142 项测试、全仓 typecheck 和 git diff --check 通过。本轮只修改测试与文档，未新增生产同步实现，也未重建运行包。

### Codex 证据

命令：`npm run test:codex-protocol --workspace=@folio/agent`

- 本机版本：`codex-cli 0.153.4`。
- 通过 `codex app-server generate-json-schema` 导出实际安装版本的 schema，不依赖猜测接口。
- `ThreadStartParams` 提供 cwd、sandbox、approvalPolicy、ephemeral。
- `ThreadResumeParams` 使用 threadId；`TurnStartParams` 使用 threadId 和 input；`TurnInterruptParams` 使用 threadId 和 turnId。
- 启动独立 app-server，通过 stdio initialize / initialized 握手，随后关闭；没有创建线程、发送 Prompt 或调用模型。
- 脚本输出选定 schema 的 SHA-256，作为后续升级时的协议比对证据；临时 schema 在退出后清理。
- 该协议是 Codex app-server 协议，仍需要转为 Folio 采用的 ACP 协议。

尚未验证：完整 ACP adapter、模型与工具执行、取消、full access、原生恢复和工作目录重建。参数存在不证明对应行为已通过。

### Pi 原生 Session 证据

命令：`npm test --workspace=@folio/agent -- tests/pi-session-persistence-spike.test.ts`

- 使用真实 Pi SDK，第一进程创建并保存会话，第二进程恢复相同原生 ID、cwd 和消息；无需模型请求。
- 首条 Assistant 消息出现前，SessionManager.create 的原生文件尚未落盘，即使已 append 用户消息。
- SessionManager.open 对不存在的路径会构造新会话，不会证明原会话恢复成功。
- 因此 Folio 必须保存原始事件与执行记录，并在恢复前校验文件存在性与会话身份。新建和恢复应是不同的显式操作。
- 此处记录最初探针结论；后续已将持久化接入生产 factory，见下一节。

### 初始实施检查点（历史记录；后续进展见下文）

1. 完成 Git 收敛规则确认及内容级实验，包括 main 基线变化、不同冲突解决、补充解决提交、任务重建和重复恢复。
2. Pi 原生持久化与 ACP 映射已接通；继续验证真实模型/工具执行、full access 和客户端流式回放投影。
3. 根据已导出的 Codex 原生协议编写 ACP 适配，分别验证生命周期与实际工具行为。
4. V0 的证据充分后推进 Vault / DB / 手动任务链路，不以探针通过代替完整实现。

## 2026-09-10 — Pi 原生存储与 ACP 恢复接入

已实现：

- `PiSessionStorage` 使用 SDK 生成的 header，在创建时立即保存并重新打开，使首条用户消息也能持久化。
- 恢复前校验文件存在、非空、原生 ID、cwd 和存储根；缺失会话不会被静默重建。
- 现有 `makePiSessionFactory` 已使用原生存储，可接受显式恢复身份及 Vault 原生会话目录；composition 传递恢复参数。
- `SessionArchive` 保存 ACP/native 映射和追加式 replay log。CLI 使用 Folio agent 目录中的 `acp-sessions/`；这是 adapter 的协议回放存储，不替代将来的 Vault 原始事件数据库。
- 每条 update 在发送给 Client 前先写入并 flush；无效或截断历史明确失败，保留原文件。
- `session/list` 能列出关闭/重启前的会话；`session/resume` 按原 ACP ID 恢复同一 Pi 身份，回放原始 message ID，不把 replay 再写入历史。
- ACP new/resume 的 `_meta["folio/nativeSessionId"]` 暴露原生 ID，避免调用方假定两种 ID 相同；原生文件路径不通过此字段暴露。
- 重启前最后状态为 running 的会话恢复为 idle/cancelled，不重发原 Prompt。
- 关闭进程前等待最终通知写入；事件持久化/传递失败不再被 Registry 静默当作 end_turn。

验证：`npm run build --workspace=@folio/agent` 后运行 `npm test --workspace=@folio/agent`，91 项通过，包括新进程启动生产 CLI → 配置会话 → 退出 → 再启动 → 恢复同一 ACP/Pi ID、thinking 配置和 replay。

限制：真实 CLI 测试没有发送模型请求；fake-model 回放测试不能证明 Pi 工具或 Codex 行为。客户端消息投影去重、跨进程同一原生 Session 的独占执行、Vault 路径绑定、full access 与 Skill 装配仍需实现和验证。截断 archive 目前明确拒绝恢复，没有自动修复。V0 尚未整体完成。

## 2026-09-10 — Pi full access 工具与显式资源入口

- 生产 Session factory 启用 Pi 原生 read / bash / edit / write / grep / find / ls，无等待授权状态。
- 只将 Task 根目录的 AGENTS.md 加入上下文；保持全局/项目 Pi 扩展、隐式 Skill、模板和自定义系统提示发现关闭。配置隔离不构成安全沙箱。
- factory 增加显式 skillPaths 入口，供后续 harness 挂载的 integration skill 使用。Routine/Task 到此入口的装配尚未接通。
- 真实 SDK Session 中注册的工具通过临时目录测试：创建和修改 wiki 文件、读取结果、执行 Skill 相邻 Shell 脚本、验证 cwd、非零退出和 AbortSignal 取消。验证显式 Skill 和 Task AGENTS.md 生效，父目录上下文和未选择的项目 Skill 不生效。
- 这些测试直接调用注册工具，没有请求模型，不能代替模型工具循环、ACP 工具事件投影、Run 取消后所有 integration 子进程退出的端到端验证。V0 仍未完成。

本轮验证：Agent build、92 项测试、全仓 typecheck 与 git diff --check 均通过。

## 2026-09-10 — Pi 工具循环、ACP 输出与取消

- 新增 `pi-tool-acp.test.ts`：仅将 provider stream 替换为确定性模型响应，仍使用真实 Pi AgentSession.prompt、工具循环、原生工具、Registry、ACP Client/Server 和持久化 archive。
- 通过 ACP Prompt 创建 wiki 文件，执行有分段输出的 Shell 命令，验证非零退出映射为 failed；停止后重建 Server、恢复原 Session，事件序列和工具内容投影与原始执行一致，未重新请求模型。
- 发现并修复实际重复输出问题：Pi Shell 的 partialResult 是累计快照，旧映射将每个快照及最终结果追加为 chunk。现使用 ACP tool_call_update.content 替换语义，分段输出最终只显示一份。
- 通过 ACP cancel 取消真实 Shell 进程，验证 idle/cancelled 时其 PID 已不存在。脚本化 provider 同样遵守 AbortSignal；恢复不会再执行任务。
- 验证范围仍是进程内协议连接和脚本化 provider；没有付费模型请求，没有证明任意后台/脱离进程组的 integration 进程都被终止。桌面持久化消息投影、Codex adapter、Session 跨进程独占及 V1–V5 仍待推进。

本轮验证：Agent build、93 项测试、全仓 typecheck 通过；新增用例在类型收窄调整后再次通过。

## 2026-09-10 — Codex 原生连接与 Session 入口

- `CodexConnection` 使用 Effect ChildProcessSpawner 和 Scope 管理独立 app-server；初始化后按请求 ID 路由响应，独立排队通知和服务端请求，统一串行写入 stdin。
- 进程退出、协议异常和请求超时结束所有等待者；不会自动重试可能已产生副作用的请求。Scope 关闭终止子进程，失败消息不暴露原生 stderr 或请求内容。
- `openCodexSession` 创建持久线程，或先 thread/read 核对原生身份和物理 cwd 后恢复。使用 thread.id 作为可恢复 nativeSessionId；它与 Codex 的 session-tree 分组字段不同。
- 新建/恢复显式请求 danger-full-access 与 never，并校验响应 policy；不在此入口启动 Turn，不替用户选择具体模型。创建与恢复的模拟服务端测试覆盖跨进程同 ID、缺失/错误身份/错误 cwd、ephemeral 和不匹配的 policy。
- `test:codex-protocol` 现使用生产连接实现，替换了最初独立的手写 stdio 握手。真实本机 Codex 0.153.4 已通过 initialize、model/list 和 Scope 进程清理；没有创建真实线程或发出模型请求。
- 新增 17 项连接/Session 测试使用独立 Node 子进程模拟原生协议；覆盖乱序响应、通知、服务端请求、错误、异常退出、超时及原生 Session 绑定。这些测试不能证明真实 Codex 的恢复、full access 或工具行为。
- 尚未完成：Codex Turn 生命周期和 ACP 事件映射、CLI Agent 选择/启动入口、原生身份的持久化绑定及真实模型/工具/恢复验证。V0 仍未完成。

本轮最终验证：Agent 与 Desktop build、110 项 Agent 全量测试、全仓 typecheck 与 git diff --check 通过。真实 Codex 协议探针通过。

## 2026-09-10 — Codex Turn 状态机与基础 ACP 投影

- 新增 `openCodexTurnRuntime`，在已有原生 Session 连接上串行运行 Prompt，分别等待 turn/start 的确认和匹配的 turn/completed。完成通知先于请求响应时先保留结果，核对两者原生 Turn ID 后才完成 Run。
- 同一 Session 启动中、执行中或最终 ACP 更新写入中均拒绝第二个 Prompt。最终输出持久化/交付失败不记为成功；连接中断、协议错误或原生交互请求不进入等待授权，而是停止执行并返回明确错误。
- 支持启动阶段取消、重复取消合并、等待原生 interrupted 状态；中断确认后一直没有完成通知时终止 native process。关闭 Scope 使未完成 Run 明确失败，不自动重发 Prompt。
- `mapCodexEvent` 将助手增量/最终消息、命令增量/累计最终输出、文件修改和最终 reasoning 投影为 ACP v2 更新。最终正文和工具内容使用替换语义；原生 item ID 与 Turn ID 联合命名，防止多轮串到同一消息。
- 文件变更目前保留路径和原始 diff 文本，没有将未经验证的 patch 格式标记成 ACP git_patch。其他原生 item（例如 MCP、Web Search）及未知事件的完整映射/保留仍待补充。
- 新增 12 项测试，使用真实子进程传输与模拟 app-server 事件，覆盖先完成后确认、ID 不一致、运行失败、并发拒绝、写入延迟、输出失败、原生请求、退出、启动中取消、重复取消、取消超时与 Scope 清理。
- 尚未将此 Runtime 接入 ACP Server/CLI 的 Codex 分支；这些测试验证了原生协议状态机和 ACP 更新数据，尚不是实际 Codex 模型执行或完整 ACP Client → Codex → archive 回放测试。V0 仍未完成。

本轮验证：Agent build、122 项 Agent 全量测试、全仓 typecheck 与 git diff --check 均通过。

## 2026-09-10 — 统一 ACP Backend、Codex CLI 与跨进程回放

- ACP Server 现在依赖 `AcpSessionBackend`，统一管理 Session ID、原生身份归档、消息保存与回放；Pi 和 Codex backend 分别承担原生执行和终态事件，不再由 Server 额外生成一份终态。
- Pi backend 复用现有 Registry 和配置快照；保持模型/thinking 控件、原始用户文本块和稳定错误。客户端刚收到 idle 后的续聊，会等待上一轮交付完全结束再执行。
- Codex backend 为每个 ACP Session 保持独立 Effect Scope / 原生进程，多轮复用；close/shutdown 等待 Scope 释放。当前 Codex 采用本地配置，不提供尚未接通的模型配置控件。
- SessionArchive 的原生身份支持 Pi 文件身份与显式 Codex 类型，统一保存 ACP updates；列表按 Agent 类型过滤，错误 Agent 不能恢复该历史。启动事件等身份 header 完成后再写入；shutdown 等待正在创建的 Session，防止原生进程泄漏。
- 生产 CLI 支持 `folio-agent --agent pi|codex`，默认 Pi；Codex 分支无需 Pi 模型配置，使用本地 Codex 或显式 FOLIO_CODEX_EXECUTABLE。不会自动切换 Agent。
- 新增 ACP 测试覆盖 Codex 多轮、精确归档回放、跨进程原生身份、错误 Agent 恢复拒绝、创建中关闭，以及 ACP cancel 后立即续聊。新增构建产物 stdio 测试覆盖 CLI → ACP → Codex backend → 模拟原生进程 → 归档 → CLI 重启恢复；共享进程测试 helper 将 Folio 路径明确限制在临时目录。
- 这些链路测试的原生端仍是确定性 app-server fixture；真实 Codex 的模型/工具、持久化恢复、完整事件种类、跨进程 Session 独占尚未验证完成。GUI Task/Routine 和 Vault 存储仍待实现，V0 不标记完成。

本轮最终验证：Agent / Desktop build、127 项 Agent 全量测试、全仓 typecheck 与 git diff --check 通过。CLI 产物测试覆盖 Pi 和 Codex 两条跨进程恢复路径。

## 2026-09-10 — Session 跨进程独占与进程退出恢复

- archive 目录增加独立的 execution-owners.db，使用已有 Effect SQLite 驱动和 BEGIN IMMEDIATE 事务，同时保护 ACP ID 和 Agent/native ID；它只是本机执行协调库，不替代后续 Vault 的 Task/Run/messages 数据库。
- 恢复在启动原生 backend 前取得两种身份；新建先取得 ACP 身份，在接受 Prompt 前绑定原生身份和 worker PID。绑定后不能改变 native ID 或 worker。关闭先等待 backend 退出，再按随机 token 释放持有记录。
- 不采用心跳超时接管。只有本机 owner 和已登记 worker 的 PID 均确认退出才允许恢复；进程暂停、权限错误、其他主机或 PID 复用均保守拒绝。没有自动重发 Prompt。
- 新增真实子进程测试覆盖暂停中的持有者、强制终止后的接管、父进程已死但 worker 存活、worker 未退出时释放拒绝，以及事务回滚、重复释放、不可变绑定和异常记录。生产 Codex CLI fixture 测试验证两个 CLI 同时恢复同一 Session 时拒绝竞争者，持有者关闭后竞争者可继续恢复。
- 全量回归发现已有 shutdown 测试在等待关闭后才观察请求失败，新增数据库 I/O 暴露了未处理 rejection 的时序窗口；现在发出请求后立即登记失败断言。
- 边界：独占范围是同一物理 archive 目录；不同配置根目录尚无全局协调。只跟踪 ACP owner 和登记的 native worker，不证明任意脱离进程组的 integration 后台进程都已退出。原生初始化到绑定 PID 之间尚无 Folio Prompt，但不保证用户自定义原生启动钩子没有副作用。真实 Codex 模型执行、完整事件保留、Vault/Task/Routine 与 Git 协调仍待完成。

本轮验证：Agent / Desktop build、全仓 typecheck、133 项 Agent 测试（24 文件）和 git diff --check 通过。CLI 原生端仍使用协议 fixture，没有真实模型请求。RFC 整体未完成。

## 2026-09-10 — Vault Task / Session / Run 执行账本

- Vault 数据库打开时运行版本化 Effect SQLite migration，创建 tasks、sessions、runs；启用外键，以复合关系限制 Run 的 Session 和被恢复 Run 必须属于同一 Task。现有 Vault 注册路径会初始化这些表，不搬迁历史内容。
- 新增 Vault-scoped HarnessStore：保存手动 Task 配置快照、显式创建 Session、绑定独立的 Folio/ACP/native 身份、预留 Run、记录运行和终态。原生身份未知时为 null，不用 ACP ID 代替；原生绑定不可替换，Agent 切换保留旧 Session。
- preparing 即占用 Task；事务和数据库部分唯一索引共同拒绝同 Task 多 Run，同时允许不同 Task 执行。预留查询使用索引，不扫描全部历史。状态写入不启动 Agent、不操作 Git。
- 恢复必须在原 Session 创建新 Run 并指向失败/中断/取消的旧 Run；不覆盖原输入和终态。打开数据库不会自动清除执行中记录或重发 Prompt。调用方确认进程停止后才可记录终态；成功 Run 仍保留 pending 同步状态和 active Task，等待文件检查及 Git 协调。
- 验证真实 SQLite 重开持久化、Vault 隔离、并发预留、不同 Task 并行、跨 Task Session 拒绝、数据库约束、绑定不可替换、恢复和终态不可重写。尚未接入 ACP Client 调度、messages/events 投影、Routine、worktree 或 UI；目前只有 migration 接入生产 Vault 打开路径。

验证：相关 20 项测试通过；全仓 typecheck、Desktop build 和 git diff --check 通过。Desktop 全量 151 项中 149 项通过，2 项 GeneralSettings 测试失败：测试要求 Saving/Saved status，但组件无对应展示；组件及测试与 HEAD 一致，本轮未修改。未将全量测试标记为通过，RFC 整体仍未完成。

## 2026-09-10 — Vault ACP 更新与 messages / tools 投影

- Folio ACP Server 的 session/update notification 增加 `_meta["folio/eventSequence"]`：值为不可变 archive 中从 1 开始的位置。新通知和从头回放使用同一位置；这是明确的 Folio 扩展，不是 ACP 标准 cursor，也没有增加增量 resume 支持。
- Vault migration 增加 acp_updates（每个原始更新的位置）、acp_events（每次接收，包括重复回放）、messages 和 tool_calls。HarnessEventStore 在同一事务中保存原始更新、接收记录和投影，事务完成前不宣称 UI 数据已可用。
- 同 Session / 同 source sequence 的重放仅增加接收记录；内容变更、序号缺口、错误 ACP 绑定和不匹配的 Run 归属明确失败。相同文本使用不同合法序号时仍保留两次。连接代次由调用方提供，不伪造协议自带连接身份。
- 消息与工具按 Folio Session + 协议 ID 区分；实现消息 chunk 追加、upsert 数组替换、omitted 保留、null 清空及 tool patch 语义。未知更新保留原文，尚不提供展示；消息 upsert 不当作执行完成，idle 只结束消息投影，不替代 Run 的脚本退出和 Git 检查。
- 可在事务中从 canonical updates 重建投影，重复接收记录不再次拼接。进程中断不会留下已保存原始位置但未保存投影的半次提交。缺口/协议无效事件当前拒绝写入，需调用方停下并恢复完整回放；通用协议错误审计仍待实现。
- 测试覆盖 SQLite 跨 Scope 恢复/重放/重建、相同文本不同事件、并发重复接收、不同 Session 相同 messageId、消息和工具替换/清空、未知事件、绑定/序号拒绝以及 SQL trigger 注入的投影写入失败回滚。Agent archive contract test 验证新事件与重启 Server 后回放的序号一致。
- 尚未接入桌面 ACP Client 接收链路；本轮仅 migration 进入生产 Vault 初始化。出站用户请求、request/response、权限和协议错误记录、其他展示种类、附件与保留策略仍待完善；不能把此 store 当作完整协议事件审计。仅已验证 Folio archive 序号的适配器可使用此去重策略。

本轮验证：25 项 Desktop 存储相关测试、133 项 Agent 全量测试、Agent / Desktop build、全仓 typecheck 与 git diff --check 通过。上一轮发现的 2 项既有 GeneralSettings 全量测试失败本轮未修改；未声称 Desktop 全量通过。RFC 整体仍未完成。

## 2026-09-10 — ACP Client 与 Vault 账本联调

- 新增 scoped openHarnessAcpClient，接收由上层持有的 ACP Stream，按已保存 Task worktree 和 Folio Session 创建或恢复 ACP 会话，校验原生身份并保存映射。创建响应前的通知先缓存，绑定落盘后串行处理；不会因回放自动发送 Prompt。
- Prompt 前保存并预留 Run，协议响应后记录 running；等待已落盘的 idle 和协议响应都完成后返回。接受响应不代表执行结束，idle 也不会自动 finishRun、提交 Git 或完成 Task。调度层仍需验证相关脚本停止。
- 通知写入 Vault 后才调用上层 onUpdate；重放重复事件不再次发布。连接、协议或存储失败关闭连接，保留 preparing/running 的不确定 Run，不自动重试。默认 full access 下出现权限请求明确失败，不进入隐藏等待授权状态。
- close 合并重复调用、执行中先取消再关闭 ACP Session，并等待协议关闭。实际 Agent 子进程的启动/退出验证仍归上层进程 Scope；本模块不把关闭传输当作所有后台脚本已退出的证据。
- 真实联调发现上一轮投影只处理 idle，错误地拒绝合法 running state_update，现保留其原始记录而不修改消息展示。构造事件单元测试没有覆盖这一运行序列，新增生产 stdio 链路覆盖该问题。
- 4 项生产 CLI 测试覆盖两轮执行、数据库先于交付、关闭后新进程恢复且不重发 Prompt、执行中取消/关闭、重复关闭等待同一清理、并发请求拒绝、投影写入失败保留不确定 Run。使用生产 Folio CLI + Codex backend + 独立 native 协议 fixture，不是真实模型执行。
- 尚未将客户端模块接入 Electron 应用级 Agent 进程管理和 Task/Routine RPC/UI；打包 Node 运行时、worktree 创建、退出恢复协调、完整出站/错误协议审计及恢复回放新增事件的旧 Run 关联仍待完成。应用窗口关闭/退出行为暂未更改。

验证：原有 25 项存储相关测试及新增 4 项 stdio 联调测试通过；全仓 typecheck、Desktop build 和 git diff --check 通过，最后的关闭合并调整已重跑客户端测试与 Desktop typecheck。2 项既有 GeneralSettings 失败未修改，本轮未声称 Desktop 全量通过。RFC 整体仍未完成。

## 2026-09-10 — 独立 Agent 进程与 Session 资源边界

- 新增 openAgentProcess：要求可信应用装配提供绝对 Node/CLI 路径，先用选定运行时验证 standalone Node >=24 和 node:sqlite，再以固定 cwd、明确 Agent 和 Folio 配置目录启动独立进程；不使用 shell，不隐式退回 PATH 上的 Node 或 Electron 可执行文件。
- 使用 Effect ChildProcessSpawner / Scope 管理进程，stdin 通过有界队列提供回压，stdout 转为 ACP Stream，stderr 持续排空且不传入 renderer 日志。Scope 关闭包含正常终止及 2 秒后的强制终止后备；返回的 exitCode 只证明 ACP 进程退出，不证明任意脱离进程组的 Integration 后台程序退出。
- 新增 openHarnessSession，将进程与 ACP Client 放进独立子 Scope，并附属上层 Vault/应用 Scope。Agent 类型与 cwd 从账本读取；启动失败立即清理部分资源；close 合并调用并等待子 Scope/进程清理，而不只等待 ACP close 回复。
- 生产 stdio 联调用例改用上述生产进程与 Session 入口，替换测试专用 spawn helper；验证正常结束和执行中关闭后 PID 已不存在。额外测试覆盖大量 stderr、忽略 SIGTERM 的真实子进程、无效运行时路径、进程提前退出。
- 客户端初始化/关闭等待消息交付队列也受协议超时约束，避免上层 onUpdate 永不返回阻塞应用清理；任务执行本身仍没有该时间限制。新增停滞回调用例验证超时后进程已退出、未误报 Run 成功。
- 尚未在打包资源中提供 standalone Node/Agent 入口，也未接入 Electron 应用服务、Task UI、worktree 或生命周期事件。当前测试使用开发机独立 Node 和生产 CLI 构建产物，不能证明 packaged Windows/Linux/macOS 可运行；Electron-as-Node 方案仍未采用。V1/V2 整体未完成。

本轮验证：34 项存储/进程/stdin ACP 联调测试（6 文件）全部通过；全仓 typecheck、Desktop build 与 git diff --check 通过。最后队列等待调整已通过相关测试和全仓 typecheck；既有 GeneralSettings 失败本轮未修改，未声称 Desktop 全量通过。RFC 整体仍未完成。

## 2026-09-10 — 新 Vault main 工作区与反向链接

- VaultService 的生产注册/打开路径现调用 initializeVaultWorkspace：新 Vault 在自身配置目录建立 workspace Git 仓库、main 初始提交、wiki、raws、AGENTS.md 和 .gitignore，再将用户选择的空目录转换为指向 workspace/wiki 的链接（Windows 代码路径使用 junction，尚未在 Windows 实测）。
- 初始仓库在同文件系统临时目录中完成，再原子发布；只提交 Folio 创建的 AGENTS.md 和 .gitignore，数据库/原生 Session 不进入仓库。初始化 commit SHA 保存于 .git/folio-workspace.json。已有 workspace 只校验归属/初始提交/main 分支，不重写用户 AGENTS.md、不提交未保存内容。
- 稳定 Vault.path 保存用户入口路径；再次选择该路径、其别名或实际 wiki 路径时按真实目标复用 ID。入口丢失后可用已登记身份重建链接，不丢失内部内容；Git 或数据库初始化失败保留 ID 供重试。
- 非空新目录在登记前明确拒绝，不实现历史迁移。发布链接使用 rmdir 而非递归删除：若空目录检查后出现新文件，操作失败并保留文件和已经建好的内部仓库。原有非空历史目录不转换为新布局。
- Git 命令检查真实退出码并限制执行时间，屏蔽继承 GIT_* 定位变量和系统/全局 Git 配置，禁用初始化模板、hooks、fsmonitor 与签名，避免初始化受用户其他仓库环境影响。现有 workspace/.git/wiki 必须是实际目录，不能被符号链接重定向。
- 生产 MainLive 增加 ChildProcessSpawner 依赖。修复了整段移动 scoped 临时目录导致清理失败的问题：仅移动其内的完整仓库，临时容器仍由 Scope 清理。
- 16 项 VaultService 测试通过，含真实 Git 初始提交/跟踪范围、反向链接、重开/别名去重、修复丢失入口、保留未提交编辑、Git 不可用重试、继承 Git 环境隔离和发布阶段并发用户写入。此轮仅建立 main 仓库，不声称 Task worktree、Git 自动同步或已打包 Agent 运行时完成。

验证：全仓 typecheck、Desktop build、git diff --check 通过。Desktop 全量回归 168 项中 166 项通过，仍为此前 2 项 GeneralSettings 状态文案测试失败；随后新增并发写入用例并重跑 VaultService 全部 16 项通过。RFC 整体仍未完成。

## 2026-09-10 — Task worktree 创建与 Git/DB 中断恢复

- 新增 TaskWorktrees，在保存 Task 身份/快照后为其创建独立 folio/task/{id} 分支和 worktrees/{id}。目录和分支从受限 Task ID 生成，不接受任意工作区路径替换。Git runner 从 Vault 初始化中提取复用，保留环境隔离、退出码检查和进程超时。
- Vault migration 增加 worktree_state（pending/creating/ready）与 worktree_base。创建前登记 creating 和基线，真实 checkout 验证后才发布 ready；Session 创建、Run 预留和进程 Session 打开均要求 ready。
- 当前变更账本尚未实现，因此只把 workspace 初始化 marker 中的 commit 视为已登记 main 基线；发现后续未登记 main commit 或 main 检出位置/分支不符时拒绝新建 worktree。不会自动把外部提交当作 Folio 保存。main 未提交文件不参与 Task checkout，也不被删除。
- Git worktree add 成功而数据库 ready 写入失败后，保留 creating 和原目录；重开服务后验证 Git common-dir、任务分支、HEAD 和干净状态，满足条件才发布 ready。中断现场存在新增文件时保留并拒绝自动修复，不 reset/clean/force checkout。
- ready worktree 的再次 ensure 只校验身份，不丢弃未提交 Task 编辑；有 active Run 时拒绝资源操作。空 wiki/raws 目录由 Folio补建，因为 Git 不保存空目录。
- 生产 stdio 联调的 setup 现经过真实 Vault Git 初始化 → TaskWorktrees → Session 进程 → ACP → Vault messages，实现了任务目录真实隔离的模块联调。存储单元测试用显式 SQL fixture 标记模拟资源 ready，不把它们当作真实 Git 验证。
- 新增 5 项真实 Git/SQLite 测试，覆盖两 Task 隔离、未保存 main/Task 文件保留、数据库故障后恢复、存在新编辑时拒绝恢复、ready 执行门槛、active Run 拒绝以及外部 main 提交/错误路径拒绝。
- 尚无 worktree 删除、完成后重建、提交同步或应用 Task RPC/UI。清理必须等 Session 退出和同步账本接通后实现；本轮未提供只按 Run 状态删除文件的入口。V1/V2/V3 整体仍未完成。

验证：35 项相关测试（5 文件）通过，其中 5 项 stdio 联调已使用真实 Task worktree；全仓 typecheck、Desktop build 与 git diff --check 通过。随后补充严格 SHA/主分支检查和 Run ready 门槛断言，TaskWorktrees 5 项再次通过。既有 GeneralSettings 失败未修改，本轮未声称 Desktop 全量通过。RFC 整体仍未完成。

## 2026-09-10 — Electron 窗口关闭与显式退出

- 关闭最后一个窗口不再退出应用，各平台均保留应用级执行资源。ElectronApp 的事件监听和 Quit 拦截由外层 Layer 持有，不随窗口或事件流消费结束而提前释放。
- 显式 Quit 先 preventDefault 并结束应用工作流；依赖服务的 Scope 清理完成后，移除拦截再调用 Electron quit。清理过程中重复 Quit 仍被拦截，不跳过子进程清理，也不处理新窗口激活。
- 测试使用真实 Node 子进程和模拟 Electron 事件：无窗口时进程仍存活；重复退出请求等待清理屏障；最终 quit 前进程和窗口资源已释放。MainLive 组合测试覆盖外层 Layer 的清理顺序。生命周期相关 8 项测试通过，尚非打包 Electron 端到端验证。
- Agent 启动前的 standalone Node 探测现在同时检查输出与实际退出码，并在独立 Scope 中排空 stderr、释放探测进程。新增真实 Node 用例验证输出合法版本信息后非零退出仍拒绝启动 Agent。
- 应用级 Session 管理、Task RPC/UI 和打包 Node/CLI 仍未接通。退出时尚无协调器自动将数据库 Run 记为 interrupted；现有模块保留 preparing/running 的不确定记录，不假报成功，也不自动重发 Prompt。不能据此证明任意脱离进程组的 Integration 后台程序已经退出。

验证：生命周期修改后的 Desktop 全量 175 项中 173 项通过，2 项仍是未修改的 GeneralSettings Saving/Saved 状态展示测试失败；全仓 typecheck、Desktop build 与 git diff --check 通过。随后补充运行时退出码检查，进程与生产 stdio ACP 联调共 10 项通过，Desktop typecheck 通过。RFC 整体仍未完成。

## 2026-09-10 — Task 应用服务、RPC 与知识库入口

- TaskService 已进入 MainLive；通过 LayerMap 按已登记 Vault ID 持有独立数据库、TaskWorktrees 和创建锁，资源在应用 Scope 结束时释放。不同 Vault 使用 fresh layer，避免共享同一个 HarnessStore 实例；每次请求重新验证全局 Vault 索引，renderer 不能提供 worktree 路径或分支。
- 新增 tasks.create / tasks.list / tasks.get RPC。创建持久化手动目标和明确 Agent；尚无能力选择装配，快照中的 skillIds / integrationIds 为空。详情返回 Task 及其 Session/Run 历史，不创建 Session、不启动 Agent。
- 创建请求采用调用方保留的 UUID。相同 ID/目标/Agent 的重复请求返回已有 Task；pending/creating 可沿用身份恢复工作区；同 ID 不同目标/Agent 明确拒绝。ready Task 的重试是只读操作，不因已有执行或未提交文件而重建工作区。Git/DB 中断现场保留并可从列表发现。
- 知识库概览增加任务目标输入、默认 pi / 可选 Codex、创建按钮和任务列表。支持加载失败刷新与未就绪工作区的原 ID 重试；表单在提交中阻止重复请求，丢失响应后重试保留 ID。界面明确说明执行入口尚未接通，未把“工作区已就绪”显示为任务执行成功。
- 新增真实 Git/SQLite/RPC 测试，覆盖并发重复请求、跨 Vault 相同 Task ID 隔离、未知 Vault 不创建存储、输入不匹配拒绝、Git 成功后 DB 写入失败及恢复、客户端释放和应用重启后历史/编辑保留。渲染组件测试覆盖默认 Agent、重叠提交、响应丢失重试和历史未完成任务重试。
- 仍待实现应用 Session 管理、Run 调度/终止记录、模型选择、Agent 运行时打包和执行/消息 UI。列表目前按需刷新；没有自动订阅任务变化。仅已登记的初始化 main commit 可作为新 worktree 基线，后续用户保存/变更账本与 Git 同步仍待接通。

验证：Desktop 全量 180 项中 178 项通过，失败仍为未修改的 2 项 GeneralSettings Saving/Saved 状态测试。全仓 typecheck、Desktop build、git diff --check 通过。尚未进行打包 Electron 的人工界面或真实模型端到端验证。RFC 整体仍未完成。

## 2026-09-10 — Vault Session 进程注册表与并发启动

- 新增 HarnessSessions Layer，持有 Vault 的 live Session 注册表。相同 Folio Session 的并发 open 合并到一个启动结果；不同 Task 可以并行初始化。资源由独立后台 Fiber/Scope 持有，请求 Scope 结束或请求方在启动途中被中断不会停止 Agent。
- 同一 Task 的另一个 live Session（含启动/关闭中）占用槽位，必须显式 close 后才能打开其他 Session，不自动切换 Agent。首次打开前拒绝未就绪/终态 Task，以及尚有 preparing/running Run 的不确定现场；已打开 Session 可以复用。
- close 合并重复请求，等待 ACP/native 资源清理后才移除槽位；关闭请求的调用方退出也不会提前释放槽位。启动中关闭会结束等待者，保留 Folio Session 记录供显式重试。启动失败不会因另一个 open 请求而自动重试，需先显式 close。
- 注册表只打开已有 Folio Session；不生成 Run、不发送 Prompt、不从 idle 推断执行/Git 完成、不自动修改不确定 Run。返回的执行句柄没有绕过注册表的原始 close 方法，避免已关闭进程仍被当作可复用对象。
- 新增真实生产 CLI + native fixture + SQLite/Git 的 4 项测试，覆盖上述并发、请求中断、启动中关闭、重开身份/无 Prompt 重放、失败保留和未解决 Run 拒绝。应用 ManagedRuntime dispose 后验证 ACP/native PID 均退出；未证明任意脱离进程组的 Integration 后台程序退出。
- 并发首次打开暴露了 SessionLeaseStore 的 SQLite journal-mode 竞争：两个进程同时设置 WAL 会报 database is locked。协调库现使用 disableWAL，保留已有 journal mode，继续使用短事务和既有 busy timeout；不重试所有权变更。新建库使用 SQLite 默认 journal mode，已有 WAL 库无需转换。多 Task 并发启动随后通过，既有全部独占/恢复测试也通过。
- 此注册表模块尚未接入 MainLive 的 Vault 资源装配，仍需要可信 standalone Node/CLI 打包路径与模型选择接通后开放 Task 执行 RPC/UI。Quit 时 Run 的 interrupted 记录与实际执行协调仍待实现，不能把进程注册表测试等同于产品端到端执行完成。

验证：Agent build、133 项 Agent 全量测试、11 项 Desktop Session/ACP/Task RPC 测试、全仓 typecheck、Desktop build、git diff --check 通过。本轮未重跑 Desktop 全量；上轮 2 项既有 GeneralSettings 失败未修改。临时诊断输出已移除。RFC 整体仍未完成。

## 2026-09-10 — 独立 Node / Agent 打包与应用资源解析

- 新增 prepare-agent-runtime.mjs：构建 Agent，在仓库外临时 workspace 中按现有 lockfile 只安装 Agent 生产依赖，复制构建进程使用的 standalone Node >=24 和许可证；不使用 Electron-as-Node，不在运行时调用 npm。安装脚本禁用，保留依赖包资产与许可证。
- 准备过程验证相对依赖链接不越出 bundle、实际 Node/SQLite、真实 Pi read/write 工具，以及 Pi/Codex CLI 的 ACP v2 initialize 和正常退出。所有检查使用临时 Folio 配置，无 Prompt、无模型请求、无用户 Codex Session 创建。首次链接校验发现 macOS /var 到 /private/var 的路径别名，临时根现统一为 realpath 后再检查。
- electron-builder beforePack 按实际目标平台/架构准备 Resources/agent-runtime；不匹配构建机时明确失败，需要目标原生构建机。开发启动先准备 .agent-runtime/bundle。Node 版本、Node SHA-256 和 lockfile SHA-256 写入 runtime.json，生成产物不进入 Git。
- 新增 AgentRuntime，按应用提供的资源根惰性读取清单，验证平台/架构和固定文件路径；不允许清单重定向执行路径，不退回 PATH Node。该服务已装入 MainLive，资源缺失不会在读取前阻止偏好设置/知识库浏览。Agent 启动仍会再次检查真实 Node/SQLite，并将所选 Node 的目录放入子进程 PATH，供 Integration 脚本使用。
- 在当前 macOS arm64 上成功生成 .app 目录产物；对实际 Resources 中的 Node 重跑 SQLite、Pi 文件工具与两个 CLI 握手，确认包内 ACP server/Codex backend 与最新编译产物字节一致。构建未签名，不代表可分发签名/公证验证完成；Windows/Linux 尚未实测。当前运行时约 828 MB 未压缩，体积优化仍待处理。
- 全量并发回归暴露旧 Session 启动测试依赖 1 秒等待窗口。改成显式文件屏障后，进一步发现真实缺陷：Codex 卡在 initialize 时，ACP shutdown 只等待 opening，父进程可能先被强制结束。现由 Server 发出启动取消信号，Codex backend 中断初始化 Effect 并等待其 Scope/native process 清理，再释放所有权。启动中关闭回归现无需等待原生初始化自行返回，关闭返回前 native PID 已退出。
- 测试工作区同时并行运行时，若干原有 5 秒/短等待测试受主机负载影响超时；按工作区顺序复核后 Agent 133 项全通过，Desktop 187 项中 185 项通过，剩余仍为未修改的 2 项 GeneralSettings 状态展示失败。全仓 typecheck、Desktop build/目录打包及 git diff --check 通过。
- Session 注册表仍需接入 Vault/Task RPC；模型选择、Vault 原生历史与全局凭据路径分离、Run 终止账本、执行/消息 UI、Git 同步和 Routine 仍未完成。本轮没有把包内 initialize 当作完整 Agent 执行能力。

使用方式与限制见 [Agent runtime packaging](./agent-runtime-packaging.md)。RFC 整体仍未完成。

## 2026-09-10 — Vault 历史目录分离与 Session RPC 接线

- CLI 增加独立的 FOLIO_SESSION_STORAGE_DIR 解析。ACP archive/ownership 数据库写入该根的 acp-sessions，Pi 原生历史写入 sessions；全局 Agent 配置、Provider 凭据和模型派生文件仍使用 FOLIO_AGENT_DIR。未提供新变量的 standalone CLI 保留原有默认目录，不搬迁历史文件；原生 Codex 仍使用其本地安装管理的存储。
- Desktop AgentProcess / HarnessSession 显式传递历史根，且未指定时使用本次显式 Agent 目录，不继承宿主可能遗留的历史根变量。打包验证和 stdio 测试也明确设置临时历史根，避免触及用户历史。
- TaskService 的每个 Vault resource layer 现装配 HarnessSessions 和 HarnessEventStore。运行时路径惰性读取；凭据目录复用与 ModelService 相同的目录解析规则，包含 FOLIO_AGENT_DIR 覆盖；历史固定为 vaults/{id}/agent-history，位于 Git/worktree 之外。
- 新增 tasks.openSession / tasks.closeSession RPC。打开先保存独立 Folio Session ID、明确 Agent 和实际 adapterVersion，再启动/恢复 ACP 并落盘原生绑定；相同 ID/Agent 可重试，已有身份不能改 Agent。注册表合并并发打开，资源独立于 RPC 客户端，关闭等待进程退出。此入口不创建 Run、不发送 Prompt、不自动切换 Agent。
- Pi 目前仍需要已有有效全局 model profile；不会为了打开会话随意选择模型。任务级模型选择及相应配置快照仍待实现。当前 UI 仍仅创建/列出 Task，没有新增不可执行的 Prompt 控件。
- 新增真实 Pi CLI 跨进程测试，验证 Vault 历史隔离、错误 Vault 恢复拒绝、原 ID 重开以及共享 managed 凭据文件保持原样；原生文件路径和 ACP header 均指向所选历史根，凭据未写入历史。Composition 测试验证 native 目录变化不改变凭据读取位置。
- 新增真实 Task RPC → registry → CLI → Codex 协议 fixture 联调，验证同时打开去重、客户端释放后 native PID 存活、显式关闭/应用释放后 PID 消失、绑定身份重开不变、Runs 保持为空，以及缺失运行时仍可创建/浏览 Task 且不分配 Session。

验证：全仓 typecheck、134 项 Agent 全量测试、Desktop build、开发运行包准备（含 Node/SQLite、Pi 文件工具和两种 ACP 握手）、git diff --check 通过。Desktop 全量 189 项中 187 项通过，仍为 2 项既有 GeneralSettings 失败。本轮未重新生成 .app；打包命令的 beforePack 会使用最新 CLI。任务执行调度、模型选择、Run 终态协调、消息 UI、Git 同步与 Routine 仍未完成。

## 2026-09-10 — 显式会话模型与配置隔离

- Task 会话区已接通新建、连接/恢复和关闭连接。Pi 必须显式选择已配置 Provider 的内置模型；当前思考级别为 off。Codex 使用本地 CLI 配置。界面不会预选第一个模型，不会发送 Prompt，也不把连接成功显示为任务完成。
- ModelService 根据模型目录及全局凭据验证选择，生成无密钥 ModelProfile；不创建全局 profile、不改默认模型。TaskService 复用同一个 ModelService 和凭据目录。新 Pi Session 缺少选择、Provider 凭据缺失或模型无效时，在分配 Session 前失败。
- Vault migration 0004 添加 Session model_profile 快照。相同 Session 的重试不能更改 Agent、Provider、模型或思考级别；恢复可以省略选择并沿用快照。旧的无模型快照 Pi Session 明确拒绝猜测恢复；没有搬迁内容或原生历史。
- Desktop 使用 FOLIO_SESSION_MODEL_PROFILE 传递严格验证的非敏感快照，CLI 在此模式下不再依赖全局 AgentSettings。FOLIO_SESSION_RUNTIME_DIR 指向 vaults/{id}/agent-history/runtime/{sessionId}，隔离 generated models 与 models-store；auth.json 仍由全局 Agent 目录管理。Desktop 显式覆盖这两个环境变量，避免继承宿主的其他会话配置。
- 新增真实 RPC → Pi CLI 初始化/恢复联调，验证仅添加 Provider 即可初始化、凭据缺失不分配 Session、模型不可变、全局配置变化后身份不变、Runs 为空、运行目录不含凭据文件。测试未调用模型。并发 custom-provider composition 测试验证派生文件独立、全局凭据不变；渲染测试覆盖显式选择、过滤未配置 Provider、丢失响应重试和恢复不覆盖模型。
- Agent 全量 136 项通过；Desktop 全量 192 项中 190 项通过，失败仍为既有两项 GeneralSettings 状态展示测试。完整执行、消息展示、Run 终态协调、Git 变更账本与同步、Routine 仍未完成。

补充恢复边界：检查已安装 Pi SDK 后确认，其默认仅在存在消息时恢复模型/思考配置。Folio factory 现显式读取原生 Session 的已保存配置，并在缺失时使用显式 profile，避免尚未发送消息的会话重开后换成 Provider 默认模型。生产 stdio 测试对比重开前后的完整 configOptions，Agent 136 项回归再次通过。

本阶段全仓 typecheck、Desktop build、开发运行包 prepare:agent（Node/SQLite、Pi 文件工具与 Pi/Codex ACP 握手）及 git diff --check 通过；最后的恢复修正后，11 项 Desktop 会话/注册表/渲染相关回归通过。本阶段未重新生成 .app，也未进行真实模型请求或人工 Electron 界面验收。

## 2026-09-10 — 应用 Run 调度、取消与对话入口

- 新增 Vault-owned HarnessRuns：独立应用 Fiber 执行 Prompt，RPC 请求或窗口离开不结束 worker。执行前验证真实 worktree/已登记基线；Renderer 不提供路径、commit 或自动冲突解决用途。ACP Client 保存 Run 后通过 onReserved 返回受理记录，再发出 Prompt。
- tasks.startRun 使用稳定请求 UUID；相同输入重试返回原 Run，不重新派发。不同输入复用 ID 拒绝；同 Task 的多 Session 共享执行占用，恢复明确创建新 Run 并关联旧 Run，不盲目重发旧指令。
- Run 终态从已持久化 idle、Prompt acknowledgement 和当前 Run 已知工具终态共同判定。idle 时仍有未完成工具则关闭 Session 并记 interrupted。正常前台结束允许后续对话；所有同步状态仍为 pending，不触发 Git 写入、不宣称 Task 完成，也不证明任意后台写入已经停止。
- tasks.cancelRun 在应用 Scope 内取消并等待 Session/client/native 资源清理；底层 Prompt Promise 确认收束后才写终态，避免迟到 acknowledgement 把已结束 Run 改回 running。正常 Quit 先清理 Run，再释放 Session 与 SQL；未完成 Run 记 interrupted，保留文件。重复取消已终态 Run 是只读操作。
- Native Codex 的连接失败/异常关闭与已完成的失败 Turn 原本都会映射成 refusal。新增显式 Folio 扩展 state_update._meta["folio/executionInterrupted"]，区分未获得可靠终态的中断和普通失败；前者触发 Session 清理并在 Vault 记 interrupted。ACP 标准 stopReason 仍保留。
- 新增 tasks.sessionHistory，验证 Vault、Task 与 Session 归属后返回持久化消息/工具投影。Task 会话区可查看对话、发送指令、停止运行和选择历史 Run 接续；接续要求新输入，不自动复制执行旧 Prompt。内容以文本渲染；运行期间轮询存储，终态再刷新一次避免最后消息丢在 UI 查询竞态中；卸载界面只移除显示计时器。
- 真实 Git/SQLite/RPC → 生产 ACP CLI → native 协议 fixture 联调覆盖请求去重、多轮执行、跨客户端持续、取消、Quit 中断与重启不重放、恢复关联、普通失败、native 崩溃、idle 时未完成工具、消息投影失败及跨 Task 读取拒绝。渲染测试覆盖重复请求、执行占用、显式取消、恢复必须新指令和文本不解释为 HTML。本阶段没有使用真实模型发起网络请求。
- 强杀 Folio 后的进程所有权核对/Run 恢复仍未接通；此类未知 preparing/running 现场继续阻止新执行，不能自动取消或重发。任意脱离进程组的后台写入终止证明、完整 ACP 请求/响应审计、事件回放缺口的 Run 归属、Git 提交/同步、Integration 装配与 Routine 均未完成。

验证：Agent 全量 136 项通过；Desktop 全量 200 项中 198 项通过，失败仍为既有两项 GeneralSettings 状态展示测试。全仓 typecheck 通过。RFC 整体保持实施中。

最后的错误映射/历史显示调整后，13 项 RPC 与对话组件相关测试通过，Desktop build 与 git diff --check 通过。开发运行包已重新准备并通过 Node/SQLite、Pi 文件工具和 Pi/Codex ACP 握手；本轮未重新生成 .app，未进行真实模型请求或人工 Electron 界面验收。

## 2026-09-10 — 异常终止后的显式检查与归档补读

- 新增 tasks.inspectRun 与对话中的“检查运行状态”。本应用仍持有执行 worker 时拒绝检查；已终态记录只读返回。遗留 preparing/running Run 必须先通过本地 Session 注册表及持久化 ACP/native 双重独占校验，再记为 interrupted。检查不会启动 Agent、发送 Prompt、宣称原 Run 成功或触发 Git 同步。
- HarnessSessions.withStoppedSession 在同一个本地 gate 内核对 Task/Session、cwd、Agent 与原生 ID；借用既有 SessionLeaseStore 协调库持有 ACP 和 native 身份，直到归档读取和数据库协调完成后释放。旧 owner 死亡但 native worker 仍存活、外地主机、权限不明或 PID 复用均拒绝接管，不根据时间戳推断进程死亡。
- SessionLeaseStore 的恢复模式要求已有有效协调数据库和表，缺失、被替换为符号链接或损坏时拒绝，不能创建空表来冒充“无人执行”。原生恢复、bind 和 release 也使用此规则。新建 Session 仍正常初始化协调库；不自动重建丢失的历史所有权证据。
- SessionArchive 增加只读 immutable header 接口。持有执行所有权后才读取完整日志；无法解析、截断、原生身份不匹配或比 Folio canonical 序列更短的归档均阻止协调。有效归档中未送达 Folio 的尾部会写入事件库与消息/工具投影；已存在事件继续校验内容并去重，不改原 Run 关联，新补读而无法证明所属 Run 的记录以 null 关联保留并显示在其他会话记录中。
- 历史目录独立传给 Session 服务，缺失 Agent 运行包仍能检查并读取停止的执行。用户确认记录后输入新指令，以 recovery Run 关联原 Run；会话恢复继续沿用原生 ID。不会重放旧 Prompt。
- macOS 上的真实生产 CLI/native fixture 测试直接 SIGKILL ACP owner，保留孤儿 native worker，验证旧进程及孤儿存活都阻止接管；native 停止后才允许检查。测试覆盖缺失协调库不重建、截断/缩短归档拒绝、补读模拟的未送达尾部、既有 Run 关联保留、无运行包检查、请求幂等、未提交文件保留、恢复新指令与原生身份不变。此孤儿回收测试仅在 macOS 执行；其他平台的真实孤儿回收仍待验证。
- 仍存活的孤儿不会被检查接口擅自终止；跨平台进程树清理和任意后台写入停止证明仍未完成。完整 ACP 请求/响应审计及补读事件精确 Run 归属、Git 提交同步、Integration 装配和 Routine 继续待实现。

验证：Agent 全量 137 项通过；初次 Desktop 全量 202 项中 200 项通过，仍只有既有两项 GeneralSettings 失败。归档尾部补读与完整性检查补充后，20 项 RPC/事件库/对话组件相关测试及全仓 typecheck 通过。RFC 仍在实施中。

最终 Desktop 全量回归仍为 202 项中 200 项通过，仅两项既有 GeneralSettings 失败；Desktop build、开发运行包准备（Node/SQLite、Pi 文件工具与 Pi/Codex ACP 握手）和 git diff --check 通过。本轮未重新生成 .app，未进行真实模型请求或人工 Electron 界面验收。

## 2026-09-10 — 显式 Skill 挂载的进程传递

- HarnessSession → AgentProcess → CLI → runtime composition → Pi factory 已传递显式 skillPaths，通过 FOLIO_SESSION_SKILL_PATHS 的 JSON 数组跨进程传输。未选挂载时显式传空数组，不继承宿主其他会话的选择。
- CLI 检查绝对路径和 SKILL.md 文件是否存在，将目录归一为入口文件并去重。相对路径、损坏 JSON、缺失入口等在 ACP 初始化前失败，错误不暴露原路径。此检查只验证文件可用性，不保证 Skill 内容有效、不可变或构成沙箱。
- 真实 Pi runtime composition / Session 测试证明选定 Skill 进入 system prompt，未选全局 Skill 不进入；已有原生文件/脚本工具测试继续通过。没有发出模型请求。
- Codex 显式 Skill 装配尚未实现；非空挂载在 Desktop 和 CLI 入口均明确拒绝，不能静默忽略。普通无 Skill 的 Codex 会话维持现有行为。
- 此轮仅接通运行时入口，尚未接通 Task 的 Integration/Skill 选择、持久资源快照、Lark onIngest 和脚本环境装配；当前 TaskService 仍创建空资源选择，不能宣称用户已能在任务中使用所选 Integration。

验证：Agent 全量 145 项通过，新增真实 composition 加载用例后该文件 9 项通过；Desktop 进程边界 6 项通过；全仓 typecheck、Desktop build、开发运行包准备（Node 24.15.0 / darwin-arm64，含 SQLite、Pi 文件工具与两种 ACP 握手）和 git diff --check 通过。本轮未重新生成 .app。

## 2026-09-10 — Task 的 Integration 选择与 Pi 资源装配

- Task 创建界面可显式选择已连接的 Integration；RPC 校验安装状态，按排序去重后的 ID 保存配置。相同 Task ID 重试必须保持原选择，连接后续失效不改变历史配置。尚未提供独立 Skill 选择。
- IntegrationService.prepare 根据目录中的 provider 实现重新绑定已登记资源，校验连接、Skill 文件和 CLI 目录，既不安装也不发起授权或数据采集。只有 Integration 自己理解 CLI 和认证；TaskService 不导入 Lark。
- Lark IM / Email 的 onIngest 现在声明对应 Skill、共享 lark-shared 和受管理 CLI 目录。宿主不复制凭据；当前 Lark check 负责核对 CLI 和 Folio 的账户身份。
- Session 启动/恢复根据 Task 的 Integration ID 重新装配资源，缺失或失效时保留 Session 身份并拒绝启动；无资源的 Task 不执行 Integration 检查。PATH 顺序为 bundled Node、所选工具目录、宿主 PATH，避免工具目录中的 node 遮蔽运行时。
- 当前只开放 pi 的 Integration Task，Codex 资源装配尚未实现。Provider 返回额外环境变量或尚无消费通道的 instructions 会明确失败，不静默丢弃。
- 测试覆盖未安装/未连接/未知资源、丢失挂载、账户健康检查失败、配置重试、真实 Pi Session 打开和身份保留，以及子进程按命令名执行选定工具。Integration 55 项测试通过，2 个 live 测试跳过。没有真实模型或 Lark API 请求。

尚未完成：资源文件版本/内容快照、Skill 独立选择、Codex 装配、真实模型调用 Lark、raws 来源和后台写入停止验证，以及 Routine。已持久化的是资源引用，不能宣称历史 Task 使用的 Skill 字节已固定。

本轮最终验证：Desktop 全量 207 项中 205 项通过，失败仍只有两项既有 GeneralSettings status 断言；报告 `/tmp/folio-desktop-integration-mount-tests.json`。全仓 typecheck、Desktop build 和 git diff --check 通过。本轮未重建 .app，未进行人工 Electron 界面或真实账户数据采集验收。

## 2026-09-10 — Task 资源内容快照与恢复检查点

- Task 首次 Session 装配时，将所选 Skill 完整目录（含相邻脚本和 references）及 CLI 目录复制到 Vault 的 `resources/{taskId}/`，保留安装内的相对路径关系。复制范围不包含 Integration 安装根，Lark 的 private.json 不进入快照。
- 新增 task_resource_snapshots 表，以 Task ID 关联实际文件清单、SHA-256、可执行属性、路径映射和 preparing/ready 状态。先提交预期清单，再发布非空快照目录，最后记录 ready；文件系统和 SQL 不被当成共同事务。
- 后续 Session 使用已登记的副本。安装内容改变不会替换历史 Task 的资源；快照文件、可执行属性、目录内文件集合变化或路径被重定向时拒绝恢复。已有 ready 快照丢失，或目录存在但登记丢失时，不能静默重建。
- preparing 状态下已发布目录的最终回执可补写；尚未发布时，只有当前源内容仍与已登记清单完全一致才允许重建。两个并发装配请求以数据库中的清单和实际目录内容核对胜出结果，不覆盖另一份快照。
- 连接健康仍动态检查；账号凭据不复制或冻结。Provider 必须将声明的 asset 目录保持为无凭据资源。完整文件验证不构成沙箱，不能阻止 full-access Agent 在运行期间修改内容；检查覆盖启动/恢复，电源故障耐久性、跨平台行为及恶意并发修改均未作保证。
- 资源内容固定的时点是第一次 Session 装配，不是 Task 创建。Skill 独立选择、Codex 挂载、资源回收/跨 Task 去重及 Routine 仍待实现。当前采用每 Task 独立副本，后续生命周期清理不能只处理 worktree。

验证：资源快照 13 项测试通过，包含真实 macOS arm64 Lark CLI 从复制目录执行 --version；没有 Lark API 或模型请求。新增该 native 用例前的 Desktop 全量 219 项中 217 项通过，仅两项既有 GeneralSettings 失败；报告 `/tmp/folio-desktop-resource-snapshot-tests.json`。真实 Task RPC 测试覆盖 Integration 更新后的同一 Pi 身份恢复。Desktop 类型检查与构建通过，未生成新 .app。

## 2026-09-10 — Codex 显式 Skill 挂载与原生上下文验证

- 已核对本机 codex-cli 0.153.4 生成的 JSON schema：skills/extraRoots/set 接收 extraRoots；skills/list 接收 cwds/forceReload；turn/start 的 input 支持 type=skill、name、path。官方 [app-server 文档](https://developers.openai.com/codex/app-server)确认 extra roots 只在当前进程生效、不持久化；[配置 schema](https://developers.openai.com/codex/config-schema.json)声明 skills.include_instructions。
- 独立 native app-server 用命令行覆盖关闭自动 Skill 目录，并在 thread/start 或 resume 前通过 config/read 检查生效值。所选 Task 快照目录通过进程级 extra roots 加载；按精确路径核对 native 返回的名称、启用状态及 cwd，再把所选 Skill 显式加入每轮 turn/start 输入。不调用 skills/config/write，不改用户持久配置。
- 缺失、禁用、重复名称、错误 cwd 或不符合协议的结果明确失败。未选 Skill 的目录项不转入 Prompt；关闭自动目录不构成访问控制，也不清除历史对话中已有的内容。未知或不支持这些接口的 native CLI 不自动降级或切换 Agent。
- Desktop 已允许 Codex 选择 Integration，并与 Pi 复用 Task 资源快照及 CLI PATH。切换新任务 Agent 时保留资源选择；同 Task 的 Agent 切换仍须用户显式新建 Session。
- 新增 `npm run test:codex-skills --workspace=@folio/agent`：真实 Codex 进程使用临时 native 配置和本地 Responses 模拟服务；通过生产 Turn adapter 执行两轮，中间关闭并恢复同一 native Session。捕获的模型请求确实包含所选 Skill 正文，且不包含未选 fixture Skill；禁用所选 Skill 后拒绝新 Prompt。native debug prompt-input 另验证自动目录开关。没有真实模型推理、Lark API 调用或用户配置写入。
- 跨进程 CLI/ACP fixture 测试检查原生 turn/start 的具体 Skill 输入；Desktop RPC 用真实 Pi 与 Codex fixture 分别覆盖资源快照创建和恢复。原生工具执行、真实模型/Lark 数据链路以及其他 Codex 版本/平台仍需验收。

Agent 全量 152 项测试、全仓 typecheck 和真实 Codex 本地模型服务探针通过。Desktop 全量 221 项中 219 项通过，仅两项既有 GeneralSettings 失败；报告 `/tmp/folio-desktop-codex-mount-tests.json`。Desktop build、开发运行包准备（Node 24.15.0 / darwin-arm64，含两种 ACP 握手）和 git diff --check 通过，未生成新 .app。

## 2026-09-10 — Codex 原生命令执行与失败投影

扩展 codex-skills-spike.mjs，先从真实 native 模型请求核对 exec_command schema，再由本地 Responses fixture 返回工具调用。真实 Codex 运行所选 Skill 旁的 Node 脚本，默认 cwd 为临时 Task 目录，实际写入 wiki/fixture.md 和 raws/fixture/cwd.txt；关闭并恢复同一 native Session 后执行退出码为 7 的命令。

探针断言 ACP execute 工具的 in_progress、completed/failed 状态及最终输出，并检查回传模型的 function_call_output 包含输出标记和正确退出码。临时 Git 仓库的 HEAD 在两轮之后保持不变。HTTP fixture 错误被捕获，临时目录和进程按原有 Scope/finally 清理；不写用户 Codex 配置。

验证：npm run test:codex-skills --workspace=@folio/agent（含 Agent build）通过，codex-cli 0.153.4，2 个 Turn / 4 次本地模型请求。本轮只修改探针和实施记录，没有修改生产 mapper；真实事件与现有命令映射一致。该证据仅覆盖直接前台命令，不证明原生 fileChange、取消、后台写入停止、Desktop 自动提交策略或完整 Git 同步安全；没有真实模型推理或 Lark API 请求。

## 2026-09-10 — Codex 前台取消与后台终端回收

真实原生探针增加两种执行：等待脚本实际开始写入后取消前台 Turn；让长命令通过 exec_command 的 session handle 交还控制、由模拟模型结束 Turn。前者在关闭 Session 前确认 cancelled、心跳停止和写入 PID 消失。后者证明原生 idle 可以先于命令退出，ACP 保留 in_progress 工具；仅杀死 app-server 时，写入进程仍存活。Desktop 已有的未完成工具检查会保留中断现场，但主进程退出本身不是写入停止证据。

核对 codex-cli 0.153.4 的 experimental JSON schema 和官方 app-server 文档后，初始化启用 experimentalApi；Turn runtime 关闭前调用 thread/backgroundTerminals/clean，由原生线程的终端管理器回收其独立进程组，然后关闭 app-server。探针确认这条路径实际终止原先残留的写入 PID。关闭请求并发时复用停止完成信号，后来的调用也等待清理完成，且清理本身不因调用方取消而半途退出。原生清理失败或连接已坏时仍强制关闭主进程，保留原有中断语义，不宣称后台写入安全，也不触发 Git 写入。

这只覆盖 Codex 原生管理的终端；脚本自行 daemonize、其他进程、Pi 子进程树和跨平台回收没有因此得到保证。异常退出后无法使用原生清理接口，仍需恢复阶段的独立处理。native foreground completion 与同步安全继续分离。接口为实验性，不承诺其他 Codex 版本行为。

验证：真实 Codex 探针 4 个 Turn / 7 次本地模型请求通过，包括 Session 恢复、Skill 选择、成功/失败命令、前台取消、原生后台终端清理。Agent 全量 154 项通过，随后补充延迟清理并发等待用例，Turn runtime 13 项通过；全仓 typecheck 通过。没有真实模型或 Lark API 请求。

本轮收尾：Desktop Task RPC / HarnessSessions 17 项联调通过；开发运行包重新准备通过（Node 24.15.0 / darwin-arm64），git diff --check 通过。未生成新 .app。

## 2026-09-10 — Routine 定义、触发快照与 Task 创建 RPC

新增 Vault routines / routine_triggers 表及 RoutineStore。定义保存名称、Prompt、Agent、Skill/Integration 引用、非敏感模型选择、启用状态和版本号。Pi 必须显式选模型，Codex 使用本地配置；独立 Skill 选择尚未装配，因此应用入口拒绝非空 skillIds。保存定义不调用 Integration，不要求此刻账号在线；Task 创建与 Session 装配继续使用既有的可用性/健康检查。

保存使用 expectedRevision，避免多个窗口的旧表单覆盖新配置；同一请求的精确重试返回已保存版本。接受触发时在 SQL 事务中冻结完整 RoutineRecord、分配稳定 Task ID；调用方持有 trigger UUID，响应丢失或 worktree 失败时重试不会再分配 Task。后续编辑和暂停不改写已接受的快照；暂停阻止新触发，不取消已接受的 Task。每个新触发有独立 Task，尚未实现定时任务重叠时的排队/合并策略。

routines.list / save / triggers / createTask 接入已有 Vault 应用资源与 RPC。createTask 只准备 Task/worktree，不启动 Agent、不发送 Prompt。Task detail 可读取 Routine 来源快照。触发历史包含尚未创建 Task 的记录，应用重启后可找回；这些预留 task_id 不设置 tasks 外键，因为需要先于 Task 持久化。手动创建不能占用预留身份，已持久化 Task 的普通工作区重试仍可使用原输入。

验证覆盖持久化重启、旧触发在编辑/暂停后的恢复、触发重试去重、不同触发分配独立 Task、陈旧编辑拒绝、Agent/model 约束、凭据字段拒绝和稳定错误信息。真实 Vault/Git/RPC 实验验证：阻塞 worktrees 路径后仍保留快照和 Task；移除阻塞后完成原 Task；Integration 不可用时已接受的触发可查询，修改 Routine 不会偷偷替换该快照，也不能用手动 Task 占用其 ID。测试使用不可用 Agent runtime，证明创建入口不派发执行。

本轮未实现 Routine UI、调度计划与时区/错过触发策略、自动 Session/Run 派发、自动 Task 完成或清理。资源字节仍在首次 Session 装配时固定；Routine 中保存的是能力引用和模型选择，不是凭据或安装目录副本。

最终验证：Desktop 全量 226 项中 224 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-routine-tests.json`。Desktop typecheck/build 与 git diff --check 通过。未生成新 .app。

## 2026-09-10 — Routine 管理界面与会话模型默认值

知识库概览新增 Routines 区域，复用 TaskRpcClient 和现有 Vault 应用资源。可创建/编辑名称、Prompt、Agent、Pi 模型与思考强度、Integration 引用，以及启用/暂停状态。默认 pi，需要显式选择模型；Codex 使用本地模型配置。界面明确说明当前手动创建 Task、定时执行尚未接入。

编辑器持有打开时的版本快照；后台刷新不会覆盖草稿，保存失败后保留输入及请求身份，服务端继续拒绝陈旧覆盖。当前不可用的已保存模型、已卸载的 Integration 引用在编辑器中保持可见，不因目录加载结果而静默清空。

每个 Routine 可手动创建 Task，失败重试保持原 trigger UUID 和配置版本，Routine 后续暂停也不阻止该重试。历史记录可找回应用重启前接受的触发，并准备/重试同一 Task；这些按钮均不发送 Prompt。新建任务成功后刷新下方 Task 列表。修改版本后的新一次创建有独立按钮，旧触发仍保留在历史中。

Task 会话区域显示 Routine 来源，默认采用其快照中的 Pi 模型及思考强度。用户明确选择或清空模型后，不会再被后台加载的默认值覆盖；不可用的快照模型会显示并阻止新会话打开，用户需显式选择替代模型。恢复已有 Session 仍使用原会话身份和模型。

验证：编辑器重复提交/丢失响应重试、后台版本变化不覆盖草稿、暂停后的旧触发重试、历史记录恢复、暂停不创建任务、离线引用保留、会话模型快照及不可用模型处理均有组件交互测试。Desktop 全量 232 项中 230 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-routine-ui-tests.json`。随后补充两个交互用例并简化重试状态，Routine/TaskSessions 10 项通过。未执行人工 Electron 界面验收或真实模型调用。

本轮最终 Desktop typecheck/build 和 git diff --check 通过，未生成新 .app。

## 2026-09-10 — Routine 跨 Task 执行互斥

Run 预留事务从不可变的 routine_triggers 关系解析所属 Routine。同 Routine 其他 Task 仍在 preparing/running、成功但尚未完成同步，或已有 sync_state=conflict 时，拒绝新 Run；普通失败/中断/取消的未同步现场不占用后续执行名额。原 Task 可继续对话或处理自己的冲突，其他 Routine 和手动 Task 不受影响。该规则同样覆盖对旧失败 Task 的恢复。

新增数据库 admission triggers，原子保护 Run INSERT 和从非活跃状态重新进入活跃状态的 UPDATE；已预留的 Run 从 preparing 变成 running 不重新竞争名额。Routine 来源不能换绑到另一个 Task/Routine；Task 仍存在时不能删除其来源记录，已存在 Task 也不能被事后附加为一次新触发。这些约束避免不同调用路径省略 Routine ID 绕过互斥。

应用返回 routine-busy 错误，会话界面说明另一个 Task 正在执行或等待同步，并保留 Prompt/请求 ID供用户明确重试。不会自动重试或切换 Agent。RPC 实验使用两个独立 Codex fixture Session，验证被拒绝的 Task 没有新增 Run，也没有收到原生 turn/start；取消占用者后可提交原请求。

验证包含两个独立 Node 进程竞争同一 SQLite 数据库，只能有一个预留成功；SQL 直接插入、重新激活旧 Run、删除/修改来源不能绕过约束。另覆盖 preparing/running、普通失败后放行、旧 Task 恢复、独立 Routine/手动 Task 并行、成功待同步时阻挡及同步回执后放行。同步状态测试是数据库 fixture，不证明真实 Git 同步已实现。

当前约束保护的是已登记的执行/同步状态。它不证明任意后台进程已停止，不自动修复旧数据中的重叠执行；Routine enabled 状态的冲突联动、定时触发合并、自动 Task 完成/清理仍待实现。创建 Task/worktree 本身仍不发送 Prompt。

最终验证：Desktop 全量 240 项中 238 项通过，失败仍为两项既有 GeneralSettings status 断言；报告 `/tmp/folio-desktop-routine-gate-tests.json`。随后将 RPC 用例收紧为取消占用者后直接重试原请求，不先手动重开 Session，该用例通过。Desktop typecheck/build、git diff --check 通过，未生成新 .app。

## 2026-09-10 — Routine 首轮派发与重试身份

新增 routine_executions 表，在原生启动前为一个已接受的触发固定 Folio Session ID 和首轮 Run ID。routines.startTask 将既有 Task/worktree 准备、模型快照、应用级 HarnessRuns 连起来，使用触发快照中的 Agent、模型和 Prompt；能力挂载仍由原有 Session 装配处理，不直接调用 Integration。

同一触发的并发请求共享这些身份和 Run 生命周期。只要首轮 Run 已登记，后续请求就返回已有记录并核对其 Session、Prompt 和用途，不重新打开 Agent 或发送 Prompt；这也适用于应用重启后仍为 preparing 的不确定执行，以及 interrupted/失败/结束记录。用户应在 Task 中检查现场，再发起显式恢复 Run。没有首轮记录时，准备阶段重试复用已保存的模型/Session 身份；若该 Task 已有其他手动 Session 或执行，不自动切换回 Routine Agent，也不重复原任务目标。

Routine 界面新增“运行一次”和历史“运行此任务”。“创建任务”仍只准备工作区。失败重试同时保留触发身份和操作意图，不会把准备任务升级成执行，也不会把执行重试变成仅创建任务。已有终态 Run 返回时明确说明未再次发送指令。

RPC/进程验证：并发调用后等待实际原生 acknowledgement，再修改/暂停 Routine、关闭应用并重建服务；派发日志始终只有一条原 Prompt，Session 和 Run 也各只有一个。另模拟原生已接收 Prompt 但数据库 acknowledgement/退出回执缺失的 preparing 记录，重试使用不可用 Agent runtime 仍只返回记录、不发送 Prompt。Pi 用例在缺失 Node 可执行文件的确定启动失败前保存模型快照，重试不分配新 Session；用户新增其他 Agent Session 后拒绝 Routine 自动首轮派发。没有真实模型推理或 Lark API 调用。

定时计划、运行期间触发合并、错过触发策略、Git 自动同步和 Routine Task 完成清理仍未实现。本轮提供的是可供调度器复用的派发入口；手动创建/启动被同 Routine 占用阻挡时仍需明确重试，没有后台排队或合并行为。

最终验证：Desktop 全量 245 项中 243 项通过，失败仍为两项既有 GeneralSettings status 断言；报告 `/tmp/folio-desktop-routine-dispatch-tests.json`。补充入口的能力引用/派发记录一致性检查后，4 项相关 RPC 用例复验通过。最终 Desktop typecheck/build 和 git diff --check 通过，未生成新 .app，未做人工 Electron 或真实模型验收。

## 2026-09-10 — ACP 双向协议帧审计

新增 acp_protocol_frames 表，与已有 acp_events 更新回执及消息投影分开。SDK 解码后的入站/出站 JSON-RPC 帧先持久化再转发，包括初始化、会话创建/恢复、Prompt 请求与响应、通知及关闭。批量帧作为一条记录原子保存，每个成员单独记录方法、请求 ID 和可确定的 Run 关联。响应使用同一连接中原请求的关联，区分方向及数字/字符串 ID；重复未完成 ID 的响应不猜测所属 Run。

审计副本递归遮蔽明确的凭据字段和 headers/env 容器，发送给 Agent 的原始帧不变。自由文本 Prompt 和工具输出仍保留，因此此机制不保证记录不含秘密。写入失败会中止连接并阻止该帧转发；取消期间尚在持久化的帧也不会在完成后继续转发。记录成功仅代表观察到了帧，不证明远端已接收或操作成功，不能作为重发 Prompt 的依据。

数据库允许 Folio Session 尚未绑定 ACP/native ID 时记录初始化帧，拒绝整帧中的跨 Session Run 关联，重启读取不生成额外消息投影。真实生产 CLI/stdio fixture 验证 initialize、session/new、session/resume、session/prompt、session/cancel、session/close 的记录和 Prompt 响应 Run 归属。

限制：尚未捕获 NDJSON 解码前被拒绝的损坏字节；关闭连接时没有独立的审计写入排空接口；遇到非预期授权请求会先关闭连接，不承诺发送出错误响应。协议观察序号与可重放的 Agent 更新序号独立，不用于推断 Task 完成、后台进程退出或 Git 同步安全。

验证：Desktop typecheck/build 通过；全量 253 项首次运行有 250 项通过，另有一个新增测试初始化时违反活跃 Run 约束，修正后相关三文件 18 项全部通过，其余两项仍为既有 GeneralSettings status 断言失败。全量报告 `/tmp/folio-desktop-acp-audit-tests.json` 保留首次结果。未生成新 .app，未调用真实模型或 Lark。

## 2026-09-10 — ACP 审计关闭与写入资源生命周期

会话关闭不再把 SDK connection.closed 当作持久化完成。客户端关闭协议连接后，封闭新的审计写入并等待所有已接纳的双向写入结束，随后才允许外层 Session/process/database scope 继续清理。正常关闭期间成功完成的写入不会误报 storage failure，也不会继续转发帧。

appendProtocol 使用 Effect.timeout，沿用协议请求超时时间（默认 10 秒），超时会中断执行并等待事务/资源 finalizer；没有通过 Promise.race 丢下仍在运行的数据库写入。超时不是对阻塞事件循环或无限不可中断 finalizer 的硬时限，不能据此承诺任意故障下的绝对关闭时间。

重复未完成的 JSON-RPC 请求 ID 会在本次连接内持续标记为歧义；收到一条响应后不清除该标记，避免后续 ID 重用时把迟到响应误关联到新 Run。

验证：WebStreams 测试覆盖双向写入同时进行时的关闭等待、重复关闭、禁止新写入以及正常关闭不误报失败。生产 stdio fixture 注入停滞的审计 Effect，验证超时执行其延迟 finalizer，Session 关闭返回前完成清理，未转发 Prompt，Agent 进程已退出。Desktop 全量 255 项中 253 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-acp-drain-tests.json`。Desktop typecheck/build、git diff --check 通过。未生成新 .app，未调用真实模型或 Lark。

仍未完成原始损坏字节审计、Routine 定时计划和触发合并、Git 自动同步与 Task/worktree 完成回收；canonical Git 候选算法及应用离线错过触发策略仍等待用户决定。

## 2026-09-10 — Routine 待触发记录与批次派发

新增 routine_wakeups：每次触发记录稳定 UUID、Routine ID、触发时间与接收时间。重复接收同一输入不产生第二条记录，复用 UUID 修改时间或 Routine 会拒绝。待派发记录不提前创建 Task，也不提前固定 Prompt；claimPending 在 Routine 可派发时将当前全部待触发记录原子绑定到一个 routine_trigger，并采用该时刻的配置版本。批次接受之后新来的触发属于下一批，原批次配置不再改变。

正在 preparing/running、有同步冲突或成功待同步的同 Routine Task 会阻止批次接受；成功且同步完成仍等待 Task 完成登记。普通失败/中断/取消的首轮可以让下一批继续。不同 Routine 独立。暂停期间保留已接收记录、拒绝新触发、停止自动批次接受；重新启用后仍可处理保留记录。现有手动 createTask/startTask 的明确重试行为保持不变。

接受批次后尚未登记首轮 Run 的重试，会找回原 trigger/Task 身份，继续复用既有 Session/Run 派发意图；不会重新选择更新后的配置。已登记 preparing Run 的不确定派发依然需要显式检查，不自动重放。Run 预留仍由数据库互斥门禁重新检查，避免批次接受后与手动执行发生竞争。

TaskService 新增 enqueueRoutine、routineWakeups、dispatchPendingRoutine 后端入口，复用已有 Vault 资源和 HarnessRuns。当前没有定时器或后台自动 drain，也未增加队列 RPC/界面；调用这些入口的调度管理仍待接入。启动前失败的已接受批次保留原身份等待重试，没有引入无限自动重试。发生冲突时 enabled=false 的状态联动仍待实现，当前通过执行状态阻止派发。

验证：SQLite 测试覆盖忙时合并、派发时读取新配置、批次接受后的晚到触发、丢失响应、重启、暂停/重新启用、失败放行、成功等待完成、冲突保留、独立 Routine、两个独立数据库连接争抢同一批次，以及禁止修改历史时间/重新绑定批次/跨 Routine 绑定。生产 CLI/stdio fixture 验证前一轮运行时三次触发不新增 Task，取消前一轮后并发派发只创建一个新 Task，发送一次更新后的 Prompt，三个原始触发时间均保留。

最终验证：Desktop 全量 261 项中 259 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-routine-queue-tests.json`。Desktop typecheck/build、git diff --check 通过。未生成新 .app，未调用真实模型或 Lark。定时计划、离线错过触发策略、Git 同步算法确认与生产实现、Task 完成及 worktree 回收仍未完成。

## 2026-09-10 — 同步冲突自动暂停 Routine

数据库在 Run 插入或更新为 sync_state=conflict 的同一事务中，将所属 Routine 的 enabled 改为 false，并增加 revision。已暂停时重复登记冲突不会增加版本。原 trigger 配置快照、Task、Session/Run 身份和 routine_wakeups 均保持不变。事务回滚同时回滚暂停，避免只发布其中一半状态。

未解决冲突存在时，RoutineStore.save 返回明确的 routine-conflict 错误，数据库约束也阻止直接写回 enabled=true。旧编辑器不能覆盖暂停状态；已暂停的配置仍可编辑。原 Task 的 conflict-resolution Run 不受 Routine 启用状态阻挡，其他 Routine 独立。将冲突标记为已解决后保持暂停，用户明确重新启用后才可派发待触发批次。新触发被暂停状态拒绝，已接受的触发及其重试保留。

启用按钮和编辑器提供中英文冲突提示；编辑器保留草稿，支持保持暂停状态保存。迁移对已有账本中的未解决冲突补齐同样的暂停，一次增加版本，不移动文件或重写已接受快照。

验证覆盖 INSERT/UPDATE、事务回滚、重复登记、陈旧编辑、直接 SQL 绕过拒绝、暂停期间编辑、原 Task 冲突解决 Run、跨重启、显式重新启用及旧账本迁移的幂等性；组件测试验证启用失败提示和草稿保留。Desktop 全量 266 项中 264 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-routine-conflict-tests.json`。Desktop typecheck/build 与 git diff --check 通过。未生成新 .app，未调用真实模型或 Lark。

这里验证的是已登记 conflict 状态与 Routine 的联动；Git 检测、AI 冲突解决、提交验证及同步协调仍未接入生产，不能据此认为真实 Git 冲突链路已完成。定时器、队列界面和 Task/worktree 完成回收也仍待实现。

## 2026-09-10 — Routine 待触发记录 RPC 与界面

新增只读 routines.wakeups RPC，复用已有 Vault ID 校验及 RoutineStore 查询。触发历史显示待派发次数、每次原始触发时间，以及暂停时记录保留的说明；已接受批次可展开查看其合并的原始时间。查询失败与空队列分别展示，刷新只读取状态。批次仍通过已有历史操作准备或运行原任务；没有将查询、展开或刷新变成派发动作。

触发时间 Schema 限制为可由 Date 表示的非负毫秒值，防止无效日期进入时间展示。显示采用当前本地时间；这不决定尚待确认的调度时区或离线补跑规则。

验证：组件交互覆盖待触发与已合并时间归属、暂停说明、查询失败/空队列区分，以及展开/刷新不调用创建或执行接口。真实 Vault/RPC 测试覆盖重启读取、同一 Routine ID 在不同 Vault 下隔离、未知 Vault 拒绝、查询不分配 Task/trigger，以及 Agent runtime 不可用时查询仍工作且不调用启动探测。Desktop 全量 269 项中 267 项通过，仅两项既有 GeneralSettings status 断言失败；报告 `/tmp/folio-desktop-routine-history-tests.json`。Desktop typecheck/build、git diff --check 通过。

定时器和后台派发仍未接入，界面继续明确说明尚不支持定时执行。没有新增产生触发的 renderer API，也没有生成新 .app 或进行人工 Electron 界面验收。Git 自动同步、Task 完成与 worktree 回收仍未完成。

## 2026-09-10 — 调度/Git 决策确认与 worktree 重建实验

用户明确确认：首版 Routine 每天指定时间，使用 Vault 保存的时区；应用关闭或休眠期间错过的触发恢复后合并补跑一次。Git 采用隔离协调 worktree 中统一解冲突、发布 main 后以普通子提交对齐 Task 的 canonical 方案。RFC §9.2、§10.1 和 canonical 方案状态已更新；此前“等待确认”的记录由本节取代。实现目标仍包括定时器、提交账本、同步恢复及 Task/worktree 完成回收。

新增 worktree-session-resume.test.ts：真实 Git 创建/干净删除/在原路径从新 main 重建 worktree，使用生产 ACP CLI 验证 Pi 的已安装 SDK 与 Codex 协议夹具均恢复相同 ACP/native 身份和重放内容，Pi 思考配置也保留。Codex 夹具的 native Session 存储明确放在可删除 checkout 外；夹具诊断文件先提交，Git remove 不使用 force。无真实模型请求。

实验还证明 Pi 原生恢复在 cwd 不存在时仍返回成功：恢复成功不能证明 checkout 有效，Folio 必须先校验工作区。该测试只证明恢复协议兼容性，不实现 Task 完成重开、基线变化通知或生产清理策略，也不等于实际 Codex CLI 的 worktree 重建验收。

验证：新增 2 项测试通过，Agent typecheck 通过，git diff --check 通过。本轮没有修改生产 Agent 代码，没有重跑不受影响的全量 Desktop 套件或生成 .app。

## 2026-09-10 — 每日计划持久化与到期收集

新增 Vault 级命名时区和 Routine 每日 HH:mm 计划、版本、next_at 游标；RoutineScheduleStore 提供设置、CAS 保存/删除及 collectDue。创建或修改时间、时区后从下一个未来时间开始，不生成配置前的历史。已接受 wakeups 不随删除计划或时区修改删除。

nextDailyOccurrence 使用 Effect DateTime 的 civil time 与 compatible 消歧：春季不存在的时间向后顺延，秋季重复时间选择第一次；一天只触发一次，严格大于已记录游标。时区必须有效并明确保存，不隐式跟随系统时区。

collectDue 在同一 SQLite 事务中写入每个错过日期的 wakeup 并推进游标，支持重启去重；每个计划每次最多收集 366 个日期。后续调度器须先收集完所有到期页，再调用既有批次合并派发，避免长时间离线拆成多次补跑。收集时暂停的 Routine 跳过过去日期并保留原 wakeups。

此模块尚未接入 TaskService、RPC、界面或应用定时循环。暂停后离线再重新启用时的游标衔接、长期关闭的分批收集调度、并发改计划及进程退出仍需在接入时完整验证，不能宣称已支持自动每日执行。

验证：上海/UTC、午夜、闰日、夏令时 gap/fold、重复调用、跨重启、时区修改版本、旧编辑拒绝、删除保留记录、401 个离线日期的分批合并、暂停跳过日期有测试。Desktop build/typecheck 通过；全量首次 272 项中 269 项通过，除两项既有 GeneralSettings 失败外，旧迁移 fixture 未回退新表，已修复后相关两文件 11 项通过。首次报告 `/tmp/folio-desktop-daily-store-tests.json`。git diff --check 通过；未生成 .app 或调用模型。

## 2026-09-10 — 暂停后离线再启用的游标边界

RoutineStore.save 在已暂停 Routine 重新启用时，同事务将每日计划 next_at 重算为当前 Vault 时区下的下一次未来时间，避免用户在重启后第一次 collectDue 之前启用，导致暂停期间的日期被当作离线漏跑收集。原 wakeups 保留并可继续合并派发，计划版本不因启用操作改变。陈旧编辑拒绝和确切丢失响应重试发生在游标更新之前，不会重复移动已恢复的游标。

验证覆盖暂停后关闭/重开数据库、启用前的陈旧版本、原触发保留、重复启用请求不移动游标，以及强制游标写入失败时定义 enabled/revision 与游标一起回滚。相关三文件 15 项通过；补充回滚断言后每日计划文件 4 项复验通过。Desktop typecheck、git diff --check 通过。未重跑全量套件或生成 .app。

调度模块仍待 TaskService/RPC/UI 与应用定时循环接入，自动每日执行尚未可用。用户已确认的 canonical Git 同步、任务完成与 worktree 回收仍在完整目标内。

## 2026-09-10 — 每日计划服务与 RPC 接入

RoutineScheduleStore 已接入应用级 Vault 资源，新增 routines.scheduleSettings / saveSchedule / removeSchedule / setTimeZone RPC。请求只携带注册 Vault 身份、命名时区、HH:mm 与预期版本，不接受数据库路径。所有计划配置操作继续复用 Vault 持久化服务；保存或查询不触发 Agent，也不创建 Task。

真实 Vault/RPC 验证 Agent runtime 不可用时设置时区和每日时间，重复保存复用原游标，重启读取保持一致，旧时区编辑和错误版本删除被拒绝，删除后时区保留，未知 Vault 查询拒绝。整个 Task RPC 文件 22 项通过，Desktop typecheck/build 和 git diff --check 通过。未运行完整 Desktop 套件，未生成 .app。

自动循环、计划配置界面和到期自动派发尚未接入。此前明确的定时器、canonical Git 同步与任务完成/worktree 回收继续属于未完成目标。

## 2026-09-10 — 每日计划配置界面

Routine 列表新增可展开的每日计划设置。可显式保存 Vault 命名时区、为每个已保存 Routine 配置 HH:mm、查看按 Vault 时区格式化的下一次计划时间，以及移除每日计划。未设置 Vault 时区时禁用每日时间编辑。修改时区前说明其会重新计算全部计划，暂停的 Routine 单独标示。

编辑器固定打开时的时区预期值或计划版本；后台刷新保留草稿和原版本。保存失败保留输入用于明确重试，方法内互斥避免重复提交/删除。没有在展示或保存时派发 Prompt，界面明确提示自动派发尚未接入。

验证：新增交互测试覆盖命名时区校验、无时区前置约束、刷新/失败保留原草稿与版本、确切请求重试、并发删除拦截。RoutineSchedules 与 RoutinePanel 两文件 15 项通过，Desktop typecheck/build 和 git diff --check 通过。未做人工 Electron 验收或生成 .app。

自动调度循环和到期批次派发仍待完成，canonical Git 同步、Task 完成与 worktree 回收仍属未完成目标。

## 2026-09-10 — 应用级每日检查与合并派发

RoutineSchedulerLive 接入 MainLive，依赖应用拥有的 ConfigService/TaskService，启动立即检查，完成一轮后每 15 秒再次检查。每轮重读注册 Vault 列表，包含尚未打开窗口及新增的 Vault；Vault 检查最多并发 4 个，单 Vault 失败不阻止其他 Vault。应用 Scope 关闭中断循环并等待其清理，随后释放任务执行服务；窗口关闭不会停止循环。

TaskService.tickSchedules 先收集一个有界到期页，再读取游标；某 Routine 仍有未收集日期时不派发它，后续检查继续收集，因此长期离线不会因分页产生多个补跑任务。收集完成后复用已有 claimPending/startRoutineTask，实现当前配置快照、原身份重试及 Run 去重。已接受但启动失败的批次在后续检查重试；已登记 Run 不自动重放。冲突或暂停的 Routine 不派发，其他 Routine 可继续。

界面说明已更新为每日执行和关闭/休眠后合并补跑。定时器以恢复后的墙钟与持久化游标判断到期，没有依赖计时器回调次数；检查间隔意味着普通触发可能晚于计划时间约一个检查周期，长扫描或 Agent 启动会额外延迟。

验证：循环测试覆盖立即检查、失败后继续、不重叠及退出等待 finalizer；真实 TaskService/生产 CLI/stdio fixture 覆盖忙时收集多天漏跑记录、前任务取消后单批派发、重复 sweep 不重发 Prompt。Desktop 全量 279 项中 277 项通过，仅两项既有 GeneralSettings status 断言失败，报告 `/tmp/folio-desktop-scheduler-tests.json`。Desktop typecheck/build 和 git diff --check 通过。未进行人工 Electron 休眠/唤醒或真实模型验收，未生成新 .app。

已成功执行但尚未同步/完成的 Routine Task 继续占用名额，因为生产 Git 自动同步与 Task 完成回收仍未实现；不能把目前的每日触发能力当作完整 Routine 生命周期交付。canonical Git 提交、同步恢复、后台写进程安全及 worktree 完成回收仍待推进。

## 2026-09-10 — 选定文件的 Git 树快照

新增 snapshotGitChange：核对 checkout 根目录与冻结 parent，使用独立临时索引从 parent 构造仅含所选文件修改的 Git tree。支持删除及字面文件名，拒绝目录、路径穿越、符号链接及重定向祖先；生成后核对实际变化路径和 HEAD。临时索引随 Scope 清理，真实索引、工作文件和分支引用保持不变。Git runner 只允许显式绝对路径的临时索引覆盖已清理的 Git 环境。

真实 Git 验证 4 项通过：未选中的暂存草稿保留、快照不随后续编辑变化、删除与非法路径、陈旧 parent、linked Task worktree 两侧索引不变、二进制 blob、含换行/冒号的字面路径、重复选择，以及 missing/ignored 文件导致 staging 失败后的现场保留。现有 Task worktree/Vault 测试 21 项通过，Desktop typecheck 通过。

这是保存链路的底层准备，尚未接入用户保存操作，也没有创建 commit、提交日志、保护引用或自动同步。Git clean filters/attributes 仍按 git add 语义生效；快照不证明无并发写入，孤立 tree 也不具备长期保留保证。后续协调器必须接入写入互斥、持久 journal、对象保留和恢复核验，不能直接把返回 tree 当作已持久提交。完整 RFC 目标仍未完成。

## 2026-09-10 — 提交准备日志与对象保留

新增 GitChangeJournal 和迁移 0013_git_change_preparations。先持久化稳定 Change ID、Task/Run 来源、文件范围、parent/tree、生成时间、完整 commit 字节与预期 SHA，再写 Git commit 对象及 refs/folio/changes/{id} 保留引用，最后标记 prepared。prepared 只表示提交对象已保留，不表示已应用到分支、登记为可执行基线或完成同步。用户来源不关联 Run；Agent raws/wiki 来源须对应同一 Task 的成功 Run，且分别限制文件范围。后续多 Run 保存阶段已把单值来源替换为不可修改的关联表，见文末最新检查点。

重复请求复用已记录时间和 SHA，文件集合顺序及重复项不改变意图；同 ID 的不同 tree/文件范围被拒绝。pending 查询可在重启后发现没有收到回复的准备操作。recover 只核验原始 tree 与 commit，不重新读取当前工作文件；允许 source HEAD 后来前进，因为恢复对象保留不应用分支。现有引用不匹配时不强制替换；Git runner 禁用 replacement objects，保留引用写入使用 no-deref，避免跟随符号引用改动其他分支。

真实 Git/SQLite 的 8 项日志测试覆盖保留与重启、未选暂存内容和真实索引不变、Git 成功/数据库收据丢失、意图写入失败、引用写入失败后重建相同 commit、缺失原始 tree 时停止、独立数据库连接的并发重试、来源/文件范围校验及不可修改/删除的意图。快照、日志、Task worktree、Vault、Routine 迁移回归共 41 项通过。Desktop 全量 291 项中 289 项通过，仅两项既有 GeneralSettings status 断言失败，报告 `/tmp/folio-desktop-git-journal-tests.json`；Desktop typecheck/build 通过。

该服务尚未接入应用保存按钮或 Run 结束边界。下一步需接入保存协调器：互斥捕获与应用、核对已登记来源基线、分支/真实索引写入日志及收据恢复。之后仍需 canonical main 发布、Task 对齐、真实冲突 Run、后台写进程核验和 Task 完成/worktree 回收。准备前或保留引用前丢失 Git 对象目前保留日志并报错，不承诺恢复缺失字节；没有测试断电持久性、生成 .app 或调用真实模型。

## 2026-09-10 — 源分支保存、索引恢复与基线登记

新增 GitChangeApplications、私有索引准备和迁移 0014_git_change_applications。应用前持久化旧/新索引字节与 Change 身份；新索引只更新所选路径，保留其他暂存内容。以 CAS 将源分支从冻结 parent 推进至已保留 commit，然后原子发布索引并登记 applied 收据；整个过程不写工作文件。raws/wiki/user 均沿用原始准备记录，源分支保存收据与后续跨分支同步收据分开。

待发布索引在 Git 目录内以独立文件保留，通过 hard link 原子取得 index.lock。恢复时核对 inode 和内容证明锁属于该操作，不删除其他进程的锁。分支、索引和日志必须匹配已记录检查点；Git 成功但收据丢失时不重复提交，HEAD 前进或暂存内容另有变化时保留现场。若只是 Git 刷新索引缓存/统计信息而暂存树不变，则保留较新的索引字节并补记收据。

VaultGitWriteLock 使用独立 git-write-lock.db 的 SQLite 进程锁，busy timeout 为 0，竞争者立即返回忙状态。与 data.db 分开，避免 Git 等待阻塞 ACP 事件持久化；没有按锁龄抢占。Task worktree 创建也已使用同一锁。pending 保存与 Run 准入由 data.db 触发器互斥；HarnessStore 提供明确的 task-busy 诊断。该锁只协调采用它的 Folio Git 写入，不能证明 native Agent 或任意外部后台写入已停止。

已完成的源分支收据接入 TaskWorktrees / HarnessRuns 的基线校验：新 Task 可以从用户保存后的已登记 main 创建，Task 后续执行可使用其已登记保存提交。未完成保存及仅准备好的对象不构成已登记基线，未登记的外部提交继续被拒绝。

验证：新增 14 项真实 Git/SQLite 测试覆盖选择保存与删除、未选暂存草稿和后续编辑、继承保存后的 main、ref/index/数据库收据三个失败边界、未知锁保留、较新索引保护与缓存刷新、跨连接竞争、Task Run 准入、外部父提交拒绝、字面二进制路径和目录替换冲突。独立 Node 进程持锁时保存被拒绝，SIGKILL 后验证 OS 释放锁且保存成功。Desktop build/typecheck 通过；全量以 --maxWorkers=4 运行，305 项中 303 项通过，仅两项既有 GeneralSettings status 断言失败，报告 `/tmp/folio-desktop-git-application-tests.json`。默认全并发曾出现 ACP 启动测试失败，该文件单独 6 项和随后限并发全量均通过；未修改 ACP 协议代码或其测试超时。新增的两次保存/worktree 集成测试单独设为 15 秒，避免全量进程启动负载超过默认 5 秒。

保存后端尚未接入 RPC、保存按钮或 Run 结束边界；捕获/准备/应用需由应用拥有的协调器串联，不能对已持有写锁的调用重复加锁。保存中途发现外部变化后的取消/重新规划界面尚未实现。canonical 同步、冲突 Run、native 写进程边界和 Task 完成/worktree 回收仍未完成。没有进行人工 Electron 验收、真实模型调用、断电测试或新 .app 打包。

## 2026-09-10 — 单次保存协调与主工作区 RPC

GitChangeApplications.save 在同一个 Vault 写锁中完成身份/基线校验、选定文件捕获、提交准备与应用；复用内部已持锁方法，避免嵌套获取独立 SQLite 锁。SaveGitFiles 只接收操作 ID、Task 身份、观察到的 parent 和非空文件范围，不接受调用者指定的根目录、tree、commit 或来源种类。已接受记录必须与原 Task、parent、文件集合及 user 来源相同，确切重试复用原始 tree/SHA；不同意图不能复用同一个 ID。

准备日志落盘是内容被接受的边界。之后即使应用意图或收据写入失败，重试也不重新捕获已变化的工作文件；准备日志之前失败则尚无已接受快照。expectedParent 核对 Git 基线，不宣称能锁住外部编辑器或提供跨文件的文件系统事务。

新增 workspace.saveFiles RPC，沿用 TaskService 的注册 Vault 校验与应用级资源，公开输入固定保存 main 工作区，不包含 Task 选择参数。内部 Task 保存仍需调用方建立 native 执行安全边界，尚未开放为用户 RPC。Agent runtime 不可用时主工作区保存仍能完成，不探测/启动 Agent，也不创建 Task。保存按钮、变更列表及未完成保存的发现/处理界面尚未接入。

验证：保存服务 18 项、Task RPC 23 项均通过；新增覆盖单锁完整保存、集合规范化重试、身份变更拒绝、应用意图/收据失败后重开复用原始快照、陈旧 parent 和非法路径，以及真实 Vault/RPC 的保存、保留未选暂存内容、重启后保留较新编辑、未知 Vault 和 Task 参数拒绝、Agent 零启动。Desktop --maxWorkers=4 全量 310 项中 308 项通过，仅两项既有 GeneralSettings status 断言失败，报告 `/tmp/folio-desktop-save-entry-tests.json`。Desktop typecheck/build、git diff --check 通过；没有人工 Electron 验收或新 .app 打包。

完整目标继续包括保存交互、Run 结束提交、canonical 自动同步及冲突恢复、native 写进程边界和 Task 完成/worktree 回收。

## 2026-09-10 — 主工作区保存界面与差异预览

新增 WorkspaceChanges 服务、workspace.changes / workspace.diff RPC 和 Vault 内的文件变更面板。默认不选中文件；用户选择磁盘文件后显式保存为 commit。选择保留原 HEAD，刷新不会悄悄更新保存基线；失败后保留请求身份与范围，方法内互斥阻止重复提交。成功后可查看该次保存的原始快照。

变更查询同时读取准备日志与应用收据，因此重启后也能发现已经接受、但尚未写入应用意图的保存。界面展示未完成保存、原始文件范围和确切重试入口；查询本身不恢复或应用保存。已接受操作的预览固定读取原 tree，不随当前文件或 HEAD 前进而变化。尚未提供陈旧已接受操作的放弃/重新规划流程。

实时预览通过私有索引生成单文件快照，可能写入未引用的 Git 对象，但不修改真实索引、分支、工作文件或保存日志。禁用 external diff/textconv，按字面路径处理文件名并拒绝符号链接；新旧 blob 任一超过 128 KiB 时返回大文件提示，二进制单独提示。文件列表尚无分页；外部索引中的删除随后在磁盘恢复等组合可能显示无内容差异的候选文件，不承诺列表覆盖所有外部 Git 操作组合。

新增服务 3 项、界面 6 项测试通过，覆盖原快照重试、未完成保存发现、明确选择、陈旧基线、重复提交、错误与空列表区分，以及二进制/大文件预览；RPC 测试补充真实 Vault 的查询、保存后重启预览和未知 Vault 拒绝。Desktop typecheck/build 和 git diff --check 通过。没有进行实际 Electron 视觉验收、真实模型调用或生成新 .app。

本轮 Desktop 全量以 --maxWorkers=4 运行：319 项中 316 项通过，两项既有 GeneralSettings status 断言失败，另有 sibling Routine Prompt RPC 用例在约 5015 ms 失败（默认 5 秒边界，报告仅给出 STACK_TRACE_ERROR）。随后该 RPC 文件单独复验 23 项全部通过；未修改超时或断言，全量结果不能记为全绿。报告 `/tmp/folio-desktop-workspace-ui-tests.json`。

完整 RFC 仍未完成：Run 结束提交、canonical 发布与 Task 对齐/恢复、实际冲突 Run、native 后台写入安全和 Task 完成/worktree 回收仍待接入。

## 2026-09-10 — 移除独立 Agent 运行包准备

按用户要求删除 prepare-agent-runtime.mjs、before-pack.mjs、prepare:agent 命令及对应 extraResources。开发启动不再重新安装 Agent 依赖，打包不再创建临时 workspace 或复制 standalone Node。历史章节中的独立运行包方案已被本节取代。

Electron Vite 直接编译 Agent CLI 为 out/main/agent.js；SDK 由 App 正常依赖打包。AgentRuntime 使用 App 可执行文件和固定构建入口，AgentProcess 以 ELECTRON_RUN_AS_NODE=1 启动独立 ACP 进程，保留实际 Node/SQLite 探测。Integration 脚本的 node 命令依赖用户 PATH；不再承诺随包提供单独 node 命令。

构建与类型检查通过，运行路径、进程退出和应用生命周期相关 12 项测试通过。使用实际 Electron 执行开发构建，Node 24.18.1 / SQLite 与 Pi、Codex ACP 握手通过；没有调用模型。

本轮 macOS arm64 App 目录打包通过；从临时工作目录用实际 Folio.app 可执行文件启动包内 app.asar/out/main/agent.js，Pi/Codex ACP 初始化均通过，未依赖旧 .agent-runtime 目录或仓库 NODE_PATH。未进行签名或真实模型验证。

Task RPC 全文件复验 23 项通过；连同运行路径/进程/生命周期共 35 项相关测试通过。版本直接取 Agent package.json，避免独立 manifest 或硬编码版本漂移。

## 2026-09-10 — 手动 wiki 修改的外围边界探针

按当前优先级暂不处理 Agent 切换、独立 Skill 和 raws。新增临时交互探针 `prototype:wiki-boundary`，在系统临时目录创建真实 main、Task 和隔离 coordinator worktree，以手动磁盘写入代替 Agent，逐步展示 Run terminal、writer stopped、源冻结、canonical 准备、发布和对齐门禁；退出时删除临时仓库。

实际驱动验证了三组路径：干净 wiki 修改完成提交/发布/对齐；main 与 Task 同文件修改只在 coordinator 冲突，解决一次后两边提交树收敛且 Task 原提交仍可达；main 未提交内容、准备后 main 前进以及发布后 Task 新草稿均被门禁拒绝，工作文件未被覆盖。

结论是 Git 可以核对冻结 HEAD、干净工作区和结果 tree，但不能证明外部写入者之后不会继续写。Run terminal 或 ACP idle 不能产生这个事实。生产接线前仍需定义 writer ownership/quiescence；本探针中的手动 writer-stopped 开关只是实验前置条件。该探针不使用数据库，未验证 durable operation journal、崩溃恢复或幂等收据，不能当作 V3 已完成。

## 2026-09-11 — 手动 wiki canonical 同步的生产后端切片

按当前优先级继续排除 Agent 切换、Skill 和 raws。新增 `TaskGitSynchronization`、确定性 Git commit object 工具和 migration `0015_git_sync_operations`。操作记录冻结 Task 已登记 frontier/HEAD、完整 source change/commit 区间、main base、canonical commit 字节、prepare/publish/align 检查点和 alignment commit 字节；状态只允许 `preparing → conflict|prepared → published → aligning → aligned` 向前移动，身份与已写检查点不可改写或删除。

prepare 在隔离 coordinator worktree 顺序应用完整源区间，同文件冲突只留下该 coordinator，main/Task 均不进入冲突状态。成功结果使用确定性 commit 字节和 `refs/folio/sync/{id}/canonical` 保留；publish 只接受冻结且干净的 main，以 fast-forward 发布；align 只接受冻结且干净的 Task，用 parent=source HEAD、tree=canonical tree 的普通子提交对齐并保留源历史。树已经一致时无需额外提交。对齐提交和 canonical main 提交都成为已登记基线，但 alignment commit 不再反向导出。

Git/SQLite 收据分离处理：prepare、publish 或 alignment 的 Git 写入已经成功但数据库更新失败时，重试核对完整 commit bytes、protected ref、HEAD 和 tree 后补收据。prepare 收据恢复后会清理仅属于内部 scratch 的 coordinator；`conflict` coordinator 不进入该清理分支，跨重启保持不变。未完成 sync 阻止新 Session、Run 和 worktree 执行准入；另一个 Task 推进 main 后，旧 Task 即使自身干净也不能继续执行，必须先以空 source interval 对齐到当前 main。

真实 Git/SQLite 的 19 项同步测试通过，覆盖：连续两轮保存/同步；同文件冲突隔离；dirty/stale/detached main；发布后 Task 草稿；空源 main→Task 及空 canonical checkpoint 不可改写；prepare/publish/align 丢失收据；alignment 收据恢复时 protected ref 篡改拒绝；重启 pending；canonical protected ref 篡改；未登记或非 wiki Task commit；伪造终态行；同基线多 Task 顺序发布及旧 Task 强制刷新；同一 Task 的新 prepared 操作阻止旧 publication 提前对齐并由新操作统一收敛；并发提前 prepare 的后发布者停止；Run 门禁恢复；冲突 coordinator 重启保留。手动 PTY 探针也完成磁盘写入、提交、隔离准备、发布、对齐，最终 main/Task tree 一致。相关同步/保存/worktree/store/Session/Routine/RPC 回归 109 项通过；Desktop production build 和本次文件 lint 通过。Desktop 全量 338 项中 336 项通过，仅剩两项既有 `GeneralSettings` status 断言失败。

当前限制：没有 Task 文件选择/差异 UI，也没有把成功普通 Run 自动接到保存/同步；Run terminal/ACP idle 不能证明后台写入者已停止。SQLite `BEGIN IMMEDIATE` 锁只串行 Folio Git writer，clean preflight 与 fast-forward 之间仍无法排除外部编辑器再次写入。Task 完成/worktree 回收也未接入。因此这是可恢复的手动 `wiki` 后端边界，不是完整自动同步闭环。

## 2026-09-11 — 显式 Task wiki 保存与同步 RPC

新增 `tasks.wikiChanges`、`tasks.wikiDiff`、`tasks.saveWikiFiles`、`tasks.synchronizeWiki` 和 `tasks.synchronization`。renderer 只提交 Vault/Task 身份、选定的 `wiki/**` 文件、观察到的 Task HEAD，以及保存和同步各自的稳定 ID；main process 解析 Vault 自有路径并复用现有 `WorkspaceChanges`、`GitChangeApplications` 与 `TaskGitSynchronization`。保存成功与同步成功仍是两个独立 durable receipt，响应丢失后可分别用原 ID 重试。

`WorkspaceChanges` 复用同一套字面路径、symlink 拒绝、128 KiB 预览上限和 retained snapshot 逻辑读取 main 或 Task。Task 目标会额外核对持久化 worktree 路径、分支与 shared Git directory，并通过 Git pathspec 和服务端路径校验把查询限制在 `wiki/**`；未选中的 `AGENTS.md` 草稿既不出现在 Task wiki 列表中，也不会被保存。

公开同步返回值统一剥离数据库内部 sequence 和 alignment commit 原始字节；此前查询接口已经剥离，但 prepare/publish/align/synchronize 写接口在运行时仍夹带这些额外字段，本轮在服务边界统一修正。真实 RPC 用例直接写 Task worktree 文件，完成保存、canonical 发布、Task 对齐、两种收据查询/重试并核对 main/Task tree；测试同时使用不可用 Agent runtime，确认显式文件操作不会启动 Agent。

这组 RPC 只提供显式用户操作能力，不把 Run terminal、Session idle 或 RPC 调用本身解释成后台 writer 已停止。Task RPC 全文件 24 项、与 WorkspaceChanges 联合 27 项通过；Desktop production build/typecheck/lint 通过。Desktop 全量 339 项中 337 项通过，仍只有两项既有 `GeneralSettings` status 断言失败。Task 文件选择/差异 UI、成功普通 Run 自动保存和 Task 完成清理仍待实现；冲突解决由后续独立 Run 切片补齐。

## 2026-09-11 — 过期 canonical 准备的原子替换

`GitSyncOperation` 新增 `superseded` 终态和 `supersedesId` 关系，`tasks.reprepareWiki` 接受旧 operation ID 与稳定的新 ID。只允许替换尚未发布的 `prepared` 操作，并复核 main 已从旧基线向前推进、main 是已登记且干净的 `main`、Task 仍停在冻结 source HEAD 且干净、没有活跃 Run。旧 canonical 对象及 protected ref 保留，不删除历史。

旧状态转换与替代 operation 登记位于同一 SQLite 事务。替代插入失败会使旧记录继续保持 `prepared`；成功后新记录复用相同 source frontier/head/change/commit 区间，以当前 main 为新基线继续 prepare/publish/align。重复相同请求返回同一记录。Run、Session 和 worktree 门禁忽略有合法替代记录的 `superseded` 历史，但孤立的 superseded 记录仍按未完成同步处理。

真实双 Task 测试先让两个 operation 基于同一 main 准备，再由第一个推进 main；第二个旧 publication 被拒绝。故障触发器证明 replacement 插入失败会完整回滚；重试后旧记录为 `superseded`、新记录为 `aligned`，旧 protected ref 仍指向原 canonical commit，main 与第二个 Task tree 收敛且同时包含双方文件。

## 2026-09-11 — Run terminal 前回收 Folio-owned Agent 进程

`HarnessRuns` 的所有 terminal 路径现在先关闭 ACP Session，并等待其私有 resource scope 完成 Agent 进程清理，再把 Run 写为 succeeded、failed、cancelled 或 interrupted。成功 Run 不再让 Agent 进程长期保持 idle；下一轮对话重新打开进程，并通过已持久化的 Folio/ACP/native Session 身份恢复上下文。保存与同步仍保持独立，Run 成功后 `sync_state` 继续为 `pending`，不会自动提交文件。

POSIX 生产进程和 Codex fixture 验证了 Folio 所有的 Agent 进程在 `succeeded` receipt 可见时已不存在；同一 Session 随后的恢复 Run 仍能继续。Task RPC 全文件 25 项通过。定向 lint、Desktop typecheck/production build 均通过；Desktop 全量 340 项中 338 项通过，仅两项既有 `GeneralSettings` `role="status"` 断言失败。

这个边界只能证明 Folio resource scope 所有的 Agent 进程已经退出。工具若故意逃逸到新的进程组，或外部编辑器在 clean preflight 后继续写入，仍不受该证明约束；在后续 sandbox 落地前不能自动把 terminal 当作任意 writer quiescence。当前手动 `wiki/**` RPC 仍要求用户显式选择、保存并发起同步；Skill、`raws`、Agent 切换继续不在本切片范围内。

## 2026-09-11 — Durable wiki 冲突解决与放弃

`git_sync_operations` 新增 `conflict_index`，并增加 `resolving` 与 `aborted` 状态。prepare 不再等全部 source commits 完成后一次性记录 canonical 结果；每个成功 prefix 都先生成确定性 commit bytes、写入 SQLite 数组并创建不可改写的 step ref，再把隔离 coordinator 推进到该 commit。后续 source commit 冲突时，日志因此准确指向冲突索引，重启不需要重放或猜测此前结果。

`tasks.resolveWikiConflict` 只接受属于指定 Task 的 operation。调用前 coordinator 必须没有未合并项、未暂存修改或未跟踪文件，暂存内容只能是普通 `wiki/**` 文件；main 与 Task 也必须保持冻结 HEAD 且干净。人工解决被写成当前 source commit 对应的 canonical commit 后，服务继续处理其余完整 source 区间；若再次冲突，沿用同一个 operation 和下一个 `conflict_index`。全部完成后复用既有 publish/align 收据路径。`tasks.abortWikiConflict` 只强制删除隔离 coordinator，把 operation 保留为 `aborted`；main、Task、source commit 和历史 refs 均不改写，并允许新的稳定 operation 从同一 source/main 重试。所有 coordinator 删除路径都会先验证它仍是该 operation 的 shared、detached worktree；路径被替换时拒绝并保留内容。`tasks.reprepareWiki` 同时校验 Task 与 operation 身份，跨 Task 调用返回 not-found。

Git/SQLite 分离恢复覆盖 canonical append receipt、最终 prepared receipt 和 abort receipt 三处失败。已接纳解决通过 deterministic bytes 与 step ref 跨重启恢复；未接纳的 coordinator 草稿不会被假装成收据。新增目录替换测试证明恢复不会删除未验证身份的路径；Task 双身份测试证明同 Vault 的其他 Task 不能 reprepare 该 operation。真实同步测试 29/29、Task RPC 25/25、同步/RPC/worktree/store/save 外围回归 84/84 通过；相关 lint、typecheck、production build 和 `git diff --check` 通过。Desktop 全量 350 项中 348 项通过，仅两项既有 `GeneralSettings` `role="status"` 断言失败。RPC 测试在 Agent runtime 故意不可用时完成 resolve/abort，确认文件操作不会启动 Agent。

本轮已把 coordinator 接入原 Task 的独立 `conflict-resolution` Run：使用原 Task Agent 和模型快照，Session cwd 固定为 `sync-worktrees/{operationId}`，Prompt 携带 Task goal、共同基线、双方 diff 和冲突文件。Agent 只能编辑 `wiki/**`，不能写 Git/index；成功 terminal 后 Folio 自动验证、暂存、继续 canonical prepare、publish 和 align，失败/取消则保留 coordinator 与 main/Task 现场。稳定 Run/RPC ID 重试不会重复 Prompt，成功 Run 可在后置接纳失败后重试。仍未解决的是 terminal receipt 与后置接纳之间的崩溃窗口，以及等待期间 main 前进后如何把已暂存结果重放到新基线；Skill、`raws`、Agent 切换和 UI 继续不属于本切片。

## 2026-09-11 — Run wiki 显式保存与同步状态收据

新增 `tasks.saveRunWikiFiles`：用户明确选择成功 Run 产生的 `wiki/**` 文件后，保存服务用稳定 Change ID 捕获快照，commit trailer 保留 Task/Run 身份，并沿用现有私有 index、CAS branch 更新和丢收据恢复。普通用户编辑仍走 `tasks.saveWikiFiles` 且不关联 Run，两种来源不会在稳定 ID 重试时互相冒充。已完成同步的 Run 不能用新 ID继续追加输出，但原保存 ID仍可幂等读取。此阶段最初仅支持单 Run；后续已替换为显式多 Run 来源，见文末最新检查点。

`git_sync_operations` 的 SQLite trigger 根据不可改写的 `source_changes` 找到 Agent wiki change 的 Run：operation 创建、冲突、继续解决、对齐和 abort 分别把 `sync_state` 投影为 `syncing`、`conflict`、`syncing`、`completed` 和 `failed`。因此 Run 成功或保存 commit 本身都不再冒充同步完成；只有 main 发布且 Task 对齐完成的 durable receipt 才完成 Run。同步 conflict 仍会复用既有 Routine 暂停 trigger。

真实 RPC 用 Codex fixture 完成一次成功 Run，等待 Folio-owned 进程退出，再由用户式 RPC 保存 wiki 并同步，最终核对 main 内容和 Run `completed` 收据。真实 Git 测试同时覆盖成功、冲突、abort、同输入重试和重新解决。同步测试 30/30、Task RPC 26/26、Git journal/save/sync/RPC/Routine 联合回归 90/90 通过；lint 与 Desktop typecheck 通过。当时尚未支持多个未同步 Run 绑定到同一用户保存批次；后续检查点已补齐。Skill、`raws` 和 Agent 切换保持不动。

## 2026-09-11 — Task 显式完成与 durable worktree 释放

新增 `tasks.complete` 及 service/renderer 入口，并把 Task worktree 状态扩展为 `releasing`、`released`。完成只接受 active/ready Task 或同一完成请求的 retry：active Run 会返回 `task-busy`，成功但仍为 pending/syncing/conflict/failed 的 Run 会阻止完成；随后关闭该 Task 的所有 Folio-owned live Sessions，并复核 worktree 的持久化路径、普通 `.git` 文件、shared repository、Task 分支、已登记同步 checkpoint、干净状态及与 main 一致的 tree。删除使用普通 `git worktree remove`，不使用 `--force`。

Task 先以 `completed/releasing` durable checkpoint 记录意图，Git 删除后再写入 `completed/released` 收据。Git 已删除但 SQLite 收据失败时，重启或重试会验证 worktree 未登记且路径不存在，再补写 receipt。已释放 Task 的重复 complete 和原始 create 请求都是只读幂等操作，不会重建 worktree；Task 分支、Session、Run、messages 和工具历史保持可查询。

真实 Codex fixture RPC 从成功 Run 开始，验证用户显式保存 `wiki/**`、canonical publish/align、Run `completed` 收据、关闭 Session、删除 worktree、保留分支与消息历史，以及完成/create 重试。另验证 active Run、成功但未同步 Run、dirty/untracked worktree、Task/main tree 不一致和路径身份错误均拒绝删除；Git/SQLite 分离的 release receipt 可跨 layer 重试恢复。若 durable release checkpoint 后出现新的干净 Task commit，重试会核对最后登记 HEAD、保留 checkout 并拒绝误完成；若删除后保留的 Task branch 丢失或移动，也不会补写 `released` 收据。Task 状态更新同时用 SQL admission predicate 关闭跨进程 Run 预留竞态。Task worktree/sync/RPC 联合回归 65/65 通过，相关 lint、Desktop typecheck 和 production build 通过。Desktop 全量 356 项中 354 项通过，仅两项既有 `GeneralSettings` `role="status"` 断言失败；报告 `/tmp/folio-desktop-task-complete-final-2.json`。

当前没有完成后重开。Routine Task 的成功同步与无变化收据已在下一阶段接到 complete。跨进程未知 Session/process ownership 仍不能证明所有外部 writer 已停止；clean preflight 后外部编辑器再次写入的竞态继续保留为安全边界 TODO。Skill、`raws` 和 Agent 切换未改动。

## 2026-09-11 — 成功 Run 的显式无 wiki 变化收据

新增 `tasks.confirmRunWikiUnchanged` 及 renderer mutation。调用方只提交 Task/Run 身份和观察到的 `expectedHead`；main process 在 Vault Git 写锁内验证 Run 为 `succeeded/pending`、HEAD 仍等于该 Run 的 immutable baseline、baseline 已登记、没有 tracked/untracked `wiki/**` 差异，也没有 prepared/applying 保存意图，之后才把 Run 持久化为 `not-required`。它不会从 ACP idle 自动推断，也不会把 failed/conflict/completed Run 改写成无变化。

Run 本身就是 durable 幂等收据：相同请求在 Task 完成并删除 worktree后仍可返回原记录，错误 baseline 则拒绝。真实服务测试还验证未保存 wiki 输出和“工作文件已恢复干净但 durable 保存意图仍存在”两种情况都保持 `pending`。真实 Codex fixture RPC 验证成功 Run、Folio-owned 进程退出、显式确认、Task 完成/release、main 与 Task 分支不产生额外 commit，以及释放后重试。Skill、`raws` 和 Agent 切换未改动。

## 2026-09-11 — Routine Task 自动完成与崩溃恢复

Routine 仍不会自动提交 Agent 修改。只有用户显式保存并完成 canonical align，或显式确认本轮没有 wiki 变化后，TaskService 才检查该 Routine Task 的所有成功 Run 都已有 `completed`/`not-required` 收据，并复用与手动完成相同的 Session 回收、clean/tree/identity 校验和 durable worktree release。手动 Task 不受该自动路径影响。

自动完成覆盖 synchronize、stale reprepare、conflict resolve 和 no-change 四个成功出口。若应用在最终 receipt 已提交但 cleanup 前退出，每次 Vault scheduler tick 会先扫描并重试已结清的 Routine Task；单个 dirty 或身份异常 worktree 只记录 warning 并保留现场，不阻断其他 Routine 的到期收集和派发。真实 RPC 分别验证 Codex no-change、保存 wiki 后 align，以及跨应用重开后的 tick 恢复。Skill、`raws` 和 Agent 切换未改动。

限定范围的 Standards/Spec review 又收紧了五个生命周期边界：scheduler 现在会恢复 `completed/releasing` 的丢收据窗口；Routine 只在按数据库单调 `runs.sequence` 判定的最后一个 Run 成功时自动完成，不依赖墙上时钟或随机 ID；receipt RPC 与后置 cleanup 解耦，release 失败不会掩盖已持久化的 `not-required`/`aligned`；自动重试不会关闭用户正在用于检查现场的 live Session；Session 启动与 Task completion 共用 Vault admission gate，避免 close 后再钻入新的 Agent 进程。测试覆盖同毫秒逆序 ID、系统时钟回拨、Git 已删除但 SQLite receipt 丢失、dirty cleanup、live inspection Session，以及启动 barrier 与 completion 的竞争。

本轮收尾验证：生命周期修正后的 Task worktree/sync/change application/Session/RPC 联合回归 96/96 通过；单调 Run 顺序调整后的存储/Routine 回归 32/32 通过；相关文件 lint、Desktop typecheck、production build 和 `git diff --check` 通过。Desktop 全量 365 项中 363 项通过，失败仍仅为两项既有 `GeneralSettings` `role="status"` 断言；本轮未修改该组件或测试。RFC 仍在实施中，未生成新 `.app`，未进行真实模型请求或人工 Electron 界面验收。

## 2026-09-11 — 多 Run 共用一次用户保存批次

`tasks.saveRunWikiFiles` 的公开意图从单个 `runId` 改为非空 `runIds`。main process 对集合排序去重；稳定保存 ID 的重试必须匹配同一规范化集合。`git_change_preparations` 不再保存单值 Run 外键，改由不可修改、不可删除的 `git_change_preparation_runs` 关联表记录完整来源。数据库用 `(run_id, kind)` 唯一约束防止同一 Run 的 wiki 结果被两个保存批次重复认领，同时不把未来独立 raws 保存和 wiki 保存混为一类。

确定性 commit 为每个 Run 写一条按 ID 排序的 `Folio-Run-Id` trailer。canonical operation 的 insert/conflict/resolve/align/abort trigger 通过关联表把同一批次所有 Run 一起投影为 `syncing/conflict/completed/failed`；不再把共同文件静默归给最后一个 Run。逐 Run 的 `confirmRunWikiUnchanged` 语义保持不变，不能用一次无变化确认替其他 Run 结清。

真实 SQLite/Git 测试覆盖乱序和重复 ID 规范化、稳定 trailer、一个保存批次同时完成两个 Run、原 ID 幂等重试时集合匹配、第二个批次重复认领拒绝，以及单 Run conflict/abort/retry 原行为。PTY 手动探针再次完成磁盘写入、Run/writer 门禁、source capture、隔离 canonical prepare、main publish 和普通提交对齐，最终 main/Task tree 收敛。Git journal/change application/synchronization 3 文件 57/57，通过；Task RPC、Vault 反向链接、Task worktree 和 workspace changes 4 文件 62/62，通过。旧 schema 模拟 fixture 已同步删除新关联表，Routine queue 8/8 通过。Desktop 全量 365 项中 363 项通过，唯一失败仍是两项既有 `GeneralSettings` `role="status"` 断言；Desktop production build、typecheck、相关 lint 和 `git diff --check` 通过。两轴 Standards/Spec review 均为 0 findings。Skill、`raws`、Agent 切换、自动保存和 UI 均未在本检查点实现。

## 2026-09-11 — 手动 Task 重开与分支历史保留

新增 `tasks.reopen` 及 `TaskWorktrees.reopen`。仅允许已完成且已释放的手动 Task 重开；要求原 worktree 已不存在、Task 分支仍存在且 main 工作区干净、处于 `main`、当前 HEAD 已登记。重开以当前 main HEAD 作为新的 `worktree_base`，复用原 Task ID、路径和分支创建 checkout，不 reset/clean 任一用户文件。

分支提升前先用 generation-specific protected ref `refs/folio/task/{taskId}/reopen/{mainHead}` 固定旧分支头，再以 compare-and-swap 更新 Task 分支到当前 main。SQLite 状态更新失败时，后续相同请求可凭 protected ref 识别已完成的 Git 步骤并继续；旧提交历史仍可从该 ref 访问。重开后的 Task 继续受现有 Run/Session/synchronization admission gate 约束。

Routine Task 暂不允许重开，避免旧 Routine Run 在 scheduler tick 中被误判为新一轮；Routine 应通过新的触发创建新的 Task 身份。待后续补充 reopen generation 后再开放该路径。

验证：TaskWorktrees 重开/SQLite 收据失败重试 2 项、Task RPC 当前 main 已登记后重开 1 项均通过；Desktop typecheck 和相关 Git/RPC 回归通过。

## 2026-09-11 — 重开后的同步前沿与手动边界回归

修复重开 Task 在已有同步历史且 main 于完成后继续前进时的前沿错误。重开现在向 `TaskWorktrees.ensure` 传入当前 main 的显式双侧 checkpoint；历史 `aligned` operation 仍保留用于审计，但不会再被当作新 checkout 的期望 HEAD。同步准备同时识别新的 `worktree_base` generation：当它位于历史 operation 的 `published_head` 之后时，从新的 main 基线开始枚举 Task source commits，避免把其他 Task 的 main 提交误判为当前 Task 的保存日志。

新增真实 Git/SQLite 回归：Task 完成并释放、main 通过已登记用户提交前进、Task 重开、再次手动修改 `wiki/**`、保存并 canonical publish/align；验证新旧分支历史均可追溯，main 与 Task tree 再次收敛。TaskWorktrees 与 TaskGitSynchronization 定向回归 43/43 通过。此前手动 PTY 探针继续证明 dirty main、Task 草稿、未登记 commit、main 并发前进和 coordinator 身份异常均拒绝且不覆盖现场。

当前切片仍明确排除 Agent 切换、Skill 装配、Integration 脚本和 `raws`；这些不会因手动 wiki 闭环通过而被视为已实现。普通 Run 自动保存、逃逸进程/外部编辑器停止证明、Task 文件选择 UI、冲突解决后 main 前进时已暂存结果的重放，以及 Routine Task 重开仍是后续工作。

## 2026-09-11 — Task worktree 文件选择与差异 UI

新增 `TaskWikiChangesPanel` 并接入 Task Sessions：用户可查看 Task worktree 中仅限 `wiki/**` 的变更，预览实时或已保存快照差异，明确勾选文件后创建 Task source commit，再单独发起 canonical publish/align。面板在当前挂载周期保留保存/同步稳定 ID，响应失败后的重试不会扩大文件范围，也不会在查看差异时写入 Git；已准备的同步可显式重新准备到当前 main。保存、同步、reprepare 和 conflict-resolution 的稳定 intent 已可跨页面刷新恢复，文件选择和内容仍不会写入浏览器存储。

新增 renderer 测试覆盖显式选择与差异安全、保存/同步/reprepare 失败重试、过期同步重新准备及冲突入口；Task UI 回归 9/9，Desktop typecheck 通过。面板现在可选择成功 Run 作为 wiki 保存来源，并为无文件变化的成功 Run 写入显式 `not-required` 收据；仍不自动保存 Run 输出。

## 2026-09-11 — 冲突解决结果的 durable replay

补齐 main 在冲突解决接纳前继续前进的恢复边界。`git_sync_resolution_inputs` 保存每个冲突索引从已接受 canonical 前缀到用户暂存结果的不可变二进制 patch、source commit 和 tree；`resolve` 在检查 main 基线前先落盘该输入，因此 stale main 或后置 Git/SQLite 失败不会丢掉已暂存答案。`tasks.reprepareWiki` 现在也接受 `conflict/resolving` operation：旧 operation 进入 `superseded`，新 operation 沿 `supersedes_id` 继承 replay 链，在当前 main 上用 `git apply --3way --index` 重放；无关 main 修改自动继续，同文件修改则保留新的 conflict coordinator 供用户再次解决。

新增真实 Git/SQLite 回归覆盖：staged resolution 在失败后重启、无关 main 前进后的自动 replay、同文件 main 前进后的重新冲突、已接纳 canonical prefix 后的后续冲突 replay，以及 replacement operation 的历史保留（同步测试 37/37）。回放前会复核 source/parent/tree 身份、Git 对象存在性和应用后的暂存路径必须属于 `wiki/**`，避免损坏的持久化 patch 越界写入；整体 tree 允许包含 main 在此期间新增的无关文件。Task 文件变更面板对 `prepared/conflict/resolving` 均提供显式 reprepare，不会自动保存或覆盖现场；同步失败重试保留同一 operation ID。接纳窗口的 publish/alignment receipt 丢失恢复也已用真实故障注入覆盖，剩余 TODO 收敛为重放后的多次冲突交互收尾。

## 2026-09-11 — 冲突上下文与固定 Agent 的 UI 入口

新增 `tasks.wikiConflictContext` 安全查询，只向 renderer 返回冲突文件、共同基线和有大小上限的双方 diff，不暴露 coordinator 路径。`TaskWikiChangesPanel` 现在可查看冲突上下文、启动原 Task 固定 Agent 的 conflict-resolution Run、接纳已暂存结果或显式放弃 coordinator；启动请求在响应丢失时保留完整稳定 ID。renderer 回归 7/7 通过。仍未把冲突解决 Run 的会话消息内嵌到该面板，用户可通过现有 Session 历史查看执行过程。

面板已把手动 Task 文件保存、成功 Run 来源保存和逐 Run 无变化确认接到对应 RPC；在该检查点，页面刷新后的稳定 intent 恢复，以及冲突解决 Run 消息在面板内的联动仍未实现（后续检查点已补齐）。

## 2026-09-11 — renderer 稳定重试意图跨刷新恢复

`TaskWikiChangesPanel` 现在将保存、同步、reprepare 和 conflict-resolution 请求的非敏感重试元数据保存在按 Vault/Task 隔离的 `sessionStorage` 中。renderer 刷新后可以恢复原稳定 ID、Task/Run 身份和观察到的 Git HEAD，继续调用同一 durable RPC；服务端仍会重新验证 worktree、HEAD、文件范围和数据库收据。文件选择、文件内容、凭据和本地路径不会写入浏览器存储，存储不可用时仍退回服务端收据与当前页内重试。

新增卸载/重挂载回归，覆盖保存响应丢失后重试原保存请求，以及同步响应丢失后重试原同步 operation；Task wiki 面板回归 10/10，相关 ESLint 通过。冲突解决 Run 的消息仍通过 Session 历史查看，尚未内嵌到文件面板。

## 2026-09-11 — 冲突文件面板嵌入解决 Run 历史

冲突/`resolving` 状态的文件面板现在通过 Task 固定的 `syncOperationId` 找到对应 conflict-resolution Session/Run，并嵌入该 Run 的消息与工具投影。展示仍是有界、纯文本/JSON 的只读内容；没有暴露 coordinator 路径，也不会把消息解释为已接纳结果。无对应 Session 或消息时保留现有冲突上下文，不阻止人工接纳或放弃。

冲突 UI 回归继续通过，覆盖消息投影展示；页面刷新后的稳定重试意图和 conflict Run 上下文均已完成。剩余 TODO 收敛为 terminal receipt 与后置接纳之间的崩溃注入覆盖、重放后再次冲突的交互细节，以及外部 writer/sandbox 边界。

## 2026-09-11 — 回归基线收敛

补齐旧 schema 回归夹具对 migration 0017 replay-input 表及触发器的清理，避免重建旧 ledger 时重复建表。`GeneralSettings` 补回保存中的可访问状态反馈（`Saving…`/`Saved`），不改变其非乐观提交语义。Desktop 全量 Vitest 现为 58 个文件、385/385 通过；Task wiki 相关 lint、Node 类型检查和 `git diff --check` 通过。Web 类型检查仍受仓库已有的 `packages/ui` 与应用 React 类型副本冲突阻断，未出现本轮文件错误。

## 2026-09-11 — 手动 wiki 探针可脚本化复验

手动外围探针现在同时支持交互式 PTY 和 newline-delimited stdin；两种入口共用同一组
Run/writer、source capture、隔离 canonical、main publish 与 Task align 状态转移。固定脚本
序列已验证返回码为 0，并最终收敛 main/Task tree。该改动只改善验证可重复性，不扩大生产
writer quiescence 证明：`writer stopped` 仍是实验前置条件，Skill、`raws`、Integration 和
Agent 切换继续不在本切片范围内。

## 2026-09-11 — conflict Run 接纳窗口的 receipt 重试

修正 conflict-resolution Run 已成功但后置 Git 接纳收据丢失时的重试语义：只有 `aligned`
才是接纳终态；`prepared`、`published` 和 `aligning` 会继续执行 publish/align，复用已写入
的 canonical、alignment commit 与受保护引用，不重复启动 Run 或生成新的来源提交。补充真实
SQLite/Git 故障注入，分别覆盖 publish receipt 丢失和 alignment receipt 丢失，验证 main/Task
已发生的安全 Git 进展被保留，移除故障后使用同一 Run ID 可恢复到 `aligned`。

本轮验证：手动 wiki 探针普通路径和同文件冲突路径均返回 0；dirty main、prepare 后 main
前进、source 冻结后 Task 新草稿三条拒绝路径均命中对应 gate；生产 Git/SQLite/RPC/Vault
回归 7 个文件 130/130 通过（其中同步测试 37/37）。Skill、`raws`、Integration 实际装配
和 Agent 切换仍未纳入；普通 Run 自动保存、逃逸进程/外部编辑器停止证明及重放后再次冲突的
交互收尾继续保留为后续工作。
