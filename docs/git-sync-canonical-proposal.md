# Git 同步：统一冲突结果的候选方案

状态：2026-09-10 用户已确认采用。本文取代原双向分别解冲突的候选算法；2026-09-11 已完成手动 `wiki` 保存、stale reprepare、人工 coordinator resolve/abort，以及 terminal receipt 前 Folio-owned Agent 进程回收的生产后端切片；自动保存编排、AI conflict-resolution Run 和完整故障恢复仍未完成。

## 问题与目标

真实 Git 实验复现了双向分别解冲突的反例：main 将同一文件解成“User + Agent”，Task 解成“Agent + User”。两边具有相同 Folio-Change-Id，工作区也干净，但树不同。因此变更 ID 用于身份和收据，不能作为内容收敛证明。

建议只在基于 main 的隔离协调 worktree 中解决一次冲突。发布结果后，以保留原历史、可查看 diff 的普通提交对齐 Task。禁止 reset 和直接覆盖工作文件；未提交内容必须保留。

## 冻结输入与准备

每次操作先持久化 operationId、Vault/Task 身份、main 基线 SHA、Task 已接纳 frontier、冻结的 Task HEAD，以及 frontier 到 HEAD 的完整提交列表。frontier 必须是已登记的接纳位置，且为 HEAD 的祖先；不能凭 patch 等价猜测它。

必须核对整个提交区间，每个提交均有来源登记。不能由调用者只传入最后一个提交并跳过此前修改。合并提交、外部未登记提交和不一致的账本暂不自动处理。

在 main 基线创建隔离协调 worktree，依次 cherry-pick 已登记的源提交。wiki 冲突交给归属原 Task 的独立 conflict-resolution Run；该 Run 不与普通 Run 并发。Agent 编辑结果，Folio 验证并完成 Git 操作。raws 只能无损去重或保留双方，不能交给 AI 改写原始数据。

准备期间 main 不进入冲突状态。取得 Vault 发布锁后重新核对 main HEAD、工作区和操作登记，再以 fast-forward 发布。main 已前进则重新准备，不能把旧结果强行写回。

## 对齐 Task

只有冻结 HEAD 之前的全部源修改都已被 canonical main 接纳，才允许构造对齐提交：

- parent 为冻结的 Task HEAD，tree 为本次已发布的 canonical main tree。
- 提交记录 Folio-Sync-Operation 和 Folio-Canonical-Commit，用户可查看相对于原 Task HEAD 的 diff。
- Task 无运行中的 Run/工具，HEAD 未变化，索引和工作区干净，才使用 cherry-pick --ff 应用此直接子提交。
- 若树本来相同，可记录无须新增提交；仍需登记接纳位置和 canonical SHA。
- 对齐后的提交位置成为下一轮源 frontier。对齐提交不能作为 Task 新修改再次导出到 main。

保留原提交历史不等于允许忽略源内容。只有完整源区间均已处理，且冲突解决结果已验证，才能采用 canonical tree；否则整树对齐可能丢掉尚未接纳的新修改。

源分支存在未提交草稿时，读取已提交快照并导出不需要改动源工作区，可以保留草稿；但对齐必须等待草稿处理完。若 Task 新增了提交，旧对齐操作停止，先登记并接纳新提交。main 发布与 Task 对齐分别记录状态，前者成功不代表整个同步完成。

main 在本次发布之后再次前进时，本次 canonical SHA 只是一个已同步检查点；仍需排队同步更新的 main，不能将旧树称为“已追上当前 main”。

## Git 与数据库恢复边界

生产实现需要持久操作日志，至少区分：输入已冻结、协调已准备、main 已发布、Task 已对齐、收据已完成。Git 与 SQLite 无共同事务，每个 Git 写入之前均需保存足够的预期 parent、tree、目标引用与来源信息。

Git 成功但收据丢失时，读取实际历史与操作记录进行验证，不盲目重复 pick。实验只覆盖 main 仍恰好处于预期发布 HEAD，以及 Task 顶部提交的 operation trailer、parent 和 tree 全部匹配的重试。历史又前进、部分更新、对象缺失或账本损坏等情况仍需生产恢复策略。

生产锁需覆盖所有 Folio Git 写入，并与 Run 生命周期互斥。一次 status 检查不能排除检查后发生外部写入；未知后台进程也不能因 Agent idle 就判定安全。外部编辑器缓冲区不属于 Git 可观测范围，这些限制需要独立处理，不能宣称 Git 自带锁已解决。

