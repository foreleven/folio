# RFC: Folio Agent 能力与 Pi Coding Agent ACP Server

- **Status:** Draft
- **Authors:** Folio
- **Date:** 2026-09-10
- **Scope:** Models Settings、`packages/agent`、Pi Coding Agent、ACP Server
- **Related:** [`RFC-sandboxed-node-runtime.md`](./RFC-sandboxed-node-runtime.md)

## Summary

> 后续设计：2026-09-10 的 [Harness 执行与存储 RFC](./RFC-agent-harness-execution-storage.md) 定义了 Folio 自有 Routine / Task / Session / Run、每 Session 独立进程、每 Task worktree、ACP 事件持久化和自动 Git 同步。与本文的运行位置、任务范围及首期权限策略冲突时，以新 RFC 已确认决策为准；本文的模型配置和 ACP 协议细节仍是参考，尚未实现的内容不因此视为完成。

本 RFC 规划 Folio 第一轮编码 Agent 能力：

1. 完善 Pi 模型配置，并通过现有 Settings > Agent > Models 页面管理模型、认证状态和默认模型。
2. 新增 Electron 无关的 `packages/agent` workspace，嵌入最新版 Pi Coding Agent SDK，并对外提供 ACP v2 Server。
3. 建立模型配置、凭据、ACP Session、Pi Session、工具权限和进程退出之间的明确边界。

首期采用 Folio 自己的 ACP 适配层，不直接依赖第三方 `pi-acp` 包。ACP Server 使用 ACP v2 + stdio；每个 ACP Session 对应独立 Pi Session；模型目录可以共享，会话状态、取消信号和工具权限必须隔离。

当前 Models 页面已经存在导航入口，但 `ModelsSettings.tsx` 仅是空占位；现有 `ConfigService` 已具备 Schema 校验、写入串行化、原子替换和跨窗口广播。因此本轮应扩展既有配置链路，而不是新增一套 renderer Settings 存储。

## Goals

1. 用户可在 Settings 中查看 provider、配置认证、选择模型与 thinking level、测试连接并设置默认模型。
2. API Key、OAuth Token 和敏感 Header 不出现在 renderer 配置快照、日志或 ACP stdout 中。
3. `packages/agent` 提供可由 IDE 或测试进程拉起的 stdio ACP Server。
4. ACP 的初始化、Session、Prompt 流式更新、工具调用、权限请求、取消和关闭能够映射到 Pi。
5. 同一进程中的多个 ACP Session 相互隔离，并在进程退出时统一取消和释放。
6. 首期 API 与目录结构允许后续加入模型切换、Session 恢复、MCP、OAuth 和 Folio 内置 Agent Client，而不推翻当前设计。
7. 代码遵循仓库现有 Effect v4 风格：Schema 建模、Context Service、Layer 装配、Scope/Finalizer 管理资源。

## Non-goals

- 在本轮实现完整 Agent 对话 UI。
- 将 ACP 暴露为 HTTP、WebSocket 或远程服务。
- 同时维护 ACP v1 兼容层；本轮只实现用户指定的 ACP v2。
- 默认加载用户 `~/.pi/agent` 下的配置、凭据或扩展。
- 在首个 PR 中支持所有 Pi provider、OAuth 流程和任意自定义 Header。
- 在没有工作区边界与权限策略时启用不受约束的 shell。
- 让 renderer 直接调用 Pi SDK 或读取凭据文件。
- 重新实现 Pi 的模型协议、Agent Loop、上下文压缩或 Session 格式。

## Current state

### Settings and config

- Settings 已包含 `models` 页面和 Agent 分组。
- `ModelsSettings.tsx` 尚未读取或写入模型数据。
- 全局配置位于 `~/.folio/config.json`，目录可由 `FOLIO_CONFIG_DIR` 覆盖。
- `ConfigService` 是当前配置真源，负责读取、Schema 校验、写锁、原子替换和 `config.watch` 广播。
- `config.update` 目前只允许更新 `theme` 和 `language`。
- `config.watch` 会把完整 `GlobalConfig` 发送给 renderer，因此不得把凭据加入 `GlobalConfig`。

### Pi Coding Agent

