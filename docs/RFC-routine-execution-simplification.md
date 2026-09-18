> 2026-09-18 实现更新：业务窗口已合并到 `tasks`，不再创建 `routine_executions`。
> Routine ID、日期、触发次数、时间窗口和配置版本保存在 Task 上；执行状态及起止时间从最新的非冲突解决 Run 推导。
> Task 完成状态仍独立，执行成功后需完成 Git 收尾。下文的独立执行表与状态同步方案属于历史设计。
> 新 Vault 直接使用新结构，不迁移历史数据。

# Routine 执行模型简化方案

## 1. 背景与目标

当前 Routine 使用 `routine_wakeups`、`routine_triggers`、`routine_executions`、`routine_schedules` 多层账本，分别表达计划游标、触发事件、接受批次和首次派发意图。这个模型把一次 Routine 执行拆成多个中间对象，也把 Task、Session、Run 的所有权关系变得不清晰。

本方案将 Routine 简化为：

- Routine 保存可编辑配置和频率；
- `routine_executions` 保存每一次要处理的业务窗口；
- 每条 `routine_execution` 直接关联一个 Task；
- Session 和 Run 继续由 Task 拥有，不出现在 Routine 的领域关系中；
- 同一 Routine 同时最多有一条尚未开始的 pending execution；
- 后续触发优先合并更新这条 pending execution，不创建排队记录；
- gap 不落表，通过执行日历从成功的日终 execution 派生。

本轮不做旧 Routine 数据兼容迁移；应用会在 Vault migration 中删除旧的五张 Routine 表并创建新结构。旧执行历史如需保留，应在升级前导出。

Routine 只负责处理当前业务日，不自动补跑任意多天以前的历史数据。错过的中间日期由用户从执行日历中手动处理。

## 2. 业务语义

### 2.1 业务日期

`routine_date` 是本次处理的数据所属日期，按 Routine 自己的 `time_zone` 计算，不使用机器本地时区。

例如 Routine 每 30 分钟处理当天消息：

```text
2026-09-11 10:00  routine_date=2026-09-11, is_end=false
2026-09-11 10:30  routine_date=2026-09-11, is_end=false
2026-09-11 23:30  routine_date=2026-09-11, is_end=false
2026-09-12 00:05  routine_date=2026-09-11, is_end=true
```

第二天第一次执行是前一天的日终收尾，负责把前一天处理到 `23:59:59`。成功的 `is_end=true` execution 才能证明这一天已经完整处理。

### 2.2 频率

Routine 只配置一个间隔，例如 30 分钟或 60 分钟。应用重启或长时间离线后：

- 不按错过的间隔创建多条 execution；
- 恢复时最多创建/恢复当前需要的一条 execution；
- 前一天的日终收尾优先于新一天的普通窗口；
- 更早日期不自动补跑，显示为待用户处理的 gap。

### 2.3 pending 合并

`pending` 表示还没有为该 execution 保留/启动 Run，仍然可以修改其处理范围。

后续触发的合并规则：

1. 同一 `routine_date` 的普通触发：更新原行的 `trigger_time` 和 `window_end`，并增加 `trigger_count`；
2. 下一自然日第一次触发：如果前一天存在 `pending` 的普通 execution，将该行更新为 `is_end=true`，其 `trigger_time/window_end` 设置为前一天本地时间的 `23:59:59`；
3. 已经是 `is_end=true` 的 pending execution：不再扩展到新日期，先完成该日终 execution；
4. 已进入 `preparing`、`running` 或成功终态的 execution 不再合并；失败/中断/取消的 execution 重新置为 `pending` 并复用原行；
5. 如果旧 pending execution 长时间无法执行，不创建第二条排队记录，转为需要用户处理的异常状态。

合并必须保留审计信息：至少保存 `first_trigger_time`、最新 `trigger_time` 和 `trigger_count`。只覆盖一个 `trigger_time` 会丢失中间触发事实。

## 3. 数据模型

### 3.1 `routines`

Routine 的核心配置不再全部放在 `definition` JSON 中：