## 已有证据与未完成项

`packages/agent/tests/integration/git-sync-spike.test.ts` 使用临时真实仓库、main 和多个 worktree；11 项测试已通过。其中新增 5 项覆盖：

1. 单次冲突解决后树一致、保留源历史、重复收据恢复，以及第二轮不反向导出对齐提交。
2. main 基线变化后重新准备，Task 有草稿或 HEAD 前进时拒绝旧对齐。
3. rename/delete 冲突及后续重命名文件编辑。
4. 仅导出已提交文件，未选择的草稿保持原样。
5. raws 冲突拒绝文本改写，main 与双方原始输入保持不变。

测试中的冲突解决是确定性回调，不是实际 AI Run。尚未证明完整 V0 门禁：生产变更账本、操作日志、跨进程锁、所有崩溃检查点、空 cherry-pick、Task 清理重建、raws 无损命名策略、外部写入竞争与真实 AI 冲突验证均未完成。测试辅助函数不能直接作为生产实现复用。

## 生产后端切片进展（2026-09-11）

`TaskGitSynchronization` 与 Vault migration `0015_git_sync_operations` 已将手动 `wiki` 路径落到生产服务：操作先保存完整源区间和 main 基线，再在 `sync-worktrees/{operationId}` 准备确定性 commit；canonical/alignment 对象通过受保护 ref 保留，main 发布和 Task 对齐分别持久化收据。Git 已成功但 prepare/publish/align 收据失败的重试会验证相同对象、HEAD 和 tree，而不是重新读取磁盘或重复应用。

真实 Git/SQLite 测试覆盖连续两轮保存、同文件冲突隔离、dirty/stale/detached main、Task 新草稿、空源同步及其 canonical checkpoint 不可改写、跨重启 pending、prepare/publish/align 收据恢复、canonical/alignment 受保护 ref 不匹配、同一 Task 的新 prepared 操作阻止旧 publication 提前对齐、未登记或非 wiki Task commit、伪造终态行、多个 Task 顺序发布、并发旧 prepare 拒绝、Run/worktree 准入恢复，以及冲突 coordinator 的重启保留。新增人工 resolver 覆盖单次与多次冲突、冲突前后的多 source commit、canonical prefix 跨重启恢复、解决接纳/最终 prepared/abort 三处收据失败、非 wiki 与未暂存编辑拒绝、稳定 RPC 重试和 Task 身份隔离。恢复清理 coordinator 前会重新证明路径、`.git`、shared repository、detached HEAD 和 operation checkpoint；目录被替换时拒绝且不删除。`reprepare` 也要求 Task 与 operation 双身份匹配。`VaultGitWriteLock` 的 SQLite driver 使用 `BEGIN IMMEDIATE`，可串行采用该锁的 Folio 进程；它不锁外部编辑器或 Agent 后台进程。

main 前进后的 `prepared` 操作可通过稳定的新 ID 执行 reprepare：旧记录进入 `superseded` 终态并保留 canonical ref，替代记录显式保存 `supersedes_id`、相同冻结源区间和新 main 基线。状态转换与替代记录插入位于同一 SQLite 事务；插入失败会回滚旧状态，重试不会留下 Run 准入空窗。替代结果仍按正常 prepare/publish/align 流程发布；若 main 再次前进，则分配另一个新 ID 重复该流程。

人工 resolver/abort 已有生产后端与 RPC，但还没有创建、调度并约束实际 conflict-resolution Run；调用方必须先在隔离 coordinator 中生成并完整暂存解决结果。conflict 等待期间 main 若前进，当前 resolver 会保留现场并拒绝接纳；将已暂存解决结果转换为可在新基线重放的 durable 输入仍未实现，不能用自动 abort 丢弃现场代替。旧 Task 在其他 Task 发布后会被执行门禁拒绝，调用显式空源同步后才恢复；Run terminal 前虽已回收 Folio 所有的 Agent 进程，但不会自动触发保存，也不能据此证明逃逸进程或外部编辑器已经停止；raws、Skill 和 UI 不在这个切片中。clean 检查与 fast-forward 之间仍有外部写入竞态，发布逻辑不能声称提供文件系统事务。
