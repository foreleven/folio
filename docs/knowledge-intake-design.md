# 根据 Knowledge goals 规划本轮知识整理

本流程已实现，使用直接 Agent tool 接入 Pi 和 Codex。价值筛选原则见 [ADR 0030](adr/0030-curate-knowledge-against-vault-goals.md)，goal 示例见 [内置知识目标示例](knowledge-goal-examples.md)。

## 执行流程

一次 Raw knowledge intake 先逐份判断 raw 的变化是否命中某个 Knowledge goal，将命中结果写入本轮的一个 todo 列表，再完成这些 todo。

1. 复用现有 Knowledge Task 冻结的 `fromCommit` 和 `toCommit`，通过 Git 确定本轮变化。
2. 逐份阅读 raw 的变化；需要上下文时读取冻结的当前内容及之前的内容。首次处理没有 `fromCommit`，读取完整冻结输入。
3. Agent 通过 `system_one` 工具，针对 raw 内容与 goals 多次调用 System One，判断是否命中目标。
4. Agent 将命中结果收集到本轮 todo 列表，完成筛选后再进入整理阶段。
5. Agent 根据 todo 整理 Wiki，沿用已有的来源引用、校验与发布机制。

本轮允许没有命中或没有 Wiki 变化。Task 的处理边界仍遵循现有规则：已完成的知识处理才推进 checkpoint，保留未完成 Task 的冻结输入。

## Todo 的含义

一条 todo 对应一个待整理的知识主题，记录具体对象、命中的 goals、讨论背景及所有相关冻结消息引用。一个主题可以跨多个 raw，一个 raw 也可以包含多个不相关主题。

筛选记录保留每次 goal 判断；每个命中必须关联到某条主题 Todo 或明确的无需修改理由。Agent 执行时决定新建、更新、合并或无需修改，命中不直接要求生成新 Page，也不机械地产生 raw 数量乘以 goal 数量的 Todo。

### Todo 保存方式

本轮 todo 写入 Task worktree 中的一个本地文件，由 Agent 使用已有文件工具维护。恢复执行先读取该文件，再结合 Wiki 草稿继续。

具体文件路径采用 `<worktree>/_intake-todo.md`。文件使用 Markdown，记录本轮冻结输入、筛选进度，以及每条 todo 的 raw 引用、goal、待整理内容和完成结果；完成结果可以是页面引用或无需修改的原因。筛选进度也记录已判断但未命中的 raw，避免恢复时遗漏或重复处理。

该文件作为 Task 本地工作记录，通过 Git 忽略规则留在 worktree。Wiki 校验、变更保存和发布只纳入 Wiki 页面；todo 文件随该 Task worktree 保留，供中断后继续执行。新工作区的 `.gitignore` 使用精确的 `/_intake-todo.md` 规则。结果校验要求 Todo 文件的冻结 commits 与 Task 一致、`phase: completed` 且没有未勾选项；即使没有 Wiki 变化，未完成的筛选或 Todo 也会交回 Agent 修复。

## Agent 与 System One 的分工

Agent 负责读取 Git 变化、按需补充原文上下文、调用判断工具、收集 todo，以及执行知识整理。System One 负责根据传入的原文和 goals 返回结构化判断，正文由 Agent 编写。

Folio 在创建 Session 时提供工具连接，在 Run prompt 中提供冻结输入、goals 和执行步骤；沿用现有 Wiki 校验与发布流程。

## Goals 配置

Knowledge goals 保存在每个 Vault 已有的 `config.json` 中。新 Vault 默认启用 [Content、Idea、Question 三条内置 goal](knowledge-goal-examples.md)，每条使用稳定的标识和一句话描述。

创建 Knowledge Task 时，将本轮使用的 goals 写入冻结的初始 Run prompt。恢复 Run 复用原始指令中的 goal 快照；Vault 的后续 goal 调整作用于后续新 Task。

System One 的连接配置属于全局 Agent 设置，Knowledge goals 属于 Vault 配置，两者分别保存。

## ObjectTypes

新增 `Content`、`Idea`、`Question` 三个 ObjectTypes，承接对应 Knowledge goal 的整理结果：

| ObjectType | 内容含义 |
| --- | --- |
| `content` | 主题明确、可独立阅读的笔记、文章、研究文档或方案 |
| `idea` | 尚未成型的想法、灵感、假设、观点或方向 |
| `question` | 尚未解决的问题及相关背景和已有线索 |

