# 全仓代码审查与修复

目标：审查自有代码的数据模型、处理逻辑和重构价值，修复可验证问题。包含 Desktop 主进程/RPC/Renderer、Agent、Integration、UI、构建与测试脚本；repos/ 只读参考。不把通过测试等同于完成架构审查。开始时工作区已有暂存改动，保留其内容和暂存状态。

当前结论：范围内的代码审查和已确认问题修复已完成。最终 Desktop 383 项、Agent 172 项、Integration 77 项通过；2 项需要真实外部服务的测试未运行。全仓类型检查、lint、生产构建通过。下文按阶段保留过程记录，其中早期的“待复核/进行中”描述当时状态；最终契约复核见第八轮。最新 macOS 目录包的独立目录冒烟通过：移出仓库后 SDK 加载、Worker 启动与释放均成功；打包依赖收集回归 2 项通过。

## 已验证发现

1. Routine 保存的幂等判断依赖 JSON 对象字段顺序，且首次保存重试把 null revision 与 0 比较。新增用例复现；改为结构相等比较和正确的重试版本判断。
2. previousRoutineDate 将本地中午当作 UTC；UTC+13/+14 的上一日计算错误。按 Routine 时区构造日期，覆盖跨年和 DST。
3. Routine 接受无效时区，随后调度可能产生 defect。Schema 在保存前拒绝。
4. 日终窗口被后续触发扩展到下一日；首次日终调度可能产生反向窗口；下一窗口若从触发墙钟接续会漏数据。按既定 RFC 固定日终边界，从上一已保留窗口结束接续；补充真实 SQL/Queue 回归。
5. Routine 检查已入队任务逐条查 runs。改为一次关联查询，保持原有排队窗口不可变约束。
6. ACP 合约测试仍假定文本 chunk 后立即 stop，未覆盖新增的 messageComplete。修正测试为检查同一 messageId 的完成通知再检查 stop，没有修改生产协议。
7. 全仓 lint 基线 3 errors / 4 warnings：删除无 yield 的 RPC generator、SessionLease 不必要的 this 别名、无用 import/计数器；fixture 空 catch 明确说明默认值。

## 验证记录

- 修复前 Routine 回归：3 项失败（两个时区、保存重试）。
- 修复后 Routine + VaultRuntime：18 项通过。
- Agent 基线：159 passed / 1 failed；修正 ACP 合约测试后，合约与 lease 18 项通过。
- Integration 基线：62 passed / 2 live tests skipped。
- 全仓 typecheck 基线通过；修复后需最终重跑。

## 范围与进度

| 范围 | 状态 | 验证重点 |
|---|---|---|
| Routine DTO/store/scheduler/TaskService | 已复核并修复 | 幂等、时区/DST、窗口和配置冻结回归通过 |
| Run files / execution recovery / global scheduler | 已复核 | 损坏、多 Vault、占用与清理顺序回归通过 |
| 消息缓冲、Session、Worker、Git 操作 | 已复核并修复 | 完成写入、归档恢复、Git 保存/同步和进程清理回归通过 |
| Agent config/schema/directory/skills | 已复核 | 配置隔离、资源选择与 model/runtime 对接 |
| Agent ACP archive/registry/lease | 已复核并修复 | 租约获取后的归档读取与序号竞争回归通过 |
| Agent Pi/Codex transport/mappers/runtime | 已复核并修复 | Pi 终态、宿主工具、Codex 协议和原生进程回归通过 |
| Integration Lark/Gmail/base | 已复核并修复 | 授权恢复、锁内状态发布、资源升级与提取分页回归通过 |
| Desktop config/model/vault/Electron/RPC | 已复核并修复 | 凭据共享、Vault 生命周期、窗口绑定及 IPC generation |
| Renderer + UI | 已复核并修复 | Routine 日历、Task 首次会话、Settings、Workspace/Git 面板；共享样式封装保留 |
| 构建、脚本、测试基础设施 | 已复核并修复 | 依赖收集补丁、独立产物、Worker 探针；真实服务脚本保持显式 opt-in |

范围涵盖自有源码、Integration 提取脚本、构建配置与诊断探针。此审查不等同于所有平台和真实服务的端到端验收：Windows/Linux 原生行为、真实账号授权/模型调用及签名发布仍未实测；macOS 本地产物使用未签名目录包，不发布。


## Vault 删除与后台生命周期：发现与修复依据