Pi SDK 提供 `createAgentSession`、`ModelRuntime`、`SessionManager`、事件订阅、取消以及工具/扩展机制；SDK 文档明确将嵌入同一个 Node.js 进程作为类型安全、可直接访问 Agent 状态的首选路径。[Pi SDK documentation](https://github.com/badlogic/pi-mono/blob/master/packages/coding-agent/docs/sdk.md)

Pi 的 `tool_call` 扩展事件可以在工具执行前阻断调用，`tool_execution_*` 和 `message_update` 可用于流式桥接，适合实现 ACP permission 和 update 映射。[Pi extensions documentation](https://github.com/badlogic/pi-mono/blob/master/packages/coding-agent/docs/extensions.md)

截至 2026-09-10，npm `latest` 指向 `@earendil-works/pi-coding-agent@0.85.1`。本轮基线直接采用该最新版本；实现开始时仍需重新解析 `latest` 并更新 lockfile，避免把 RFC 查询时点误当成长期固定版本。

### ACP

本轮明确采用 ACP v2。当前 `@agentclientprotocol/sdk@1.4.0` 通过 `./experimental/v2` 暴露 v2 API；v2 已提供稳定 baseline schema，但协议整体仍处于 Draft，因此实现必须用 contract tests 和 feature flag 承担其变更成本，不再回退到 v1 作为主实现。[ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) [ACP v2 migration](https://agentclientprotocol.com/protocol/v2/migration)

ACP v2 的 `session/prompt` 响应只表示消息已被接受，前台运行状态与完成原因通过 `session/update` 的 `state_update` 上报；消息必须携带 agent-owned `messageId`，工具调用通过 `tool_call_update` upsert。取消完成由 `idle + stopReason: cancelled` 确认。[ACP v2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)

## Decisions

### D1. 直接嵌入 Pi SDK，不桥接 Pi RPC 子进程

`packages/agent` 直接依赖 Pi Coding Agent SDK，并使用 `createAgentSession` / `ModelRuntime` 构建 Session。

选择 SDK 的理由：

- ACP 与 Pi 事件可以在同一个进程内映射，保留完整类型信息。
- 取消可以直接调用 `session.abort()`，不需要再维护一层 Pi JSONL 请求状态。
- 权限扩展可以在 `tool_call` 执行前阻断。
- 测试可以注入 fake Pi adapter，而不必启动两个嵌套子进程。

Pi RPC 模式保留为未来进程隔离选项，不作为首期内核。

### D2. ACP 使用 v2 Draft baseline，首期只提供 stdio

依赖当前最新版 `@agentclientprotocol/sdk@1.4.0` 的 `./experimental/v2` 入口，初始化协商固定请求 `protocolVersion: 2`。Folio 本轮不实现 v1 handler，也不在协商失败时静默降级；不支持 v2 的 Client 应收到明确的不兼容错误。

只使用 ACP v2 stable baseline schema，不采用 `schema.unstable.json` 中的额外草案能力，除非后续 RFC 明确批准。v2 整体 Draft 状态通过以下约束消化：

- Agent 实现置于 `agent.enabled` feature flag 后；
- ACP SDK 精确版本进入 lockfile，不使用运行时浮动版本；
- v2 wire fixtures 和 contract tests 作为升级门禁；
- adapter 内部领域事件与 ACP v2 wire types 分离，协议变化只影响 `acp/v2` 边界；
- SDK 升级时对 v2 schema、生成类型和已支持 Client 做兼容性回归。

`folio-agent` 的 stdin/stdout 只承载 ACP JSON-RPC/NDJSON；诊断日志只能写 stderr。首期不监听端口，不实现远程认证，也不增加 Electron IPC 到 ACP 的私有协议。

### D3. `packages/agent` 是 Electron 无关的独立 workspace

建议包名为 `@folio/agent`，职责包括：

- Agent/Model 领域 Schema 与公开类型；
- Folio 模型配置到 Pi runtime 的编译；
- Pi adapter；
- ACP Server 与协议映射；
- Session Registry；
- 工具权限桥；
- 可执行入口 `folio-agent`；
- fake adapter 与协议测试工具。

该包不能依赖 Electron、renderer、React 或 desktop 内部模块。`apps/desktop` 可以依赖 `@folio/agent/config` 等稳定导出；反向依赖禁止。

### D4. Folio 配置是唯一真源，不默认复用 `~/.pi/agent`

Folio 管理自己的运行目录：

```text
~/.folio/
  config.json                 # 非敏感、可广播的用户配置
  agent/
    auth.json                 # Pi CredentialStore，0600，不进入 renderer
    models.generated.json     # 从 config.json 派生的 Pi 模型文件
    models-store.json         # Pi provider catalog/cache
    sessions/                 # 可选；首期默认按 workspace 管理
```

`FOLIO_CONFIG_DIR` 被覆盖时，上述 `agent/` 目录随之移动，确保 desktop 与独立 ACP Server 指向同一 Folio 配置根。

规则：

- `config.json` 是模型 profile 和默认选择的真源。
- `models.generated.json` 是可重建产物，包含 source checksum；禁止人工编辑后反向覆盖 Folio 配置。
- `auth.json` 是凭据真源，使用 Pi 的 CredentialStore 兼容格式与受限文件权限。
- Desktop Agent 配置启动时优先发现 `~/.pi/agent/auth.json`（不存在时检查 `~/.pi/auth.json`），自动将其中 provider 凭据一次性导入 Folio；已有 Folio 凭据优先，不修改来源文件。导入完成标记防止用户删除后被再次导入。仅导入 provider，不推测默认模型；模型由用户选择。
- 不读取 Pi 的 `models.json` 或 extensions；独立 ACP Server 仍只读取 Folio 配置。
- 环境变量可作为认证来源，但只保存变量名，不保存运行时值。

这样既允许 Settings 修改配置，也允许 IDE 独立启动 `folio-agent` 后读取同一份配置。

### D5. 非敏感配置进入 `GlobalConfig`，敏感操作使用独立 Model RPC

在 `@folio/agent/config` 定义模型 Schema，由 desktop 的 `GlobalConfig` 组合使用。建议的首期外形：

```ts
type AgentSettings = {
  modelProfiles: ReadonlyArray<ModelProfile>
  defaultModelProfileId?: string
}

type ModelProfile = {
  id: string
  name: string
  provider:
    | { type: 'builtin'; providerId: string }
    | {
        type: 'custom'
        providerId: string
        baseUrl: string
        api: SupportedCustomProviderApi
      }
  modelId: string
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  credentialSource: 'managed' | 'environment' | 'none'
  environmentVariable?: string
  customModel?: {
    displayName: string
    reasoning: boolean
    contextWindow: number
    maxTokens: number
  }
}
```

约束：

- profile `id` 稳定，不以数组下标作为身份。
- `defaultModelProfileId` 必须引用现存 profile。
- `baseUrl` 只允许 `https`；本地开发 provider 可在显式开发设置下允许 loopback `http`。
- `environmentVariable` 只存变量名。
- API Key、OAuth Token、Header Value 永不进入该 Schema。
- 未识别字段默认拒绝，迁移必须显式处理。

普通配置仍通过 `config.watch` 同步；但模型的命令式操作增加专门 RPC：

```text
model.watch
model.listCatalog
model.saveProfile
model.deleteProfile
model.setDefault
model.setCredential
model.deleteCredential
model.testConnection
model.refreshCatalog
```

`model.watch` 只返回脱敏 View：profile、`credentialConfigured`、credential source、最后一次测试状态和非敏感诊断。任何响应和错误都不得包含原始 secret。

`config.update` 不直接接受任意模型 patch，避免绕过 profile 引用校验、派生文件刷新和默认模型约束。

### D6. ModelService 归 desktop 主进程，ModelRuntime adapter 归 `@folio/agent`

`apps/desktop` 增加 `ModelService`，负责：

- 将 Settings 的命令式操作串行化；
- 调用 `@folio/agent` 提供的配置 Schema 与 Pi ModelRuntime adapter；
- 持久化非敏感 profile；
- 写入/删除凭据；
- 重建 `models.generated.json`；
- 测试认证与模型可用性；
- 向 renderer 发布脱敏状态。

`@folio/agent` 提供可被 desktop 和 `folio-agent` 共同调用的：

```ts
interface AgentConfigLoader {
  load(): Effect<ResolvedAgentConfig, AgentConfigError>
}

interface PiModelRuntimeFactory {
  create(config: ResolvedAgentConfig): Effect<PiModelRuntime, ModelRuntimeError, Scope.Scope>
}
```

`folio-agent` 启动时重新读取磁盘快照。运行中的 Session 固定使用创建时的 model profile；配置变化只影响新 Session。后续若需要热切换，应通过 ACP session config option 显式实现，不隐式替换正在运行的模型。

### D7. 一个 ACP Session 对应一个 Pi Session

```text
ACP stdio connection
  └─ AcpServer
       ├─ AgentConfigLoader
       ├─ shared Pi ModelRuntime / catalog
       └─ SessionRegistry
            ├─ acp-session-A -> Pi AgentSession A + AbortController A
            └─ acp-session-B -> Pi AgentSession B + AbortController B
```

Session Registry 至少记录：

```ts
type SessionEntry = {
  acpSessionId: string
  cwd: string
  piSession: PiSession
  unsubscribe: () => void
  state: 'idle' | 'prompting' | 'cancelling' | 'closed'
}
```

规则：

- `session/new` 要求绝对 `cwd`，并通过 WorkspacePolicy 校验。
- 每个 Session 独立消息历史、工具事件、取消状态和 finalizer。
- 同一 Session 同时只允许一个 active foreground work；新的并发 prompt 返回协议错误，不隐式排队。
- `session/prompt` 在接受消息并准备处理后立即返回 `{}`；随后发送 `user_message`、`running` 和输出 updates。
- `session/cancel` 调用对应 Pi Session 的 `abort()`；完成清理后发送 `state_update { state: 'idle', stopReason: 'cancelled' }`。
- `session/close` 先取消 active work，再 unsubscribe、dispose 并从 Registry 移除。
- stdin EOF、SIGINT、SIGTERM 或 Layer 释放时，统一 interrupt 所有 Session，并等待 finalizer 完成。

ACP v2 一旦声明 `capabilities.session`，就必须实现 `session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel` 和 `session/update`。因此 M0 必须同时完成最小持久 Session Registry；`session/resume` 首期可以不 replay，但必须恢复 Session，完整历史 replay 使用 `replayFrom: { type: 'start' }`。

### D8. 按 ACP v2 baseline 实现 Session 状态机

首个可用切片实现 v2 Session baseline：

- `initialize`（`protocolVersion: 2`，required `info` 与 `capabilities`）；
- `session/new`；
- `session/list`；
- `session/resume`，包括 `replayFrom: { type: 'start' }`；
- `session/prompt`；
- `session/cancel`；
- `session/close`；
- `session/update`：message upsert/chunk、`state_update`、tool upsert/chunk；
- `session/request_permission`；
- `session/set_config_option`：模型、thinking level 和未来 mode。

事件映射：

| Pi                             | ACP v2                                        |
| ------------------------------ | --------------------------------------------- |
| accepted user prompt           | `user_message` with agent-owned `messageId`   |
| foreground work starts/resumes | `state_update` / `running`                    |
| permission is pending          | `state_update` / `requires_action`            |
| `message_update.text_delta`    | `agent_message_chunk` with stable `messageId` |
| `tool_execution_start`         | first `tool_call_update` / `pending` upsert   |
| permission extension accepts   | `tool_call_update` / `in_progress`            |
| `tool_execution_update`        | `tool_call_content_chunk` or patch update     |
| `tool_execution_end` success   | `tool_call_update` / `completed`              |
| `tool_execution_end` error     | `tool_call_update` / `failed`                 |
| `session.abort()` completion   | `state_update` / `idle` / `cancelled`         |
| normal `agent_end`             | `state_update` / `idle` / `end_turn`          |

`session/prompt` 的 JSON-RPC response 不携带 stop reason，只确认接受。所有 foreground completion 都以 `state_update` 为准。Client 在 `session/cancel` 后仍可能收到尾部 tool/message update，最终以 `idle + cancelled` 作为取消完成边界。

模型、thinking level 和 mode 统一作为 ACP v2 session config options 暴露，分别使用 `model`、`thought_level` 和 `mode` category；变更通过 `session/set_config_option` 与 `config_option_update` 表达，不实现已被 v2 移除的 `session/set_mode`。

第一版 Prompt capability 只声明实际支持并覆盖测试的 content type。建议先支持 text；image 在完成 ACP image 到 Pi `ImageContent` 的尺寸、mime 和错误映射测试后开启。resource、audio 和 embedded content 不做静默丢弃。

以下可选能力只有实现并通过 contract test 后才出现在 `initialize`：

- `session/delete`；
- `session.additionalDirectories`；
- MCP stdio/HTTP；
- image prompt；
- ACP v2 unstable schema 中的任何能力。

### D9. 工具权限由 ACP Client 决策，工作区边界由 Agent 强制

权限确认与 OS 隔离是两层不同防线。

首期工具分级：

| Tier    | 工具                                        | 默认行为                                             |
| ------- | ------------------------------------------- | ---------------------------------------------------- |
| T0 读取 | `read`, `grep`, `find`, `ls`                | 仅 workspace 内，可由策略自动允许                    |
| T1 修改 | `edit`, `write`                             | workspace 内，默认通过 ACP 请求 allow/reject         |
| T2 执行 | `bash` / process                            | 必须用户允许，且必须走 SandboxRunner；未接入时不启用 |
| T3 扩展 | project extensions / arbitrary custom tools | 首期禁用，后续按项目 trust 单独开放                  |

`@folio/agent` 使用 Pi inline extension 拦截 `tool_call`：

1. 将工具名和输入归一化为 `ToolIntent`。
2. 解析目标路径并由 WorkspacePolicy 校验。
3. 发送首个 ACP v2 `tool_call_update`，以 `toolCallId` 创建 pending tool call。
4. 根据策略决定自动允许或调用 `session/request_permission`；等待期间发送 `requires_action`。
5. 拒绝时返回 Pi `{ block: true }`，并将 ACP 状态更新为 failed/cancelled。
6. 允许时先恢复 `running`，再把 tool call 更新为 `in_progress` 并转发执行结果。

必须禁止：

- 通过 `..`、绝对路径或 symlink 逃出 workspace；
- 读取 `~/.folio/agent/auth.json`、Electron profile、SSH/云凭据；
- 把环境 secret 注入 Pi tool 进程；
- 未经 sandbox 的 shell；
- 未经 trust 的 project-local Pi extension。

强隔离和 shell 执行沿用相关 Sandboxed Node Runtime RFC。该能力未完成前，Agent Beta 仍可提供读取和受控编辑，但不能宣称完整命令执行能力。

### D10. MCP 分阶段实现，但 ACP GA 前完成 stdio MCP

ACP `session/new` 可以携带 MCP servers。第一条 vertical slice 允许空列表；收到非空列表时必须显式返回 unsupported，不得假装连接成功。

在 ACP v2 Beta gate 前，`@folio/agent` 增加 stdio MCP bridge：

- 根据 ACP 配置启动 MCP Server；
- 将发现的 MCP tools 适配为 Pi custom tools；
- 将 AbortSignal、超时和进程退出向下传播；
- MCP tool 同样经过 ACP permission policy；
- Session 关闭时释放 MCP connections 和进程；
- HTTP 只有在实现并声明 `capabilities.session.mcp.http` 后允许；v2 已移除旧 SSE transport，不实现兼容层。

## Proposed package layout

```text
packages/agent/
  package.json
  tsconfig.json
  src/
    index.ts
    config/
      schema.ts
      loader.ts
      compiler.ts
    model/
      model-runtime.ts
      pi-model-runtime.ts
      credential-store.ts
    pi/
      adapter.ts
      session.ts
      events.ts
      permission-extension.ts
    acp/
      server.ts
      handlers.ts
      session-registry.ts
      event-mapper.ts
      errors.ts
    policy/
      workspace-policy.ts
      tool-policy.ts
    mcp/
      adapter.ts
      stdio.ts
    cli.ts
  tests/
    acp-contract.test.ts
    event-mapper.test.ts
    session-registry.test.ts
    credential-redaction.test.ts
    workspace-policy.test.ts
```

推荐导出面：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./config": "./dist/config/schema.js",
    "./testing": "./dist/testing/index.js"
  },
  "bin": {
    "folio-agent": "./dist/cli.js"
  }
}
```

不要从包根导出 Pi 或 ACP SDK 的全部类型，避免上游版本变化扩散到 desktop。

## Settings UX

2026-09-10 交互调整：Settings 入口改为「Agent 配置」。顶部小卡片选择 Agent，当前仅内置 Pi 可选并默认选中，Codex 展示后续支持。下方选择已导入或新增的 Provider，直接展示其只读模型目录，无需逐个配置模型。Add provider 弹窗仅包含 Provider 名称选择和 API Key；选中后自动展示相关模型。通过 models.setProviderCredential 独立保存 Provider 凭据，不创建模型 Profile 或默认模型。新增 Provider 与凭据保存到 Folio；本地 Pi 导入失败提供脱敏提示，不阻断手动配置。

`ModelsSettings` 沿用当前 IDE 风格 Settings Shell，建议结构：

```text
Models
├─ Default model
│  ├─ Profile selector
│  ├─ Provider / model summary
│  └─ Thinking level
├─ Model profiles
│  ├─ Profile list
│  ├─ Add / edit / delete
│  └─ status: ready / missing credential / invalid / unavailable
└─ Provider actions
   ├─ Configure credential
   ├─ Test connection
   └─ Refresh catalog
```

交互规则：

- 页面初次加载使用 skeleton；读取失败提供 retry。
- secret input 永不回填；已有凭据只显示“已配置”和来源。
- 保存 profile 与保存凭据是明确动作，不依赖 blur 自动提交。
- “Test connection” 使用当前草稿或已保存配置，并显示阶段：checking auth、refreshing catalog、testing model。
- 测试失败显示脱敏错误类别和修复建议，不显示原始 HTTP Header、Token 或完整 provider response。
- 删除 default profile 前必须选择替代 default，或明确进入“未配置”状态。
- refresh catalog 失败时保留最后缓存，并标注缓存时间/失败状态。
- builtin provider 优先使用 catalog 选择；custom provider 才展示 base URL、API 类型和 model metadata。
- 首期不提供任意 JSON 编辑器，避免把 Pi 内部格式泄漏为稳定产品接口。

## Service and RPC changes

### Shared schema

- 从 `@folio/agent/config` 导入 `AgentSettings`。
- `GlobalConfig` 增加带默认值的 `agent` 字段，保证旧配置可读。
- `GlobalConfigPatch` 仍不暴露模型任意 patch。
- 新增可序列化 `ModelServiceError`，原因采用有限 enum，并确保 `cause` 不含 secret。

### Main process

新增：

```text
apps/desktop/src/main/services/models/model-service.ts
apps/desktop/src/main/rpc/model-rpc.ts
apps/desktop/src/shared/rpc/model-rpc.ts
apps/desktop/src/shared/model.ts
```

`ModelService.layer` 依赖 `ConfigService`、文件系统、Path 和 `@folio/agent` model adapter；并装配到 `MainRpcLive` 与 `MainLive`。

### Renderer

新增：

```text
apps/desktop/src/renderer/src/rpc/model-rpc.ts
apps/desktop/src/renderer/src/settings/models/
```

`ModelsSettings.tsx` 只组合页面状态，不直接处理凭据持久化或 Pi 格式转换。

## Dependency policy

用户指定 Pi 使用最新版本。本 RFC 查询时的基线为：

- `@earendil-works/pi-coding-agent@0.85.1`（npm `latest`）；
- `@agentclientprotocol/sdk@1.4.0`（npm `latest`，使用 `./experimental/v2`）。

实现依赖策略：

1. 开始实现和每次计划升级时重新执行 `npm view <package> version`，Pi 选择当时的 `latest`。
2. `package.json` 记录经过仓库策略允许的版本范围，`package-lock.json` 提交精确解析版本；CI 与发布不得在构建时动态追随 `latest`。
3. Pi 升级不延后到单独的大版本：先在 adapter 分支升级最新版本，跑完 Pi adapter、ACP v2 contract、typecheck 和 build 后合入。
4. ACP 明确使用 v2 baseline；SDK 版本可升级，但不得转用 v1，也不得无审计启用 v2 unstable schema。
5. 检查 Node engine、ESM、native dependency、license、bundle size 和 electron-vite/package 构建兼容性。
6. 只从 `@folio/agent` adapter 内部引用 Pi SDK；desktop 不直接依赖 Pi。

RFC 不将搜索到的第三方 `pi-acp` 适配器作为默认依赖；只有代码审计证明其行为、安全边界和维护成本优于自有薄适配层时，才另提变更。

## Delivery plan

### M0 — Latest Pi and ACP v2 protocol spike

Deliverables:

- 建立 `packages/agent` 最小 workspace；
- 安装实现时 npm `latest` 的 Pi SDK，并提交精确 lock；当前基线是 `@earendil-works/pi-coding-agent@0.85.1`；
- 安装当前 ACP SDK，并使用 v2 baseline 入口；当前基线是 `@agentclientprotocol/sdk@1.4.0`；
- 编译一个 fake-model 的 ACP v2 initialize/new/list/resume/prompt/cancel/close 示例；
- 验证 prompt acceptance、required `messageId`、`state_update`、tool upsert、Pi Session abort、stderr 日志和 stdio JSON-RPC batch；
- 记录 package/engine/license/packaging 结论和 v2 schema checksum。

Exit criteria:

- `npm run typecheck` 和 package build 通过；
- 真实 ACP v2 Client 能拉起 Server 并完成无工具 prompt；
- `session/prompt` 立即确认接收，完成由 `idle + end_turn` 上报；
- list/resume/close 满足 v2 Session baseline；
- 未启用 v1 fallback、v2 unstable schema 或第三方 adapter。

### M1 — Model domain and secure storage

Deliverables:

- AgentSettings / ModelProfile Schema；
- 旧 `config.json` 解码默认值和迁移测试；
- Folio agent directory resolver；
- CredentialStore wrapper、权限校验和 redaction；
- Pi model config compiler；
- ModelService 与 Model RPC；
- builtin catalog、custom provider、test connection 的 service tests。

Exit criteria:

- API Key 不出现在 `GlobalConfig`、RPC view、日志和错误快照；
- desktop 与 standalone server 对同一 `FOLIO_CONFIG_DIR` 解析出一致默认模型；
- 配置文件损坏、凭据缺失、provider 不可达都有稳定错误类型。

### M2 — Models Settings

Deliverables:

- Profile list/editor；
- builtin provider/model picker；
- custom provider 基础表单；
- secret configure/delete；
- default model 与 thinking level；
- test connection、refresh catalog、状态和错误 UI；
- 中英文文案与 renderer tests。

Exit criteria:

- Settings 可以完成“新增 profile → 配置凭据 → 测试 → 设置 default → 重启后仍生效”；
- secret input 不回填，RPC payload 之外不保留 secret；
- 加载、保存、失败、删除 default 等边界路径有测试。

### M3 — ACP/Pi vertical slice

Deliverables:

- ACP v2 initialize/new/list/resume/prompt/cancel/close；
- Session Registry 与最小持久恢复；
- Pi text stream 与 v2 message/tool upsert mapper；
- v2 `running` / `requires_action` / `idle` 状态机；
- model、thinking level 的 session config options；
- graceful shutdown；
- fake Pi contract tests；
- live provider smoke test（本地显式开启，不进入默认 CI）。

Exit criteria:

- ACP v2 Client 可在两个 Session 中并发对话，状态不串线；
- 每条 message update/chunk 都有稳定 `messageId`；
- cancel 最终发送 `idle + cancelled`，而非 generic error；
- resume 可恢复 Session，`replayFrom: start` 可重放完整历史；
- EOF/SIGTERM 后没有残留 Session 或子进程；
- stdout 只有合法 ACP v2 帧。

### M4 — Permissions, workspace boundary and MCP

Deliverables:

- WorkspacePolicy；
- Pi permission extension；
- ACP request_permission；
- T0/T1 tool policy；
- SandboxRunner 接入后开启 T2 shell；
- stdio MCP bridge；
- symlink、路径穿越、拒绝、取消和进程清理测试。

Exit criteria:

- workspace 外文件访问被拒绝；
- edit/write 在执行前可被 Client 拒绝；
- shell 在 sandbox 不可用时保持禁用；
- 非空 stdio MCP 配置可以发现并调用工具；
- MCP/工具进程在 cancel/close/exit 后释放。

### M5 — Beta hardening and compatibility

Deliverables:

- ACP v2 Client compatibility matrix；
- packaged CLI/resource path smoke test；
- Session resume/replay 完整性和长期存储策略；
- ACP v2 Draft schema/SDK 升级演练；
- catalog cache 与离线行为；
- telemetry/log redaction audit；
- 用户文档、troubleshooting 和 rollback 开关。

Exit criteria:

- 至少一个目标 IDE 和 in-memory protocol harness 通过完整场景；
- 配置升级/降级有明确行为；
- 关闭 feature flag 后不影响现有 Settings、Integration 和 Vault 流程。

## Suggested PR sequence

1. **PR 1: package scaffold + dependency spike** — 只建立边界和 contract harness。
2. **PR 2: AgentSettings + ModelService** — 先完成配置和秘密边界。
3. **PR 3: Models Settings UI** — 使用真实 RPC，不使用长期 mock。
4. **PR 4: ACP/Pi text vertical slice** — 无危险工具的端到端闭环。
5. **PR 5: tool events + permissions + workspace policy**。
6. **PR 6: MCP stdio + cancellation/finalizer hardening**。
7. **PR 7: sandboxed shell + Beta compatibility**。

每个 PR 均保持可回滚；在 M4 以前不要默认暴露 shell。

## Test plan

### Unit

- Schema default、migration、excess property 和引用完整性；
- model config compiler 的 deterministic output；
- error redaction；
- Pi event → ACP update mapping；
- Session state transition；
- WorkspacePolicy 的 realpath/symlink/path traversal；
- tool policy allow/reject/cancel。

### Contract

使用内存双向 stream 与 fake Pi adapter 覆盖：

- v2 initialize 的 required `info`、capability object marker 与 `protocolVersion: 2`；
- new/list/resume/close baseline；
- resume 的无 replay 与 `replayFrom: start` 完整 replay；
- prompt 立即 acknowledgment，随后 user message、running、output、idle；
- 所有 message update/chunk 的稳定 `messageId`；
- message/tool 的 omitted、`null`、value、chunk upsert 语义；
- tool pending/in_progress/completed/failed/cancelled；
- permission title/subject、allow/reject/cancel 与 `requires_action`；
- prompt cancel 后尾部 update 与最终 `idle + cancelled`；
- session config options 与 `session/set_config_option`；
- unknown/closed session；
- malformed ACP frame 与 JSON-RPC batch；
- unknown future enum/union 的安全 fallback；
- 两 Session 隔离。

### Desktop

- ModelService fake credential/model runtime tests；
- Model RPC serialization；
- ModelsSettings loading/success/error；
- secret 不回填；
- default profile 删除约束；
- config.watch 不含 credential value。

### Process and packaging

- spawn `folio-agent`，通过 stdin/stdout 完成协议 smoke test；
- 验证 stdout 不含日志；
- SIGINT/SIGTERM/EOF 清理；
- development 与 packaged resource path；
- opt-in live test 验证一个真实 provider，不将凭据写入测试报告。

本轮验证禁止通过长期运行 `npm run dev` 代替测试；优先使用 typecheck、unit/contract test、build 和短生命周期的 CLI smoke test。

## Observability

结构化日志写 stderr，至少包含：

- subsystem；
- ACP connection/session id 的本地短标识；
- provider/model 的非敏感 id；
- lifecycle stage；
- tool kind 与结果状态；
- duration 与错误类型。

禁止记录：

- Prompt 完整正文（默认）；
- API Key、Token、Cookie、Authorization Header；
- credential file 内容；
- 完整 provider response body；
- 用户文件内容和 tool raw output（默认）。

调试模式若需增加内容，必须单独开关，并仍执行 secret redaction。

## Failure and recovery

- **无 default profile：** ACP `session/new` 返回可操作的模型未配置错误；Server 继续运行。
- **凭据缺失：** Settings 显示 missing credential；不自动选择另一个 provider。
- **catalog refresh 失败：** 保留可用缓存，标记 stale；没有缓存则阻止创建该 profile 的 Session。
- **Pi Session 异常：** 只关闭对应 ACP Session，不影响其他 Session。
- **stdout 写入失败/Client 断开：** 取消所有 active turn 并释放 Registry。
- **配置在运行时改变：** 现有 Session 保持快照；新 Session 使用新配置。
- **派生模型文件损坏：** 从 config.json 重建；不反向读取为真源。
- **credential 写入后配置保存失败：** 保留 credential 但标记为 unreferenced；后续清理任务可回收，不在失败路径中冒险删除可能被其他 profile 使用的凭据。

## Rollout and rollback

新增 feature flag：

```text
agent.enabled = false  # 初始默认
```

Rollout：

1. 开发环境只读 ACP text vertical slice；
2. 内部开启 Models Settings 与 T0/T1 工具；
3. 完成 SandboxRunner 后开启 shell；
4. 通过 compatibility matrix 后进入 Beta；
5. Beta 稳定后再评估默认开启。

Rollback：

- 关闭 `agent.enabled` 后不启动 ACP Server，也不暴露 Agent 入口；
- 保留模型配置和凭据文件，避免回滚丢失用户设置；
- Schema 必须允许旧 desktop 版本忽略新增 agent 字段，或在发布前明确最低可回滚版本；
- 不删除或改写用户 `~/.pi/agent`。

## Risks and mitigations

| Risk                              | Mitigation                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Pi latest/API 变化快              | adapter 隔离；升级分支先跑 contract/typecheck/build；lockfile 固定已验证版本      |
| ACP v2 Draft 发生 breaking change | `acp/v2` 边界隔离、schema checksum、wire fixtures、feature flag、目标 Client 回归 |
| 目标 IDE 只支持 ACP v1            | 明确不兼容，不静默降级；Beta 前先锁定至少一个 v2 Client                           |
| secret 经 config.watch 泄漏       | GlobalConfig 只存 credential metadata；Model RPC 脱敏                             |
| stdio 被日志污染                  | stdout protocol-only；日志写 stderr；进程测试                                     |
| 多 Session 状态串线               | Session Registry + per-session Pi Session/AbortController                         |
| shell 逃逸                        | 未接入 SandboxRunner 前禁用；之后仍做 permission + OS sandbox                     |
| project extension 任意执行        | 首期禁用；后续 project trust 后加载                                               |
| Folio/Pi 双配置真源               | Folio config 为真源，Pi models 文件仅为带 checksum 的派生产物                     |
| desktop 与外部 IDE 配置不一致     | 共同解析 FOLIO_CONFIG_DIR 与 Folio agent directory                                |
| SDK 原始错误泄漏响应              | 有限错误 taxonomy、redaction tests、禁止直接序列化 cause                          |

## Acceptance scenarios

### A. Settings 配置 builtin model

1. 用户进入 Models。
2. 创建 builtin provider profile。
3. 输入 API Key，secret input 随提交清空。
4. Test connection 成功并返回模型可用状态。
5. 设置为 default。
6. 重启 Settings 后 profile 与认证状态仍在，但 API Key 不显示。

### B. IDE 通过 ACP v2 使用 default model

1. IDE 以 stdio 启动 `folio-agent`，使用 `protocolVersion: 2` 初始化。
2. 完成 initialize 和 session/new，Server 返回 config options。
3. Server 从 Folio 配置解析 default profile。
4. 用户发送 prompt，Server 立即确认接收，并回放带 `messageId` 的 `user_message`。
5. IDE 依次收到 `running`、流式 agent message 与 `idle + end_turn`。

### C. 编辑权限

1. Pi 请求 edit/write。
2. IDE 收到 `tool_call_update` 和带 title/subject 的 permission request。
3. Session 状态切换为 `requires_action`，用户拒绝。
4. 工具不执行，ACP tool 状态为 failed/cancelled，Pi 获得可理解的拒绝结果。
5. Session 恢复 `running` 或结束为 `idle`，其他 Session 不受影响。

### D. Cancel and shutdown

1. 一个 Session 正在模型请求或工具执行。
2. Client 发送 session/cancel。
3. Pi request、tool 和 MCP 子任务接收 AbortSignal。
4. Client 仍接收取消前已产生的尾部 update，最终收到 `idle + cancelled`。
5. Client 关闭 stdio 后，所有 Session、subscription、MCP 进程和 runtime 被释放。

## Open questions / decision gates

以下问题不阻塞 RFC，但必须在对应里程碑进入前完成决策：

1. **Provider MVP:** 首期是否只支持 builtin provider + OpenAI/Anthropic-compatible custom provider？本 RFC 建议如此。
2. **OAuth:** 是否在第一轮加入 Pi provider login/logout？建议先完成 API Key/环境变量，再单独实现有取消和 callback 生命周期的 OAuth。
3. **Pi import:** 是否提供从 `~/.pi/agent` 一次性导入？建议后续显式导入，不做运行时双向共享。
4. **Session retention:** ACP v2 baseline 必须支持 resume/replay；仍需决定 Session 保留时长、清理策略和跨版本迁移。
5. **Project trust:** 何时允许 project-local Pi skills/prompts/extensions？建议首期只读 AGENTS/context，extensions 默认禁用。
6. **Target clients:** Beta compatibility matrix 首个 ACP v2 IDE 是哪一个？建议在 M0 选定一个目标 Client，并保留 SDK in-memory harness 作为协议真值测试。

## Recommended approval

建议批准本 RFC 的总体方向，并立即启动 M0。Pi 与 ACP 基线已按用户决策确定：实现时使用 Pi npm `latest`（当前为 `@earendil-works/pi-coding-agent@0.85.1`）和 ACP v2 baseline（当前 SDK 为 `@agentclientprotocol/sdk@1.4.0` 的 `./experimental/v2` 入口）。M0 结束后只需要对以下两项做 go/no-go：

1. 首期 provider 范围；
2. 首个目标 ACP v2 Client。

其余架构边界——Folio 配置真源、凭据不进 renderer、`@folio/agent` 独立包、ACP v2 stdio、Pi SDK 嵌入、Session 隔离、权限与 sandbox 分层——可以直接进入实现。

## Implementation Progress

- Active stage: M3
- Overall status: blocked
- Status: blocked
- Last updated: 2026-09-10 09:16
- Current objective: M3 的 opt-in live provider ACP v2 stdio harness 与本地安全门禁已实现并验证；真实 provider 成功验收仍未执行。严格禁止使用用户的 Codex/OpenAI 个人 API Key：harness 会在 credential value lookup 和 provider child spawn 前拒绝 OpenAI/Codex provider、Codex model、OpenAI endpoint 及相关 credential environment source。解除阻塞需要配置并明确允许一个非 OpenAI/Codex 的真实 provider/credential，随后仅运行专用 `test:live-provider` 完成 initialize → session/new → prompt acceptance → user_message/running → 非空 agent message → idle/end_turn → close/EOF；或由用户明确调整该 live Exit criterion。M3 未完成前不得进入 M4。
- Prerequisite check: 本次已重新完整读取 `AGENTS.md`、RFC 1–847、Effect v4 指南 1–396、live harness、stdio tests、runtime composition/config loader 与 package 配置；当前代码和验证证据确认 M0–M2 及 M3 mapper/Session foundation/server wiring/runtime composition/config options 已完成。Pi npm registry latest 与 lock 均为 0.85.1；本机非敏感 Folio 配置元数据显示 agent disabled、无 default profile、profile count 0、无 auth store。未读取 `auth.json` 或任何 credential environment value，未运行真实 provider，未使用 Codex/OpenAI Key。M3 唯一未满足的 Deliverable/Exit criterion 是获准非 OpenAI/Codex provider 的真实网络成功 smoke，因此状态为 blocked。

### Execution log

- 2026-09-10 09:11 — Started M3 live harness safety hardening slice: 用户明确禁止使用 Codex/OpenAI 个人 Key；本次不读取 `auth.json` 或 credential environment value、不运行真实 provider，只在 live harness 的 credential lookup 和 child spawn 之前加入 OpenAI/Codex provider/model/endpoint/environment-source 固定拒绝，并以临时无 secret 配置验证拒绝顺序、无副作用、stdout/stderr 脱敏和默认 CI 不发现。由于没有获准的非 OpenAI/Codex provider 成功调用证据，M3 保持未完成。
- 2026-09-10 09:16 — Blocked M3 after completing live harness safety slice: 新增独立 `scripts/live-provider-smoke.mjs` 与专用 `test:live-provider`，默认 Vitest/CI 不发现且必须显式 opt-in；harness 复用 Folio `config.json`/`agent/auth.json` 真源，要求绝对目录、enabled/default/credential 前置条件，使用生产 `SecureCredentialStore` 校验 managed store，只在内存中收集 credential 哨兵并检查 child stdout/stderr，输出固定脱敏摘要，验证 ACP v2 initialize/new、prompt 即时确认、user_message → running → 非空稳定 messageId agent text → idle/end_turn、session close 与 stdin EOF 自然 0 退出，stdout 每行必须是 JSON。按用户新增边界拆出 `live-provider-policy.mjs` 和无网络 `test:live-provider-policy`：在任何 credential value lookup 或 child spawn 前拒绝 OpenAI/Codex provider、Codex model、OpenAI endpoint、`OPENAI_*`/`CODEX_*` environment source；临时配置回归确认 Codex managed 拒绝不会创建 agent/auth，OpenAI environment 哨兵值不进入 stdout/stderr，CI 固定拒绝。`package.json.files` 纳入三脚本，pack dry-run 89 entries。验证通过：Agent 11 files / 69 tests（保持默认不收集 live harness）；policy check；Codex managed/OpenAI endpoint+environment/CI 成功、失败和无副作用边界；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent/desktop production build；Pi latest/lock 0.85.1；pack；ACP 仅 `experimental/v2`；无 `pi-acp`/v1/unstable；M4 前 tools/MCP/additional roots 仍禁用；`git diff --check`；用户既有 Lark diff 原样保留。未读取或使用 Codex/OpenAI Key，未运行真实 provider。M3 状态设为 blocked：唯一剩余项是获准非 OpenAI/Codex provider 的真实成功 smoke；解除阻塞需配置/授权该 provider，或明确调整 live Exit criterion，M4 不得开始。

- 2026-09-10 08:52 — Started M3 opt-in live provider stdio smoke slice: 已核实 M3 其他 Deliverables 与 Exit criteria 由当前实现和 69/69 Agent tests 支撑；本次仅新增独立、默认测试不可发现的 live harness 和专用 npm opt-in 入口，不改变生产 CLI wire contract、不读取 `~/.pi/agent`、不启用 tools/extensions/MCP/additional roots、不进入 M4。当前环境没有可运行的 Folio default profile/credential；若无法取得真实 provider 成功证据，将保留 M3 未完成并记录明确阻塞。
- 2026-09-10 08:10 — Started M3 session config options slice: 已核实 ACP SDK 1.4.0 stable v2 baseline 的 `SessionConfigOption`、`session/set_config_option`、`config_option_update` 形状，以及 Pi 0.85.1 public `model` / `thinkingLevel` / `getAvailableThinkingLevels` / session-only `setModel(..., { persist: false })` / `setThinkingLevel(..., { persist: false })` API；本次只在 idle Session 上提供 model/thinking mutation，所有选项均来自当前共享 ModelRuntime/config snapshot，不持久化全局设置、不进入 M4。
- 2026-09-10 08:29 — Completed M3 session config options slice: Pi Session 安全边界新增 credential-blind `availableModels` snapshot 与 public model/thinking mutation API；模型 value 使用 provider/model 元组的 base64url 编码，避免跨 provider model ID 冲突且不携带凭据。Session Registry 新增 config snapshot/set API，以既有 foreground `work` 门禁串行 model mutation，prompt/重复 mutation 在 busy 时稳定拒绝，close/shutdown 等待异步切换收尾；所有 Pi auth/provider mutation cause 归一为有限错误，thinking mutation 只接受当前模型支持值并回读 Pi 实际生效值。ACP stable v2 的 `session/new`/`session/resume` 现返回完整 `model` 与 `thought_level` select options，`session/set_config_option` 仅接受 ID value，成功后返回完整 options 并发送 `config_option_update`；不实现 v2 已移除的 set_mode，也不启用 unstable schema。fake/contract Session 与真实 stdio smoke 同步覆盖该边界。新增 5 项测试，覆盖完整 options、thinking/model 成功切换、模型切换后的 thinking clamp、resume 当前值、双 Session 隔离、unknown option/value/type、busy、provider secret-free failure；官方 ACP v2 Client 子进程验证真实 Pi no-tool Session 的 new options、session-only thinking mutation与 close。验证通过：完整 Agent 11 files / 69 tests；focused config/Registry/stdio 3 files / 25 tests；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent 与 desktop production build；pack dry-run 86 entries；构建公共导出 smoke；Pi registry latest/lock 均为 0.85.1；ACP imports 仅 `experimental/v2`；Electron/React、敏感字段、M4 边界与无关 Lark diff 审计通过；`git diff --check`。M3 保持 in_progress：仅剩默认 CI 不执行且不记录凭据的 opt-in live provider stdio smoke；无阻塞。

- 2026-09-10 07:40 — Started M3 real runtime composition slice: 已核实 Pi 0.85.1 公共 `ModelRuntime.create` 接受外部 `CredentialStore`，`setRuntimeApiKey` 使用非持久内存 overlay 且底层请求统一经 runtime auth resolution；本次只接 CLI 默认 profile 的真实共享 runtime/session factory，并确保派生文件无凭据、环境 secret 不写入 `auth.json`，保持 M4 前 tools/extensions/MCP/additional roots 全禁用。
- 2026-09-10 07:54 — Completed M3 real runtime composition slice: 新增独立 `runtime/composition` 边界，从 standalone `FolioAgentConfigSnapshot` 原子重建 0600 credential-blind `models.generated.json`，以 0700 Folio agentDir、`SecureCredentialStore`、锁定 Pi 0.85.1 公共 `ModelRuntime.create` 和真实 `makePiSessionFactory` 构建进程级共享 runtime；managed credential 仅由 `auth.json` CredentialStore 读取，environment credential 只进入 Pi 非持久 runtime overlay，Redacted 包装在安装后擦除，overlay 在同步失败、model 缺失和幂等 shutdown 时移除，none 路径不要求凭据。composition 错误和 Registry session factory 边界均为有限、无 cause 的稳定错误。CLI 不再使用默认 fake factory，connection EOF/SIGINT/SIGTERM 依次释放 Registry sessions 与 runtime overlay；无 default/缺凭据不会阻止 ACP initialize，session/new 失败关闭。Pi Session profile 进一步收窄为不携带 credential 的 model/thinking snapshot；runtime composition 从 desktop `@folio/agent/model` 源码 alias 移至独立 runtime 边界，保持 Electron/renderer 解耦。新增 7 项 composition tests，覆盖 managed/environment/none、真实 Pi runtime custom environment overlay、同步失败回滚、派生文件权限/脱敏、缺凭据与 provider 原始错误脱敏；stdio tests 改为官方 ACP v2 Client 对真实无工具 Pi Session 的 initialize/new/close 子进程 smoke，并增加 managed 凭据缺失 session/new 失败与损坏 config 失败。验证通过：完整 Agent 11 files / 64 tests；最终 composition+stdio 10/10；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent 与 desktop production build；pack dry-run 86 entries，包含 runtime composition/CLI/session factory declarations 与 sourcemaps；构建公共导出 smoke；Pi latest/lock 仍为 0.85.1，ACP imports 全部仅为 `experimental/v2`；Agent 无 Electron/React、动态 latest、pi-acp、ACP v1，M4 前 tools/extensions/MCP/additional roots 仍禁用；凭据只在 Redacted→Pi runtime overlay 的显式窄路径出现，测试确认 `auth.json` 为空对象或仅 managed credential、派生文件无 secret；`git diff --check`；用户既有 Lark diff 原样保留。M3 保持 in_progress：仅剩 model/thinking session config options 与不进入默认 CI 的 opt-in live provider stdio smoke；无阻塞。

- 2026-09-10 07:13 — Started M3 ACP server/Registry wiring slice: 已用当前代码和 53/53 测试重新核验前置阶段；本次仅替换 ACP protocol handler 的 session 生命周期/事件桥接，不接真实 provider 网络路径、不启用工具或 project extension、不进入 M4。
- 2026-09-10 07:27 — Completed M3 ACP server/Registry wiring slice: `createFolioAgentApp` 现在以单一 `makeSessionRegistry` 作为 Pi session、prompt busy、cancel、close 与 shutdown 真源，per-session `makePiEventMapper` 把 Pi text/tool events 串行转发到 ACP v2；协议层只保留 cwd、更新时间和 replay history。prompt 在 Registry 原子占用后、调用 Pi 前发送 agent-owned `user_message` 与 `running`，completion 等待 event queue 与 Registry 状态收尾后才发送 `idle + end_turn/cancelled/refusal`，避免尾部 update/idle 与立即再次 prompt 的竞态；双 Session 可并发且 messageId 不串线。新增 no-network `makeFakePiSessionFactory` 作为 contract/当前 CLI 临时适配，server 不再直接执行 FakeModel；non-empty additionalDirectories/MCP 在 M4 前稳定拒绝；factory/provider 原始失败被归一且不泄漏 cause。app 暴露幂等 `shutdown()`，connection close 与 CLI EOF/SIGINT/SIGTERM finally 共用该释放链。新增 3 项 ACP tests（总 contract 7 项）覆盖真实 fake-Pi event 双 Session 隔离/顺序/稳定 ID、active app shutdown abort+dispose、unsupported roots/MCP 与 factory secret-free failure。验证通过：定向 ACP+Registry 17/17；完整 Agent 10 files / 56 tests（含官方 ACP v2 Client 真实短生命周期 stdio 成功与损坏 config 失败 smoke）；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent production build；pack dry-run 78 entries 包含 server/Registry/fake factory/mapper/CLI/public declarations 与 sourcemaps；构建公共导出 smoke；Pi registry latest/lock 仍为 0.85.1；所有 ACP import 仅为 `experimental/v2`，新增接线敏感字段扫描为零；`git diff --check`；用户既有 Lark diff 原样保留。M3 保持 in_progress：剩余真实 Folio default profile/CredentialStore/ModelRuntime composition、model/thinking config options 与 opt-in live provider stdio smoke；未进入 M4，无阻塞。

- 2026-09-10 00:47 — Started M0: 已读取 `AGENTS.md`、RFC 全文、根 workspace 配置与 Effect v4 指南；已确认 npm latest 为 `@earendil-works/pi-coding-agent@0.85.1`（Node `>=22.19.0`，MIT）和 `@agentclientprotocol/sdk@1.4.0`（Apache-2.0）。
- 2026-09-10 01:25 — Completed M0: 新增 Electron 无关的 `@folio/agent` workspace、精确依赖锁、ACP v2 fake-model server/CLI、initialize/new/list/resume/prompt/cancel/close contract、required `messageId`、`running`/`idle`、tool upsert、Pi abort-before-dispose、stderr-only 日志、JSON-RPC batch 与 schema/package 审计。验证通过：`npm run build --workspace=@folio/agent`；`npm test --workspace=@folio/agent`（3 files / 7 tests）；`npm run lint`（0 errors，5 条既有非本切片 warnings）；`npm run typecheck`；`npm run build`；`git diff --check`；`npm pack --dry-run --workspace=@folio/agent`。官方 ACP v2 Client 已通过真实子进程 stdin/stdout 完成 initialize、new、无工具 prompt、`idle + end_turn` 与 close。M1 留待下次运行。
- 2026-09-10 01:31 — Started M1: 已完整读取 RFC 811 行、重新验证 M0 build/tests/typecheck，并核对 ConfigService、GlobalConfig、RPC 边界及 vendored Effect v4 Schema/Service 模式；本次只实现 Schema、旧配置缺省迁移和共享目录解析切片。
- 2026-09-10 01:53 — Completed M1 slice: 在 `@folio/agent/config` 新增严格 AgentSettings / ModelProfile / builtin+custom provider Schema、profile/default 引用与 credential/environment invariants、`FOLIO_CONFIG_DIR` / `FOLIO_AGENT_DIR` 共享 resolver；desktop `GlobalConfig` 增加安全禁用默认值，旧 config 解码迁移通过，`GlobalConfigPatch` 仍不暴露 agent/model 任意 patch，未知字段及伪造 secret/header 被拒绝且解码错误脱敏。验证通过：`npm test --workspace=@folio/agent`（4 files / 14 tests，含 stdio smoke）；受影响 desktop 测试（4 files / 38 tests）；`npm run lint`（0 errors，5 条既有非本切片 warnings）；`npm run typecheck`；`npm run build`；`npm pack --dry-run --workspace=@folio/agent`（包含 config exports）；`git diff --check`。全量 desktop tests 为 112/114 通过，2 个既有 `GeneralSettings.test.tsx` 因组件未渲染测试期望的 save status 失败，与本切片无关。M1 保持 in_progress；剩余 CredentialStore、权限/redaction、Pi model compiler、ModelService/RPC、catalog/custom provider/test connection tests。
- 2026-09-10 01:56 — Started M1 credential slice: 已完整处理 RFC 813 行、读取 Effect v4 指南并重新验证 M0/M1 配置切片；本次目标限定为 CredentialStore wrapper、0600 权限和 redaction。
- 2026-09-10 02:10 — Completed M1 credential slice: 新增 Pi 公共 `CredentialStore` 兼容的 Folio-owned `SecureCredentialStore` 与 Effect `FolioCredentialStore` 服务；`auth.json` 保持 Pi provider-to-credential JSON 形状，目录强制 0700、文件创建/修复/原子替换后强制 0600，拒绝符号链接与非普通文件；以 `proper-lockfile@4.1.2` 实现跨进程 read-modify-write 锁并保留进程内串行化；API Key 通过 `Redacted<string>` 写入，list 仅返回 provider/type metadata，有限 `CredentialStoreError` 不包含原始输入、secret 或底层 cause；Pi `@earendil-works/pi-ai@0.85.1` 与锁库均作为精确直接依赖写入 lockfile，未导入 Pi 私有 auth-storage。新增 9 项 contract tests 覆盖成功读写删除、0600/0700、宽松权限修复、symlink 拒绝、跨实例并发、坏 provider/credential/file、回调异常原样传播、abort、Effect metadata/redaction。验证通过：`npm test --workspace=@folio/agent`（5 files / 23 tests，含真实 ACP stdio smoke）；agent 与全仓 `typecheck`；agent build；desktop production build；编译产物 credential smoke；`npm run lint`（0 errors，5 条既有非本切片 warnings）；`npm pack --workspace=@folio/agent --dry-run`（model declarations/runtime 已纳入）；依赖树精确为 Pi/PI-AI 0.85.1、ACP 1.4.0、Effect rc.112、proper-lockfile 4.1.2；`git diff --check`。完整 4,169 行 diff 审计未发现动态 latest、Pi 私有 auth-storage 或 agent Electron import；desktop 敏感字段扫描仅命中预期负向测试。M1 仍为 in_progress，剩余 model config compiler、ModelService/RPC、builtin catalog/custom provider/test connection 及整体 Exit criteria。
- 2026-09-10 02:14 — Started M1 model compiler slice: 已完整处理 RFC 815 行、重读 Effect v4 指南并以 5 files / 23 tests 和 package typecheck 重新确认前置切片；registry latest 仍为 Pi 0.85.1、ACP SDK 1.4.0。本次目标限定为确定性 Pi model config compiler、credential source resolution 与稳定脱敏错误，不进入 ModelService/RPC 或 UI。
- 2026-09-10 02:25 — Completed M1 model compiler slice: 新增 Electron 无关的 `model-config-compiler`，直接复用 Pi 0.85.1 公开 builtin catalog、`Model<Api>` 与 `ModelRuntime.registerProvider` 输入类型；builtin profile 从 catalog 精确解析，custom profile 编译 OpenAI-completions/Anthropic-messages model metadata，缺失 metadata、未知 provider/model、default/profile 缺失与 provider 冲突均返回有限、可序列化且不携带原始输入/cause 的 `ModelConfigCompilerError`。managed credential 只验证 provider-scoped CredentialStore 条目且不取出 secret；environment credential 仅在运行时读取已校验变量名并包入 `Redacted<string>`；none 不读取存储。新增 credential-blind、确定性 `models.generated.json` 编译与序列化：source checksum 为 canonical AgentSettings 的 SHA-256，并以 JSONC 注释记录，使完整派生文件同时携带 checksum 且通过 Pi strict ModelConfig 加载；未写入 apiKey/header/environmentVariable。新增 8 项 compiler contract tests覆盖 builtin/custom、managed/environment/none、稳定失败、storage error redaction、deterministic checksum、provider conflict，并用真实 Pi ModelRuntime 加载完整生成文件。验证通过：`npm test --workspace=@folio/agent`（6 files / 31 tests，含真实 ACP stdio smoke）；agent 与全仓 typecheck；agent build；desktop production build；编译后的 package 入口生成文件 + Pi Runtime smoke；`npm run lint`（0 errors，5 条既有 warnings）；`npm pack --workspace=@folio/agent --dry-run`（compiler runtime/declarations 已纳入）；精确依赖树与 `git diff --check`。19 个 Agent 源码/测试文件静态审计未发现动态 latest、Pi 私有 auth-storage 或 Electron import（目录 resolver 仅有“without Electron”注释）；desktop 敏感字段扫描仅命中预期负向测试。M1 仍为 in_progress，剩余 ModelService/RPC、builtin catalog/custom provider/test connection service tests 及整体 Exit criteria。
- 2026-09-10 02:33 — Started M1 ModelService core slice: 已完整处理 RFC 817 行、重读 Effect v4 指南并以 6 files / 31 tests 与 package typecheck 重新确认 M0 和既有 M1 切片；本次限定实现 ConfigService-backed 串行命令、CredentialStore、派生文件原子写与脱敏 view/error，不接 Model RPC 或 UI。
- 2026-09-10 03:22 — Completed M1 ModelService core slice: desktop 新增 `ModelService` 与 renderer-safe `ModelSettingsView` / `ModelServiceError`；profile/default/credential 命令由同一 Semaphore 串行，非敏感设置通过 `ConfigService.setAgent` 复用 config.json 单一真源，普通 `config.update` 仍不能提交 agent patch。managed credential 按 profile 解析 provider 后写入 `auth.json`，共享 provider 凭据删除被稳定拒绝；environment credential 只暴露 configured metadata。`models.generated.json` 以同目录 scoped temp + rename 原子替换，目录/文件强制 0700/0600，尊重 `FOLIO_AGENT_DIR`，派生失败保留已提交 config 真源并返回无 cause 的稳定错误，损坏派生文件可仅从 config.json 重建；watch 发布 initial + committed credential-blind view。新增 11 项真实文件系统 service tests，覆盖 builtin/custom、持久化、并发不丢更新、目录覆盖、凭据写删/共享拒绝、环境值脱敏、default/unknown/invalid 边界、派生失败恢复与损坏重建；ConfigService 增加 setAgent 并补并发/invalid-input 脱敏测试。验证通过：受影响 desktop tests 5 files / 51 tests；`@folio/agent` 6 files / 31 tests（含真实 ACP v2 stdio smoke）；全仓 `npm run typecheck`；`npm run lint`（0 errors，5 条既有 warnings）；desktop production `npm run build`；`git diff --check`；registry/依赖树精确为 Pi/PI-AI 0.85.1、ACP 1.4.0、Effect rc.112、proper-lockfile 4.1.2。静态扫描中的敏感词仅位于 Redacted 主进程 credential 写入和负向脱敏测试，未进入 GlobalConfig、Model view、派生文件或错误。M1 保持 in_progress：尚缺 Model RPC、MainRpcLive/MainLive 装配、testConnection、list/refresh catalog、provider 不可达稳定错误及 desktop/standalone 默认模型一致性最终验收；Models UI/M2 未开始。
- 2026-09-10 03:27 — Started M1 Model RPC slice: 已完整读取 RFC 818 行、重读 Effect v4 指南并以 Agent 31/31 与受影响 desktop 51/51 测试重新确认前置切片；本次限定实现 RPC Schema/handlers/renderer client、序列化与凭据边界测试及 Main Layer 装配，不实现 catalog、test connection、UI 或 M2。
- 2026-09-10 03:34 — Completed M1 Model RPC slice: 新增共享 `ModelRpcs`，覆盖 credential-blind `models.watch`、profile save/delete、default、credential set/delete 与派生文件重建；credential 使用 `Schema.Redacted(NonEmptyString)`，仅在单次 `models.setCredential` 请求中进入 main handler，renderer client 故意不创建会保留该 payload 的 mutation atom。新增 main `ModelRpcHandlersLive` 与 renderer `ModelRpcClient`/`modelsAtom`，并将协议/handlers 合并进 `MainRpcLive`、将同一 `ModelService.layer()` 装配进 `MainLive`。新增 2 项真实文件系统 `RpcTest` contract tests，覆盖 watch initial/committed snapshots、profile/default/credential/rebuild 成功路径、unknown profile 稳定错误，以及 secret 只写入 `auth.json`、不进入 RPC 响应、config.json 或 models.generated.json。验证通过：Model RPC + services 3 files / 31 tests；受影响 desktop RPC/service regression 7 files / 61 tests；`@folio/agent` 6 files / 31 tests（含真实 ACP v2 stdio smoke）；全仓 `npm run typecheck`；`npm run lint`（0 errors，5 条既有 warnings）；desktop production `npm run build`；`git diff --check`；依赖树仍精确为 Pi/PI-AI 0.85.1、ACP 1.4.0、Effect rc.112、proper-lockfile 4.1.2。切片凭据审计仅命中 Redacted request、主进程 credential store 和负向测试，renderer/shared response state、错误和派生文件无 API Key/token/header。M1 保持 in_progress：剩余 list/refresh catalog、testConnection、provider 不可达稳定错误和 desktop/standalone 默认模型一致性最终验收；Models UI/M2 未开始。
- 2026-09-10 03:39 — Started M1 catalog/connection slice: 已完整读取 RFC 820 行、重读 Effect v4 指南并以 Agent 31/31 与 Model RPC/Service/Config 31/31 测试重新确认前置切片；本次限定实现 Agent-owned Pi runtime adapter、desktop catalog/connection commands、稳定脱敏错误和成功/凭据/配置/网络失败测试，不进入 UI 或 M2。
- 2026-09-10 04:00 — Started M1 standalone config parity slice: 已重新完整读取 `AGENTS.md`、RFC、Effect v4 指南及当前 CLI/server、config/model/runtime/desktop service 代码；以 Agent 36/36 与 desktop 35/35 测试重新确认前置切片。代码证据确认 standalone CLI 尚未读取 Folio 默认模型，因此本次仅补共享配置加载器、CLI 启动加载和 desktop/standalone 同根一致性验收，不进入 M2。
- 2026-09-10 04:11 — Completed M1 catalog/connection slice: 新增 Electron 无关的 Pi public ModelRuntime adapter，支持 credential-blind builtin/custom catalog、强制网络 refresh 与 stale-cache 保留、最小真实 provider connection probe；desktop ModelService/RPC 增加 list/refresh/testConnection 与瞬时 `ready`/`unavailable` 状态，profile/credential 变更重置为 `untested`。新增真实 Pi catalog/custom provider success、credential missing、damaged generated config、provider unavailable、refresh failure tests，以及 desktop service/RPC wire 与脱敏测试；Vitest 使用专用 Agent 源码 alias，避免陈旧 dist 污染。该切片验证并入最终 Agent 40/40、desktop 67/67 与全仓门禁。
- 2026-09-10 04:11 — Completed M1: 新增共享 `loadFolioAgentConfig`，严格解析 `FOLIO_CONFIG_DIR/config.json` 的 AgentSettings 子树，缺失文件使用安全 disabled defaults，损坏/不可读配置返回无 source/cause 的固定错误；解析同一目录下的 agent runtime 路径与 default profile。`folio-agent` CLI 启动时实际加载该快照，default provider/model 仅写 stderr；损坏配置非零退出、stdout 为空且不泄漏原文。新增 loader 3 项测试、成功与损坏配置两条真实短生命周期 stdio smoke，并在 desktop ModelService 测试中用实际写入的同一 `config.json` 直接比较 desktop view 与 standalone loader 的 default profile/agent directory，满足 desktop/standalone 一致性退出标准。最终验证通过：`npm test --workspace=@folio/agent`（8 files / 40 tests）；受影响 desktop regression（8 files / 67 tests）；全仓 `npm run typecheck`；`npm run lint`（0 errors，5 条既有 warnings）；Agent build；desktop production build；`npm pack --workspace=@folio/agent --dry-run`（loader runtime/declarations 已纳入）；依赖锁仍为 Pi/PI-AI 0.85.1、ACP 1.4.0、Effect rc.112、proper-lockfile 4.1.2；静态边界/凭据扫描与 `git diff --check` 通过。M1 全部 Deliverables 和 Exit criteria 已满足；M2 标记 pending，未在本次开始 UI 实现。
- 2026-09-10 04:14 — Started M2 profile UI slice: 已重新完整读取 `AGENTS.md`、RFC 823 行、Effect v4 指南及 Models Settings/Model RPC/现有 Settings UI 与测试模式；以 Agent 40/40 和 ModelService/Model RPC/ConfigService 36/36 测试重新确认 M0/M1。代码证据确认 Models 页面仍为空占位，本次限定实现真实 watch loading/error/retry、profile list、builtin catalog profile editor、thinking/default 保存和中英文 renderer tests；凭据、custom provider、connection/catalog actions 与删除边界留待后续 M2，不进入 M3。
- 2026-09-10 04:23 — Completed M2 profile UI slice: 将 `ModelsSettings` 从空占位替换为真实 `models.watch` 驱动的 loading/failure/retry、空状态与 committed profile list；通过现有 AtomRpc 增加 credential-blind `models.listCatalog` query，以 builtin catalog picker 实现 profile 新增/编辑、不可变 profile ID、thinking level 和显式设置 default。新增独立中英文文案、profile card 与 builtin editor；保存/default 均禁用重复提交且不做乐观列表覆盖，失败仅显示固定本地文案，不读取 provider/RPC 错误正文。新增 4 项 jsdom tests 覆盖加载与双层 retry、committed profile metadata/default、必填校验与一次提交、保存失败的中文脱敏/不覆盖旧状态。验证通过：Models Settings 4/4；受影响 desktop 9 files / 71 tests；Agent 8 files / 40 tests；除既有 `GeneralSettings.test.tsx` 两项失败外的 desktop 全量 29 files / 136 tests；全仓 typecheck；lint（0 errors，5 条既有 warnings）；Agent 与 desktop production build；新 Models UI 敏感字段/error-body 扫描无命中；`git diff --check`。完整 desktop 套件 136/138 的两项失败是任务开始前已记录的 GeneralSettings save-status 测试，与本切片文件和调用栈无关。M2 保持 in_progress：尚缺 ephemeral credential 输入、custom provider 表单、catalog refresh/test connection、删除/default/shared-credential 约束与最终 M2 验收；未进入 M3。
- 2026-09-10 04:31 — Started M2 provider-actions slice: 已重新完整读取 `AGENTS.md`、RFC 826 行、Effect v4 指南及 Models UI/RPC/ModelService/tests；以 Agent 40/40 与 M2/M1 定向 desktop 40/40 测试重新确认前置阶段，Pi latest 仍为 0.85.1。本次限定实现 ephemeral credential configure/delete、test connection、refresh catalog、profile delete/default protection 与成功/失败/重复提交 tests；custom provider 和最终重启验收留待后续 M2，不进入 M3。
- 2026-09-10 04:47 — Completed M2 provider-actions slice: 在 `ModelsSettings` 与 credential-blind profile card 上接入 configure/replace/delete credential、test connection、refresh catalog、profile delete confirmation、clear default 与 default delete protection；所有命令使用单一 in-flight 门禁且不乐观覆盖 committed watch snapshot。新增独立 `CredentialDialog`，secret 只存在于受控 password input 和单次 `models.setCredential` RPC；renderer 不创建 credential mutation/fn atom，直接从非敏感 runtime Context 获取 client，使用 `Redacted` 发送并在成功、失败或关闭时清空输入。refresh 失败保留 stale catalog 文案，shared credential 与 connection/provider 失败仅显示有限本地分类，不渲染原始错误。新增/扩展中英文文案和 4 项 provider-actions renderer tests，覆盖 ephemeral secret 单次提交/卸载清空、refresh/test 重复提交、删除确认/default 保护、shared credential 脱敏失败；Models Settings 共 8/8。验证通过：受影响 desktop 4 files / 44 tests；Agent 8 files / 40 tests（含真实短生命周期 stdio smoke）；desktop 排除既有 `GeneralSettings.test.tsx` 历史失败后 29 files / 140 tests；全仓 typecheck；lint（0 errors，5 条既有 warnings）；Agent build；desktop production build；renderer secret/header/error-body 与 credential atom 扫描无违规；`git diff --check`。M2 保持 in_progress：尚缺 custom OpenAI-compatible / Anthropic-compatible 基础表单及最终重启持久化验收；未进入 M3，无阻塞。
- 2026-09-10 05:03 — Started M2 custom provider form slice: 已完整读取 `AGENTS.md`、RFC 829 行、Effect v4 指南、custom provider Schema/compiler/runtime 与当前 Models UI/tests；Pi latest 仍为 0.85.1。Agent 40/40 与定向 desktop 44/44 重新确认前置阶段；本次限定新增/编辑 OpenAI/Anthropic-compatible 基础字段、credential source/environment variable 和成功/校验/失败/重复提交 tests，不增加任意 JSON/header 编辑器，最终重启持久化验收留待后续 M2。
- 2026-09-10 05:12 — Completed M2 custom provider form slice: 新增 `CustomProfileForm`，支持 OpenAI-compatible / Anthropic-compatible profile 新增与编辑，覆盖不可变 profile ID、provider ID、绝对 HTTPS base URL、API 类型、model ID/display name、reasoning、正整数 context window/max tokens 且 maxTokens 不超过 contextWindow、managed/environment/none credential source、合法 environment variable 与 thinking level；输出直接构造既有 `ModelProfile`，继续通过 `models.saveProfile` 提交并以 `models.watch` committed snapshot 为唯一列表真源，不增加任意 JSON/header 编辑器。Models 页面增加内置/自定义两个入口，custom 卡片开放编辑；补齐中英文 copy。新增 3 项 renderer tests 覆盖 Anthropic/environment 完整提交与重复提交抑制、HTTPS/limits/env 失败不提交、OpenAI custom committed profile 回填编辑与 ID 不可变；Models Settings 共 11/11。验证通过：受影响 desktop 4 files / 47 tests；Agent 8 files / 40 tests（含真实 stdio smoke）；desktop 排除既有 `GeneralSettings.test.tsx` 历史失败后 29 files / 143 tests；全仓 typecheck；lint（0 errors，5 条既有 warnings）；Agent build；desktop production build；新表单 secret/header/error-body 扫描无违规；`git diff --check`。M2 保持 in_progress：仅剩真实 runtime 重建后的 profile/default/credential metadata 持久化验收；未进入 M3，无阻塞。
- 2026-09-10 05:34 — Started M2 final persistence acceptance: 已完整读取规范、RFC 1–830 行、Effect 指南、ModelService/RPC/ConfigService 及测试配置，确认 Pi latest/lock 均为 0.85.1、Agent 无 Electron/React import，并用当前代码重新跑通 Models Settings + ModelService + Model RPC 3 files / 29 tests。本次只新增跨 RPC Layer/runtime 销毁重建的 profile/default/credential metadata 持久化与 secret 隔离验收，不进入 M3。
- 2026-09-10 05:39 — Completed M2: 在 `model-rpc.test.ts` 新增真实持久化验收，第一套 scoped RPC Layer 依次保存 custom profile、写入 managed credential、成功测试连接并设置 default，释放后以同一 `FOLIO_CONFIG_DIR` 创建全新 ConfigService/ModelService/RPC Layer；重建后的 initial watch snapshot 保留 profile/default/credentialConfigured，瞬时 connectionStatus 正确重置为 untested，未知 profile 失败保持有限、无 cause。测试同时断言 secret 不进入两次 RPC 结果、watch snapshot、config.json、models.generated.json 或错误，仅 auth.json 包含 credential。M2 全部 UI deliverables 与“新增 profile → 配置凭据 → 测试 → 设置 default → 重启后仍生效”退出标准完成。验证通过：Model RPC 4/4；受影响 desktop 4 files / 48 tests；desktop 排除既有 GeneralSettings 历史失败后 29 files / 144 tests；Agent 8 files / 40 tests（含 stdio smoke）；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent/desktop production build；凭据边界扫描；`git diff --check`。M3 标记 pending，未在本次开始，无阻塞。
- 2026-09-10 06:06 — Started M3 Pi event mapper slice: 已完整读取规范、RFC 1–833 行、Effect 指南、现有 ACP/CLI/Pi lifecycle/config/runtime 代码和 Pi 0.85.1 public SDK/event types，并用当前代码重新跑通 Agent 8 files / 40 tests。确认 M3 最早缺口是 ACP server 仍直接使用 FakeModel，尚无 Pi `AgentSessionEvent` 到 ACP v2 update 的独立边界；本次只实现并验证 text/tool event mapper，不接真实 provider、不进入 M4。
- 2026-09-10 06:15 — Completed M3 Pi event mapper slice: 新增 Electron 无关、从包公共入口导出的 `makePiEventMapper`，把 Pi assistant `text_delta` 映射为携带 agent-owned 稳定 `messageId` 的 ACP v2 `agent_message_chunk`；把 `toolcall_end` 与 execution start/update/end 映射为同一 `toolCallId` 的 pending/in_progress/content/completed/failed upsert。遵守 stable baseline，未使用 SDK 标注 unstable 的 tool `name` 字段，未输出 rawInput/rawOutput；工具输出仅提取 Pi `AgentToolResult.content` 的非空 text blocks，明确丢弃 details、usage、图片、循环对象和任意内部数据。新增 3 项 fake Pi event tests 覆盖多 delta 稳定 ID/消息轮换、完整成功 tool lifecycle、失败/无显示内容/未知事件及安全字段不可见。验证通过：mapper 3/3；完整 Agent 9 files / 43 tests（含真实 stdio smoke）；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent build；pack dry-run 和构建公共入口 smoke；Electron/React 与敏感字段静态审计；`git diff --check`。M3 保持 in_progress，剩余真实 Pi session factory、Session Registry/ACP 接线、session config options、cancel/close/shutdown 资源链及真实 provider vertical smoke；未进入 M4，无阻塞。
- 2026-09-10 06:38 — Started M3 Pi session foundation slice: 已重新完整读取仓库规范、RFC 1–833 行、Effect 指南 1–396 行和当前 Agent/Pi/config/model/contract 代码，以正确仓库下 Agent 9 files / 43 tests、`git diff --check`、Pi latest 0.85.1 重新确认前置阶段。本次只实现安全真实 Pi factory 与独立 Session Registry，不改 ACP wire handler，不启用任何工具或 project extension，不进入 M4。
- 2026-09-10 07:00 — Completed M3 Pi session foundation slice: 新增从公共入口导出的 `makePiSessionFactory`，只接收已安全准备的共享 Pi `ModelRuntime` 与 immutable `CompiledModelProfile`，强制绝对 cwd/绝对 Folio agentDir，使用 `SessionManager.inMemory(cwd)`、`SettingsManager.inMemory(..., { projectTrusted: false })` 和显式 `DefaultResourceLoader`，关闭全部 tools/extensions/skills/prompts/themes/context files，避免 `~/.pi/agent`、project extension 与 M4 前 shell 越界；Pi/Provider 原始错误统一为有限、无 cause 的稳定错误。新增独立 `makeSessionRegistry`：每 session 独立 Pi session/subscription/state/event queue/foreground work，sessionId create reservation 防并发重复；prompt 返回 completion handle 以保留 ACP 即时 acknowledgment 能力；同 session busy 拒绝、不同 session 并发；cancel 只 abort 对应 session 并等待 idle；close/shutdown 执行 abort → work/idle → unsubscribe → event drain → dispose，等待并释放 in-flight factory，幂等 shutdown 共用完成 Promise，dispose/unsubscribe 异常被隔离。新增 10 项 tests，含真实 Pi `createAgentSession` 无网络 construction/dispose smoke、mock factory 参数审计、相对路径失败、双 Session 隔离、busy、定向 cancel、事件排空、close/shutdown 顺序、并发 create reservation、factory/shutdown race 和 secret-free failure。验证通过：定向 10/10；完整 Agent 10 files / 53 tests（含真实 ACP v2 stdio smoke）；全仓 typecheck；lint 0 errors / 5 条既有 warnings；Agent production build；npm pack dry-run 包含 factory/registry runtime、declarations 与 sourcemaps；构建公共导出 smoke；Electron/React、ACP v1/unstable/pi-acp 与新增实现敏感字段扫描为零；Pi registry latest/lock 仍为 0.85.1；`git diff --check`；用户既有 Lark diff 原样保留。M3 保持 in_progress：剩余 ACP server/runtime composition 接线、session config options、进程信号/Layer shutdown 和 provider vertical stdio smoke；未进入 M4，无阻塞。