```sql
CREATE TABLE routines (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  agent              TEXT NOT NULL CHECK (agent IN ('pi', 'codex')),
  model_provider_id  TEXT,
  model_id           TEXT,
  thinking_level     TEXT,
  skill_ids          TEXT NOT NULL DEFAULT '[]',
  integration_ids    TEXT NOT NULL DEFAULT '[]',
  interval_minutes   INTEGER NOT NULL CHECK (interval_minutes > 0),
  time_zone          TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision           INTEGER NOT NULL CHECK (revision > 0),
  next_trigger_at    INTEGER,
  last_trigger_at    INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

`next_trigger_at` 是调度游标，不是执行历史。Routine 编辑使用 `revision` 做 compare-and-swap。

Skill 和 Integration 当前以 JSON 数组列保存；后续若需要独立权限/审计，再拆关联表。

### 3.2 `routine_executions`

一行代表一次 Routine 需要处理的逻辑窗口，并直接拥有一个 Task：

```sql
CREATE TABLE routine_executions (
  id                 TEXT PRIMARY KEY NOT NULL,
  routine_id         TEXT NOT NULL REFERENCES routines(id),
  task_id            TEXT REFERENCES tasks(id),
  routine_date       TEXT NOT NULL,
  trigger_time       INTEGER NOT NULL,
  first_trigger_time INTEGER NOT NULL,
  trigger_count      INTEGER NOT NULL DEFAULT 1 CHECK (trigger_count > 0),
  is_end             INTEGER NOT NULL DEFAULT 0 CHECK (is_end IN (0, 1)),
  window_start       INTEGER,
  window_end         INTEGER,
  routine_revision   INTEGER NOT NULL CHECK (routine_revision > 0),
  status             TEXT NOT NULL CHECK (status IN (
    'pending', 'preparing', 'running',
    'succeeded', 'failed', 'cancelled', 'interrupted'
  )),
  started_at         INTEGER,
  ended_at           INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

这里不保存 `session_id`。一个 Task 可以拥有多个 Session 和多个 Run，Routine 不应该绑定某一个 Session。需要查看执行细节时，通过：

```text
routine_executions.task_id → tasks.id → sessions / runs
```

调度事务先持久化 execution reservation；创建 Task 成功后立即回填 `task_id`。因此短暂允许 `task_id IS NULL`，但 `pending` 之外的状态必须有 Task。worktree 创建失败不删除 execution，而是保留原身份供重试。

建议约束：

```sql
CREATE UNIQUE INDEX routine_one_pending_execution
ON routine_executions(routine_id)
WHERE status = 'pending';

CREATE UNIQUE INDEX routine_one_end_execution
ON routine_executions(routine_id, routine_date)
WHERE is_end = 1;

CREATE INDEX routine_executions_by_date
ON routine_executions(routine_id, routine_date, trigger_time);
```

第一条约束保证不会形成排队链；第二条约束保证一个业务日只有一个日终 execution。

失败后的重试复用同一 execution 行（并将状态重新置为 `pending`），再使用现有 Run 的 recovery 机制；不能通过重复插入 Routine execution 来表示重试。

## 4. 触发与合并事务

调度器每次触发都调用一个事务性的 `scheduleOrMerge(routineId, now)`：

```text
BEGIN IMMEDIATE

读取 Routine 和当前业务日期
读取该 Routine 最早的 pending execution；若没有，则读取可重试的 failed/interrupted/cancelled execution

如果存在 pending execution：
  如果仍是同一业务日且不是日终：
    更新 trigger_time/window_end/trigger_count
  如果是下一自然日的第一次触发，且旧行不是日终：
    更新 is_end=true
    trigger_time/window_end = 前一天 23:59:59
  如果旧行已经是日终：
    不创建新行，等待旧日终完成
  如果旧行日期早于前一天：
    仍更新同一行的最新 trigger_time/trigger_count，不生成追赶队列；这些日期由日历标为 gap
否则：
  创建一个新的 routine_execution 和对应 Task

更新 routines.next_trigger_at

COMMIT
```

更新 pending execution 与推进 `next_trigger_at` 必须在同一个事务中完成。两个 scheduler 进程同时触发时，唯一索引和写事务负责保证只有一个 pending 行，另一个调用读取并合并到同一行。

`trigger_time` 建议表示逻辑处理截止时间；实际执行时间另存 `started_at/ended_at`。如果需要保留调度器收到事件的时间，再增加 `received_at`，不要复用 `trigger_time`。

## 5. 日终和 gap 计算

### 5.1 日终处理

每天第一次触发时，先检查前一天：

- 有同日 pending 普通 execution：直接将它升级为 `is_end=true`；
- 没有 pending，但前一天没有成功的日终 execution：创建一个前一天的日终 execution；
- 前一天已经有成功的日终 execution：直接创建今天的普通 execution。

如果应用离线多天，只自动处理最近一天的日终；更早日期不自动创建历史 Task。

### 5.2 Gap 派生

不建立 `gaps` 表。执行日历按以下规则计算：

```text
day_completed(D) =
  存在 routine_date = D
  且 is_end = true
  且 status = succeeded

gap(D) =
  D 早于今天
  且 Routine 在 D 本应启用
  且 day_completed(D) 不成立
```

`pending` 的前一天日终可以显示为“待收尾”，失败/中断的日终显示为 gap。今天不能提前判定为 gap。

如果暂停日期不应被判定为 gap，需要保存启用/暂停历史；只保存当前 `enabled` 无法正确解释过去的暂停区间。可以增加：

```sql
CREATE TABLE routine_status_changes (
  id         TEXT PRIMARY KEY NOT NULL,
  routine_id TEXT NOT NULL REFERENCES routines(id),
  status     TEXT NOT NULL CHECK (status IN ('enabled', 'paused')),
  changed_at INTEGER NOT NULL
);
```

## 6. Task、Session、Run 边界

Routine 创建的是 Task，不是 Session：

```text
Routine
  └── routine_execution
        └── Task
              ├── Session
              └── Run
```

- `routine_execution` 冻结 Routine revision 和数据处理窗口；
- Task 保存实际执行配置快照；
- Session 只表示 Agent 会话上下文；
- Run 表示一次 Prompt 执行；
- Routine 的完成判断依赖 `routine_execution.is_end=true` 对应的成功结果，而不是某一个 Session 是否结束。

## 7. 当前五张表的处理

在新模型中：

- `routine_wakeups`：删除，触发合并直接更新 pending execution；
- `routine_triggers`：删除，execution 自己持有 Routine revision、Task 和窗口；
- 当前 `routine_executions`：删除并按本方案重建，不能继续使用只保存 `session_id/run_id` 的 intent 结构；
- `routine_schedules`：删除，频率和 `next_trigger_at` 放进 `routines`；
- `gaps`：不创建，通过执行日历计算；
- `routine_status_changes`：仅在需要准确排除历史暂停日期时增加。

最终核心结构为：

```text
routines
routine_executions
routine_status_changes (可选)
tasks
sessions
runs
```

## 8. 验收标准

1. 同一 Routine 在任意时刻最多只有一条 `pending` execution；
2. 同一日期的第二次、第三次触发更新原 pending 行，不产生新排队行；
3. 第二天第一次触发会把前一天 pending 普通 execution 升级为日终 execution；
4. 同一 `routine_id + routine_date` 最多一个 `is_end=true` execution；
5. scheduler 并发触发不会产生重复 Task；
6. Routine execution 可以直接查询到 Task，不能通过 Session 反向猜测 Task；
7. 前一天只有在成功日终 execution 后才被执行日历标记为完成；
8. 离线多天不会自动创建多天历史 Task；
9. Routine 编辑不会改变已经创建的 execution/task 配置快照；
10. 失败或中断的 execution 保留原身份，可重试或由用户手动处理，不生成无限 pending 队列。

## 9. 待确认事项

1. `trigger_time` 是逻辑截止时间，还是调度器收到触发的实际时间；建议采用逻辑截止时间，并另存 `received_at`。
2. 日终执行失败后是否自动重试，还是立即在执行日历中要求用户处理。
3. Routine 暂停期间是否完全不计入 gap；如果是，需要启用/暂停历史。
4. Skill/Integration 是否在本轮一并规范化为关联表。
5. 旧五表数据是否需要迁移；旧 trigger 没有可靠的 `routine_date` 时，不能静默猜测日期。

## 10. 实现与验证记录

- 主进程、共享 RPC、RoutineStore、调度器和 renderer 已按本方案切换；旧的 schedule store、wakeup/trigger API 和对应 UI 已删除。
- `RoutineStore` 测试覆盖：同日触发合并、次日 `23:59:59` 日终升级、跨多日不形成排队队列。
- Desktop Node typecheck、Routine 相关 ESLint 和 `git diff --check` 已通过。
- 全量 Vitest 中仍有若干既有 ACP/UI 基线测试失败，失败点不涉及 RoutineStore 新测试；这些测试不应作为本方案的验收依据。