修复前，VaultLauncher.remove 仅关闭窗口，再调用 VaultService.remove 删除磁盘文件，最后删除配置登记。
VaultRuntime 缓存的 LayerMap 使用无限 TTL，open 返回长期可持有的 TaskService；GlobalExecutionScheduler / RoutineScheduler 在窗口关闭后仍能执行这些方法。因此删除磁盘前未保证后台调用、Worker、SQLite 已退出，是本次发现的高优先级问题。

需要解决的边界：
- 拦住新的 open/claim/Routine/RPC 调用，同时使已经持有的 Service 失效。
- 等待或中断并 join 在途操作，尤其 executeRequest 的不可中断清理，不能仅 invalidate LayerMap。
- 无法确认 native process 退出时拒绝删除，保留恢复文件。
- 关闭 per-Vault Scope / SQLite 后再删文件及注册表，失败允许明确重试。
- 覆盖打开新请求与删除竞争、已运行/queued Run、其他 Vault 不受影响、磁盘/注册表删除失败。
- 可以用 per-Vault operation lifetime 包装所有 TaskService Effect/方法，持有在途 fibers；不要只处理窗口、单个 Run，或新增绕过生命周期的入口。

另已修复删除重试：managed 目录消失时从稳定 config 根解析预期 link 目标，仍允许删除残余链接并重试移除注册。VaultService / VaultLauncher / vault RPC 共 30 项测试通过。

本轮静态检查：修复后全仓 typecheck 通过，lint 剩余一个混合 import 警告已删除，需最终再确认。


## Vault 生命周期修复进展

已实现 task-operation-lifetime：所有 TaskService 方法（含 workspace）统一跟踪在途 Fiber，退休时拒绝新调用、中断并 join 旧操作、显式关闭 Session，再核对恢复记录与活动 Run。VaultRuntime.withClosed 使用按 Vault 的锁协调 open 和删除，invalidate 确认关闭 SQLite 后才执行删除回调。后台清理失败不删除文件或注册，旧引用在成功关闭后永久失效，失败回调允许下次重新建 Runtime。

验证：基础生命周期/窗口/RPC 31 项通过；补充关闭 SQLite 的路径证据、Launcher 清理失败保留文件断言后 17 项通过；真实 Worker + 本地 Codex fixture 持续运行时删除 Vault，确认进程退出、恢复文件清空、旧引用拒绝，VaultRuntime 8 项通过。没有真实模型请求。

修复中回归测试还捕获了 FiberSet.run 先执行操作再登记的竞态；改为不立即启动的 forkDetach，先加入跟踪集合，确保并发删除不能漏掉刚启动的操作。Vendored Effect 仅作参考，未改动。

尚需全仓审查后续部分及最终全量验证，不能据此宣称整个目标完成。


## Integration 授权边界修复

- Gmail Desktop OAuth 在 Effect generator 中使用 JavaScript finally，失败/取消不会执行预期清理，回调端口泄漏。回归先复现两项失败，改用 Effect.ensuring + scoped callback Fiber；先安装监听再发布授权 URL，覆盖发布期间立即回调。
- Lark device OAuth 的定时器可能提前唤醒，原来会在不足轮询间隔且即将过期时请求 token。改为等待实际轮询时刻；新增可控时钟模拟提前 1 ms 唤醒，确认到期不发送 token 请求。
- Gmail 新测试使用 instanceof Server 收窄监听器实例类型，避免依赖 Vitest mock context 的未知类型。

## 当前验证结果

- Desktop 全量：60 个文件、357 项通过，含真实 Worker 清理及 SQLite 关闭。
- Agent 全量：28 个文件、160 项通过。
- Integration：65 项通过、2 项真实外部服务测试跳过；随后新增的提前唤醒用例与原过期用例均通过。
- 全仓 typecheck、lint、桌面生产构建通过。构建在 Desktop Worker 测试结束后运行。
- 资源移除快照的实现已核对：生产源码无 task_resource_snapshot 引用，TaskResources 直接返回安装路径；升级、凭据刷新、无集成、准备失败和工作区文件边界均有测试。

上述结果仅覆盖已记录的修复，全仓系统审查仍按范围表继续。

## 第二轮修复与回归

