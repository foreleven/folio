// A subprocess fixture for the native JSON-RPC transport, never a model or Codex behavior substitute.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
let turnNumber = 0;
let activeTurn;
let extraRoots = [];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (!method) return send({ method: "answered", params: message });
  if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });
  if (method === "initialized") return;
  if (method === "thread/backgroundTerminals/clean") {
    writeFileSync("terminal-cleanup.json", JSON.stringify(params));
    if (activeTurn?.mode === "cleanup-error") return send({ id, error: { code: -1, message: "Cleanup failed" } });
    if (activeTurn?.mode === "cleanup-delay") return setTimeout(() => send({ id, result: {} }), 100);
    return send({ id, result: {} });
  }
  if (method === "config/read") {
    let automatic = false;
    try { automatic = JSON.parse(readFileSync('automatic-skills.json', 'utf8')); } catch { /* Absent fixture configuration uses the default. */ }
    return send({ id, result: { config: { skills: { include_instructions: automatic } } } });
  }
  if (method === "skills/extraRoots/set") {
    extraRoots = params.extraRoots;
    writeFileSync('skill-roots.json', JSON.stringify(extraRoots));
    return send({ id, result: {} });
  }
  if (method === "skills/list") return send({ id, result: { data: [{ cwd: process.cwd(), errors: [], skills: extraRoots.map(root => ({
    name: basename(root), path: join(root, 'SKILL.md'), enabled: !root.endsWith('disabled')
  })) }] } });
  if (method === "thread/start" || method === "thread/read" || method === "thread/resume") {
    try {
      if (method === "thread/start") {
        writeFileSync("native-thread.json", JSON.stringify({ id: "native-thread", cwd: process.cwd(), ephemeral: false }));
      }
      const thread = JSON.parse(readFileSync("native-thread.json", "utf8"));
      if (method === "thread/read") return send({ id, result: { thread } });
      if (method === "thread/resume") writeFileSync("resumed.json", JSON.stringify(params));
      send({ method: "fixture/opened", params });
      return send({ id, result: { thread, cwd: process.cwd(), model: "configured-model", modelProvider: "configured-provider",
        approvalPolicy: thread.approvalPolicy ?? params.approvalPolicy,
        sandbox: thread.sandbox ?? { type: "dangerFullAccess" } } });
    } catch { return send({ id, error: { code: -1, message: "native state unavailable" } }); }
  }
  if (method === "turn/start") {
    writeFileSync('turn-input.json', JSON.stringify(params.input));
    const mode = params.input[0].text;
    const turn = { id: `turn-${++turnNumber}`, status: "inProgress", items: [] };
    activeTurn = { turn, mode, threadId: params.threadId };
    const notify = (method, extra) => send({ method, params: { threadId: params.threadId, turnId: turn.id, ...extra } });
    notify("turn/started", { turn });
    if (mode === "running" || mode === "cancel-start" || mode === "cancel-timeout") {
      return setTimeout(() => send({ id, result: { turn } }), mode === "cancel-start" ? 60 : 0);
    }
    if (mode === "crash") { send({ id, result: { turn } }); return setTimeout(() => process.exit(1), 10); }
    if (mode === "unsupported") {
      send({ id, result: { turn } });
      return send({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, turnId: turn.id } });
    }
    notify("item/agentMessage/delta", { itemId: "message", delta: "draft" });
    notify("item/completed", { item: { type: "agentMessage", id: "message", text: "final answer" } });
    const command = { type: "commandExecution", id: "command", command: "fixture", cwd: process.cwd(), status: "inProgress" };
    notify("item/started", { item: command });
    notify("item/commandExecution/outputDelta", { itemId: "command", delta: "one" });
    notify("item/completed", { item: { ...command, status: "completed", aggregatedOutput: "one two" } });
    notify("turn/completed", { turn: { ...turn, status: mode === "failed" ? "failed" : "completed" } });
    return setTimeout(() => send({ id, result: { turn: { ...turn, id: mode === "mismatch" ? "other-turn" : turn.id } } }), 30);
  }
  if (method === "turn/interrupt") {
    writeFileSync("interrupt.json", JSON.stringify(params));
    send({ id, result: {} });
    if (activeTurn.mode === "cancel-timeout") return;
    return setTimeout(() => send({ method: "turn/completed", params: {
      threadId: activeTurn.threadId, turn: { ...activeTurn.turn, status: "interrupted" },
    } }), 30);
  }
  if (method === "slow") return setTimeout(() => send({ id, result: params }), 40);
  if (method === "error") return send({ id, error: { code: -1, message: "private-credential-sentinel" } });
  if (method === "exit") return process.exit(1);
  if (method === "close-output") { process.stdout.end(); return setInterval(() => {}, 1000); }
  if (method === "malformed") return process.stdout.write("private-not-json\n");
  if (method === "hang") return;
  if (method === "unknown-id") return send({ id: 987654, result: {} });
  if (method === "server-request") {
    send({ id: "server-1", method: "native/question", params });
    return send({ id, result: null });
  }
  if (method === "events") {
    process.stderr.write("private-diagnostic-sentinel".repeat(10_000));
    send({ method: "native/update", params });
  }
  send({ id, result: params });
});
