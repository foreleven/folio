# Agent packaging

Agent 使用 `pi-coding-agent` SDK。Electron Vite 将 `packages/agent/src/cli.ts` 作为独立入口编译为 `out/main/agent.js`，SDK 及其生产依赖由 electron-builder 随 App 的正常依赖一起打包。

开发启动直接运行 `electron-vite dev`。不再执行 prepare:agent、临时 npm ci、复制独立 Node 或生成 `.agent-runtime/bundle`。打包同样没有额外准备钩子。

Folio 通过当前 App 可执行文件及 `ELECTRON_RUN_AS_NODE=1` 启动独立 ACP 进程，复用 Electron 内置 Node。启动前探测实际 Node >=24 和 SQLite API；缺少构建入口时明确失败。App 的 RunAsNode fuse 必须保持启用。Pi SDK 在该进程执行；Codex adapter 继续调用用户安装的 Codex。

Integration 脚本如通过 `/usr/bin/env node` 调用 Node，目前使用用户 PATH；Electron 可执行文件不等于名为 node 的命令，不再承诺额外随包提供该命令。

`FOLIO_AGENT_DIR` 保存 Folio provider 配置；Harness 将 `FOLIO_SESSION_STORAGE_DIR` 设置为 Vault 的 `agent-history`。取消独立运行包不改变会话、ACP 或 Task 存储规则，也不改变 full access 模式。

验证包括开发构建的 Electron Node/SQLite 探测和 Pi/Codex ACP 初始化；初始化不发送 Prompt，不调用模型，也不证明实际 Codex 执行。Windows/Linux 和签名分发仍待验证。

本轮 macOS arm64 App 目录打包通过；从临时工作目录用实际 Folio.app 可执行文件启动包内 app.asar/out/main/agent.js，Pi/Codex ACP 初始化均通过，未依赖旧 .agent-runtime 目录或仓库 NODE_PATH。未进行签名或真实模型验证。