- Routine 已预留 Task 曾使用最新 Routine 配置重新校验/提交，编辑后可能无法运行。Task 保存预留时的模型与时区，提交使用既有 Task 的 prompt/Agent/资源与窗口；日终合并也使用保存的时区。真实 Store/Runtime 回归覆盖修改配置后提交与重试。
- 日历以成功的日终回执判断完成，补齐缺少回执日期；没有暂停历史时不把缺失直接解释为失败。历史按保存的时区显示，日期分批渲染，防止长历史一次生成大量 DOM。
- 手动 Task 在首次 Run 前只有 pending 工作树，原 UI 不开放 Sessions，导致无法发起首轮。现在所有 active Task 可进入 Sessions，移除无效的重复创建入口。
- Pi SDK 在 error/aborted/length 后可能正常 resolve；现在按最后一条 assistant 完成原因判定结果，异常部分消息保留 incomplete。针对三类 stopReason 的合约测试和消息存储测试通过。
- ACP resume 曾在获取租约前读取归档，可能遗漏前任持有者最后追加的消息并复用序号。改为先读身份头、获取租约后读历史并核对身份；确定性竞争测试先复现、后通过。
- Gmail 提取移除 200 条静默上限，分页去重、检测重复 cursor，并按毫秒精确过滤半开时间窗口。Lark 检查聊天/消息分页完整性，CLI 非法 JSON 转为可捕获失败。实际脚本的本地子进程测试 6 项通过。
- Gmail/Lark 已安装资源按内容原子更新，保留凭据与失败前文件、允许部分安装重试；移除没有生产调用的 Gmail 旧设备授权路径和直接 gaxios 依赖。离线 frozen lockfile 验证通过。

第二轮最终验证：全仓 typecheck、lint、生产构建通过；Desktop 364/364、Agent 164/164、Integration 73 passed / 2 live skipped；暂存与未暂存 diff 空白检查均通过。前一次并发测试中的 5 秒超时在最终顺序回归中没有重现；长历史日历卡住已通过分页修复并覆盖边界测试。

范围更新：Routine 配置冻结/日历、Task 首次会话、消息落库与 Pi 结果、ACP 归档所有权、Integration 提取/资源升级已经复核。后续全仓审查仍需覆盖 Git 保存/同步事务边界、Worker 协议与工具宿主、完整模型/凭据编译链路、剩余 Settings/Workspace UI 与构建脚本。本轮完成资源简化请求，不宣称全仓审查已完成。

## 第三轮：Git、模型凭据与无调用方代码

1. Git 冲突处理未使用字面路径：`wiki/[draft].md` 会额外匹配 `wiki/d.md`，把无关内容放入 Agent 上下文；无关文件为可执行文件时还会误拒绝已暂存的解决结果。新增真实 Git 回归先复现上下文污染，修复三个动态路径参数入口后覆盖完整 resolve/publish/align。Git 保存、日志、快照、同步与工作区读取共 72 项通过。
2. Provider ID 字典错误读取对象原型：合法的 constructor/toString/__proto__ 导致凭据读取错误或模型配置误报冲突。凭据仅访问自身属性，编译时使用 Map 并在输出边界转换普通对象；三类 ID 均覆盖保存、重新打开、读取、删除和编译序列化，6 项先失败后通过。
3. `setCredential(profileId)` 修改的是 Provider 共享凭据，却仅清空当前 Profile 的连接状态。统一按 Provider 清空依赖 managed 凭据的 Profile 状态，环境变量凭据的独立结果不受影响。真实 Service 回归先复现旧 ready 残留，修复后 ModelService 20 项通过。
4. 凭据文件锁在 acquisition 返回和外层取消检查之间泄漏：外层包装器抛出取消错误，丢失 release 函数，调用方尚未进入 finally。改为直接接收锁所有权，并在 finally 保护内检查后续取消；锁获取错误仍做脱敏映射。modify/delete 两项确定性微任务竞争测试先复现 release 未调用，修复后通过。完整 Agent 回归 172 项通过。
5. 当前 ModelsSettings 已使用 Provider 设置流程，但旧 Profile 表单、卡片、凭据弹窗及其 RPC mutation 仍留在 Renderer，没有任何调用方。删除六个旧组件/Hook 和六个未使用 mutation；保留仍被配置文件、Session 和后端消费的 Profile 模型及服务，不新增兼容路径。历史 RFC 中旧表单名称仅描述当时实现。

已阅读 GitChangeApplications/Journal/Snapshot/SaveIndex、TaskGitSynchronization、WorkspaceChanges、GitWriteLock、TaskService 对接；模型编译、凭据存储、Pi runtime adapter、ModelService；Worker 协议、客户端、线程入口、Pool、NativeAgentProcess 与 Pi tool host；Settings 的当前 Model/Integration/General/Vault 页面。以上是覆盖记录，不等同于已证明所有边界无问题。