页面沿用现有通用字段和来源引用约定。命中仍然可以通过更新现有知识或无需修改来完成，不要求每条命中生成新页面。三个类型的内置内容模板见 [知识内容模板](knowledge-content-templates.md)。

在 `ObjectType` 中已增加 `template` 字段，直接保存 Markdown 模板文本，随 `wiki/_types.json` 一起管理。Agent 读取现有类型定义后，按照对应模板组织知识正文；模板服务于内容写作，goal 服务于原文筛选。

### 运行时接入

- Pi 使用现有 `customTools` 和宿主 `toolExecutor`，同时将 `system_one` 加入显式工具名单。
- Codex 在 `thread/start` 的 `dynamicTools` 中注册工具，处理 `item/tool/call` 并回传原生结果；恢复使用原生 Thread 保存的工具定义。
- Desktop 使用现有 Worker 工具桥接，在宿主读取服务配置和凭据。独立 Agent CLI 使用同一调用实现。
- 调用期间继续消费 Codex 事件，Run 取消会中断待处理的 System One 请求。
- `TaskService.reconcileKnowledge` 使用统一的两阶段 prompt；恢复与修复保留原 Run 的冻结输入和 goals。

### 工具契约

向 Agent 提供一个 `system_one` 工具，首版用于判断原文是否命中 Knowledge goals：

- 输入：raw 的冻结来源引用、待判断的变化及必要的原文上下文、候选 goals 的标识和一句话描述。
- 输出：各 goal 的独立判断结果，以及 provider 实际提供的概率信息。同一 raw 可以命中多个 goal。
- Agent 决定何时读取更多上下文和再次调用；不同 raw 或新的原文上下文可以形成新的判断请求。
- 工具仅执行判断，不编辑 Wiki、不创建 Task、不完成 todo。
- 服务地址、模型和认证由 Folio 的工具配置提供，不写入 Agent prompt。

Provider 返回的概率不能直接表述为判断的准确率；调用失败也不能表示未命中。

### System One 配置

System One 使用用户本地部署的服务，在全局 Agent 设置中增加独立的 System One 配置区，提供三个输入：

| 输入 | 含义 |
| --- | --- |
| `baseUrl` | 本地部署服务的 API 基地址 |
| `apiKey` | 调用服务所用的 API key |
| `model` | 服务中用于结构化判断的模型名称 |

这份配置供 Agent 调用的 System One 工具使用，适用于 Pi 和 Codex；与 Agent 的生成模型选择分别配置。

配置保存沿用项目已有模式：`baseUrl` 和 `model` 保存在全局 Agent 配置中，API key 通过独立的凭据写入请求保存在现有凭据存储中。设置读取只返回是否已配置凭据，密钥不进入配置订阅、Agent prompt 或会话日志。

本地部署需要支持 `http://` 和 `https://` 的服务地址；现有生成模型 CustomProvider 只允许 HTTPS，System One 的 URL 校验不能直接复用这一限制。

用户已确认，本地部署完全兼容 TypeSafe System One 原生协议：请求使用 `POST /v1/systemone`，认证使用 `Authorization: Bearer <apiKey>`，请求中的 `model` 使用 Agent 设置中的模型名称。实现直接遵循原生请求和响应结构。

针对同一份 raw 上下文，多个 goals 分别作为独立的命中判断；结果可以同时命中多个 goal。System One 不负责生成整理正文，也不需要在判断响应中生成解释文本。

### 命中规则

首版每个 goal 独立判断：命中概率 `>= 0.7` 时加入本轮 todo，低于 `0.7` 时跳过。该数值作为初始试运行规则，后续根据实际整理效果调整。

上下文不足时，Agent 可以补读必要原文后再次判断；同一输入不通过反复调用来追求命中。没有命中和调用失败分别处理，后者不能作为成功跳过该 raw 的依据。

## 输入 prompt 与内容质量

实际指令维护在 [knowledge-intake-prompt.ts](../apps/desktop/src/main/services/tasks/knowledge-intake-prompt.ts)，初始 Run 冻结该指令及输入，恢复仍沿用原指令。