第三轮最终验证：Desktop 60 个文件 / 366 项、Agent 29 个文件 / 172 项通过；删除死代码后的全仓 typecheck、lint、差异空白检查通过。生产构建在 Worker 测试前通过；Renderer 清理后的最终构建与 ModelsSettings 定向回归也通过。Integration 源码本轮没有变化，沿用第二轮 73 项通过、2 项 live skipped 的证据。

后续重点包括 Integration 并发状态服务、Workspace/UI 余下路径与打包脚本。Agent 本地 host-tools 已确认直接复用 SDK 工具定义与执行器；Grep/Find 等工具的原生子进程所有权仍需结合 SDK 实现核查。AgentSettings 中 Codex “后续支持”文案与已经可选的 Task Agent 不一致，需沿当前设置能力核对并更新。

## 第四轮：Integration 资源契约与 Workspace 调用方

- 资源选择原先只判断每个 Integration 至少选中一项；`notes/im + notes/missing` 会静默忽略不存在的资源并启动不完整任务。现在在调用任何 provider hook 前验证全部显式选择，去重仍保持幂等。新增用例先复现错误成功，再验证失败且 hook 未调用。
- 多个资源声明同一 workspace 文件时，Map.set 原先静默覆盖。现在按 TaskResources 一致的斜杠规范化路径，内容不同明确失败，相同内容去重；覆盖同一路径及 Windows 分隔符等价路径。
- AgentSettings 的 Codex 说明改为本地 CLI 配置，明确创建任务时可选择，移除“后续支持”的过时描述。
- 已阅读 IntegrationService/Store/Catalog、defineIntegration、Lark auth/integration/state 与 Gmail integration/state/oauth；已追踪 WorkspaceChangesPanel/TaskWikiChangesPanel 的保存重试、基线检查、同步回执、冲突启动及 sessionStorage 意图。没有把页面本地状态当作数据库或文件完成证据。

验证：两项新行为最初均失败；最终 IntegrationService + TaskResources 28 项通过。随后构建与前后端类型检查通过，包含真实 Worker/VaultRuntime 和 Workspace/TaskWiki/Model UI 的六文件回归 64 项通过。全仓 lint 和差异空白检查通过。

下一步需用竞争/失败用例核实：

- Lark maintain 在 auth.reconcile 释放安装锁之后才 writeState，是否可能把旧快照发布到新的连接进度之后；不要只在 host reconcile 上检查 revision。
- Gmail 已保存 refresh token，但 access token 过期或刷新后 verified=false 时 inspect 返回 login_required；host 对非 ready 行只做只读 inspect，需验证一次暂时失败之后能否不重新 OAuth 而恢复。
- SDK find/grep 内部启动 fd/rg，不经过 NativeAgentProcess 的登记回调；已确认工具接受 AbortSignal，但还需验证 close 是否等待真实子进程退出，尤其启动中取消与下载工具时的行为。

这些是待验证边界，尚不作为已修复问题或最终审查结论。打包路径与共享 UI 剩余代码仍需覆盖。

## 第五轮：授权恢复与发布顺序

- 已复现 Lark maintain 的锁边界错误：状态发布暂停时，下一次需要同一安装锁的操作已经完成。auth.reconcile 改为在锁内调用发布回调；读取事实失败时发布 unavailable 结果，由 Integration 映射 check_failed。发布本身失败只记录诊断，不在释放锁后再写可能过时的 fallback。真实 setup 与立即调度的竞争 Fiber 回归先失败、修复后通过；Lark 44 项生命周期测试通过。
- 已复现 Gmail 短暂检查失败后的恢复入口缺失：过期令牌刷新后 verified=false，或者已保存的未验证令牌，均被 inspect 当作需要重新授权。现在保留 refresh grant、返回 recovering 并提供 retry_check；用户仍可选择重新连接。原先已验证令牌的健康检查失败也持久化 verified=false，避免继续显示 ready。三类凭据均覆盖失败后重试、恢复 ready、不触发浏览器 OAuth；Gmail 10 项通过。
- Integration 全量在前两类 Gmail 回归时为 76 passed / 2 live skipped；随后新增已验证令牌用例并再次跑 Gmail 全部 10 项通过。全仓 typecheck、lint、生产构建通过，Desktop Integration/TaskResources/VaultRuntime/IntegrationCard 46 项通过。
- 首次实际执行本地 macOS arm64 未签名目录打包：electron-builder --dir --publish never --config.mac.identity=null 成功。未签名产物位于 apps/desktop/dist/mac-arm64/Folio.app，不发布；使用产物自己的 Electron Node 模式启动包内 Worker，dispose 回复与 exit 0 均确认。打包器提示部分重复/其他平台可选依赖，正在用脱离仓库目录的产物验证是否实际影响依赖解析，不能仅据打包成功认定发布可用。