1. 通过 Git 文件状态区分新增与修改；`numstat` 只有新增行不能证明文件为新增。首次读取完整冻结输入，后续以变更为重点补读必要背景。
2. 以完整讨论理解材料：明确对象、发言人、讨论起因、提议、补充、纠正和结论。保留转发消息的原始时间；不同客户或项目的约束分别归属。
3. 以原文及相关上下文调用 System One，将命中整理成主题 Todo，保持所有筛选记录可追踪。
4. 围绕稳定主题写作；正文应能独立理解，保留有用的代码、参数、请求结构和示例，凭证使用占位符。优先更新已有知识，并链接实际相关的页面。
5. Content 保留可复用知识；Idea 保留原文实际提出的观点并注明归属；Question 需要明确提出或有充分的未解决依据，检查后续回复。空字段或材料没有说明某事，不能推导为事情未确定，也不能自动生成问题。省略没有依据的模板栏目。
6. 结果完成前，Agent 对照来源复核对象、归属、后续纠正、事实依据、细节完整性、可独立阅读性和重复内容；将发现及修正写入进度文件。

Todo 文件使用 `fromCommit`、`toCommit`、`phase: screening | processing | completed` 的 YAML frontmatter。待办使用 `- [ ]`，已完成项使用 `- [x]` 并记录页面链接或无需修改原因。只有全部筛选和 Todo 完成后才能声明 completed。

消息来源标签包含群名、来源时间与时区、发言人和证据主题。依赖多条消息的结论同时引用提议、补充和纠正；邮件标签包含主题、日期和可用的发件人信息。新引用仍固定到本轮 `toCommit`，保留消息 ID；消息级定位与完整讨论理解分别由预览和正文承担。

### 来源展示

来源预览解析现有 Lark IM raw 格式，显示群名、时区、发言人、消息时间和正文，并高亮精确匹配的消息。默认展示其前后各两条消息，可向两侧逐步展开，并查看完整原文。相邻消息只是阅读入口，不自动等同于同一讨论线程。

无法定位、重复的消息 ID、未识别的格式或解析失败时保留完整原文，不把内容中的 ID 字符串误当成引用锚点。已删除的 raw 同样可在冻结的删除前版本中查看消息上下文。邮件继续显示完整原文。

人工内容验收样例见 [知识质量修复样例](knowledge-quality-examples.md)。这些规则指导 Agent 的判断；现有机械校验检查格式、引用边界和完成标记，并不能证明语义质量。

## 实现范围

采用直接 Agent tool，统一名称为 `system_one`。Pi 通过已有 `customTools` 注册；Codex 通过 app-server 的 `dynamicTools` 注册，并实现 `item/tool/call` 请求回传。本地 `codex-cli 0.156.1` 导出的协议 schema 已确认存在 `ThreadStartParams.dynamicTools`、`DynamicToolCallParams` 和 `DynamicToolCallResponse`。

工具首版统一输入：

```json
{
  "rawRef": "folio-raw:<toCommit>/raws/<path>",
  "context": "原文变化，以及判断所需的原文上下文",
  "goals": [
    { "id": "idea", "description": "一句话 Knowledge goal" }
  ]
}
```

统一输出：

```json
{
  "rawRef": "folio-raw:<toCommit>/raws/<path>",
  "model": "local-jev",
  "results": [
    { "goalId": "idea", "probability": 0.85, "matched": true }
  ]
}
```

适配器将各 goal 转成 System One 原生独立判断，依据已确认的 `>= 0.7` 规则返回 `matched`。服务连接和模型来自全局 Agent 配置；Agent 的工具参数只提供原文上下文和 goals。

命中按知识主题合并为 Todo，记录涉及的 goals、对象和多个消息来源；由 Agent 结合原文与已有 Wiki 草稿组织内容，并逐条记录完成结果。沿用当前 Task、Run、会话恢复和 Wiki 发布机制。

已实现：

1. Agent 设置中的 System One 表单、非密钥配置读写和现有凭据存储接入。
2. System One 原生 API 调用与 Pi/Codex 工具注册、结果及错误回传。沿用 Run 取消，调用错误保留可排查的阶段信息，避免记录密钥和原文正文。
3. Vault goals 默认初始化和读取，以及新 Task/恢复 Run 的两阶段 prompt。
4. 三个新增 ObjectTypes、`template` 字段和内置正文模板。
5. worktree todo 文件及其精确 Git 忽略规则，确保只更新 todo 或无 Wiki 变化时仍能正常完成。

自动化验证覆盖本地 HTTP 的原生协议结构、Pi/Codex 工具调用、取消与错误回传、阈值边界、密钥不回传、冻结 goals 的恢复，以及 Todo 文件与无 Wiki 变化的完成路径。

重启应用后，在全局 Agent Settings → System One 填写服务地址、API key 和模型。新建 Vault 会初始化 goals 和内容模板。本次按重建 Vault 的约定实现，不包含旧配置或旧 ObjectTypes 的兼容迁移。用户部署的实际推理效果需要在配置后试运行验证。