共享 UI 已阅读 Dialog/Button/ToggleGroup/Sidebar/use-mobile 的状态和事件边界；大多数只是 Base UI 样式封装，不引入新的领域模型。工具子进程、剩余 UI/构建脚本覆盖和最终跨模块审查仍未完成。

## 第六轮：脱离仓库后的打包依赖

- 第五轮的仓库内 Worker 检查不足以证明可分发：把产物复制到 `/private/tmp` 后，飞书 SDK 加载立即失败，缺少 `get-intrinsic`。原检查通过是因为 Node 从仓库祖先目录补齐了依赖。
- 根因是 electron-builder 26.15.3 的 pnpm 收集器按 name/version 跳过重复包的整个子树，但 pnpm 10 在不同分支中展开的子依赖不同；另外 npm alias 的去重引用使用相同物理路径、不同包名。通过 pnpm patchedDependencies 修复两处，不改变 node-linker，不把间接依赖提升成直接依赖。保留既有锁文件版本；补丁及撤除条件记录在 `patches/README.md`。
- 新增两项直接执行真实收集器的回归：重复父包下唯一展开的子依赖，以及别名解析返回符号链接路径的情况。新增 `test:packaging` 与 macOS `package:smoke` 命令。后者用 APFS clone 复制应用并保留相对符号链接，清空 NODE_PATH/NODE_OPTIONS，使用产物自己的 Electron 加载 Lark/Gmail SDK、启动 Worker、核对 dispose 回执与 exit 0，最终删除临时副本。
- 最终未签名 arm64 目录打包通过；日志不再包含 unresolved duplicate dependency references / cannot find path。独立目录冒烟通过，两项收集器回归、脚本 lint、diff 空白检查和离线 frozen-lockfile 安装通过。仍有其他平台可选二进制未安装提示，不把 macOS 结果推广到 Windows/Linux，也未验证 GUI、真实授权或模型调用。

工具子进程继续审查：已阅读安装版本 SDK 的 find/grep 实现。find 的 abort 会在 child close 前 settle，而且查找 `.git` 的异步阶段后没有再次检查取消；grep 在 ensureTool/isDirectory 后注册 abort listener，没有补检已取消状态。需要补充确定性生命周期回归并修复宿主边界，不能把 SDK Promise 完成直接当作所有进程已经退出。全仓审查仍未完成。

## 第七轮：搜索进程所有权与 macOS 退出竞争

- 真实 SDK 的 find/grep 回归先复现：工具输出正常，但没有任何进程登记/退出回执。给已安装 Pi SDK 的两个工具增加可选 spawn hook（pnpm patch，含类型声明），由 Folio 的本地执行器强制注入；参数构造、结果解析及截断仍归 SDK。
- PiToolHost 为 bash/find/grep 统一保留原生进程所有权。搜索通过等待 stdin 的 bash 登记后 exec，PID/进程组不变，搜索参数作为 argv 传递。取消时先关闭所属进程；即使 SDK 提前 reject，也等待登记、真实 close 和持久清理回执完成。结束后的异步准备不能再启动子进程。清理失败的记录保留，close 可以重试；调用方传入的 AbortSignal 也生效。
- 两次全量回归都发现 find 取消时 `kill EPERM`，不能解释为普通超时。用独立 Node/ps 探针确认 macOS 僵尸进程组返回 EPERM，而 Node 回收后返回 ESRCH；新增同步阻止 libuv 回收的确定性原生回归，修复前失败。NativeAgentProcess 仅在观察到 child close 后继续执行最终进程组清理；未退出的真实 EPERM 仍失败。两项 native 测试覆盖僵尸竞争和拒绝吞掉真实权限错误。
- Host 共 11 项回归覆盖 SDK 输出、启动前取消、登记中取消、运行中取消、同 ID 排他、退出回执延迟/重试、登记失败不得执行命令。Host + Native 13 项通过，Agent 全量 172 项通过。修复后的最终 Desktop 全量 62 文件 / 382 项通过，重新构建、前后端类型检查与全仓 lint 通过。Native 回归还明确要求最终组探测返回 ESRCH，而非任意错误。
- 更新后的 macOS arm64 未签名目录打包与独立目录冒烟通过；包内 find.js/grep.js 与经过测试的补丁文件逐字节相同。打包收集器两项回归仍通过，未出现 unresolved duplicate / cannot find path 告警。未验证其他操作系统的原生进程行为。

本轮还阅读了剩余 Electron 窗口/菜单、IPC generation 与 VaultMiddleware、Renderer 启动/Preferences/Vault 路由和打开流程、全局调度、live-provider 与手动 Git 边界探针。未运行需要用户真实模型凭据的探针。下一步是补齐最终跨模块审查与验证记录。

交叉复核发现的待清理项：`vault-migrations.ts` 仍在新建 Vault 时创建旧 messages 表、后续 DROP 重建，创建 message_checkpoints 再删除，并重复重建 Git 同步触发器。最终 schema 符合约定，但初始化路径仍混有已放弃的历史兼容步骤和过时注释。根据“不保留旧 Vault 兼容”的明确要求，应直接声明最终 schema，保持当前约束和业务语义，使用 SQLite schema 对比与现有 Store/Git 回归验证。

## 第八轮：最终模型初始化与范围复核

- 已完成上一轮的 schema 清理：合并为 `0001_vault` 新 Vault 基线，直接创建最终 messages、Task Routine 字段、Session 模型及资源选择列；不再创建 checkpoint/旧消息表，不再更新历史消息或重复重建触发器。SQL 从 78 条减少到 50 条。
- 用 Node SQLite 执行改动前后的完整 DDL，比较 10 张业务表的 column/default/PK、CHECK 表达式、外键、索引列/排序/唯一性及 30 个触发器，结果完全一致。没有把旧 DDL 作为兼容实现保留在仓库。新增真实 Layer 回归验证单一基线、最终表集合、消息关闭重开后保留、foreign_key_check 与 integrity_check；Database/Store/Queue/Routine/Git 六文件 65 项通过。
- 删除没有任何调用方、只回传输入数字的 system.count 演示 RPC，从共享 Schema、客户端、handler 和服务一并移除。系统元数据 RPC 及其真实 IPC/Atom 生命周期测试保留。
- 更新后的全仓类型检查、lint、桌面生产构建通过。Integration 全量 77 项通过、2 项显式真实服务测试跳过。最终 Desktop 全量 62 文件 / 383 项通过。

最终契约复核：

| 约定 | 当前实现与证据 |
|---|---|
| messages 使用 UUID v7、Session 内 seq、完成写入，工具也是 message | HarnessEventStore 的 uuidv7/newRow/persist；流式与取消/归档重放测试；最终 messages schema |
| 删除 checkpoint 和任务资源快照 | 生产源码无旧表引用；TaskResources 返回当前安装路径；升级、凭据刷新与失败测试 |
| Routine 执行归属 Task，Run 是唯一执行记录 | tasks 的冻结窗口/模型/时区；runs 的队列与状态约束；Routine/Queue/Runtime 回归 |
| 临时状态文件与 JSONL，按 Vault 隔离 | RunFileStore 原子 state.json、诊断日志缓冲/限额/保留；损坏、身份、清理、多个 Vault 测试 |
| 崩溃不重放副作用，未确认退出不释放占位 | recovery 的进程/组/归档租约核查，文件与数据库并集；Worker/Native/删除 Vault 回归 |
| Git 保存和同步保持可恢复的持久边界 | Git preparation/application/sync 约束与确定性 commit，事务/冲突/字面路径回归 |
| 资源升级使用当前版本，授权可恢复 | Integration prepare 全选项验证，Lark 锁内发布，Gmail 现有授权重试；77 项离线回归 |
| 产物可脱离仓库加载 | pnpm 依赖收集补丁、别名回归、未签名 macOS 目录包、迁出仓库的 SDK/Worker 冒烟 |

没有为审查而引入新的通用状态层。Git 持久回执表承担跨 SQLite/Git 边界的恢复与幂等职责，不能按临时 execution 状态一并删除；共享 UI 包主要封装 Base UI 样式，保持现状；model Profile 服务仍被配置和 Session 使用，没有按旧表单的删除范围误删领域模型。
