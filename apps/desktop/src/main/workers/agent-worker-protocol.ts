import type { AgentExecutionOptions, PiToolResult } from '@folio/agent'
import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'

/** Only structured-clone values cross this boundary; no Vault database or service context. */
export type AgentWorkerOptions = Omit<AgentExecutionOptions, 'signal' | 'onUpdate' | 'onProcessStarted' | 'onSessionBound' | 'processTransport' | 'toolExecutor'>
export type AgentWorkerCommand =
  | { type: 'open'; id: number; options: AgentWorkerOptions; native?: { pid: number; stdin: WritableStream<Uint8Array>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> } }
  | { type: 'execute'; id: number; prompt: string }
  | { type: 'cancel' | 'dispose'; id: number }
  | { type: 'tool-result'; sequence: number; value?: PiToolResult; error?: string }
  | { type: 'tool-update'; sequence: number; value: PiToolResult }
  | { type: 'native-exited' }
  | { type: 'ack'; sequence: number; error?: string }
export type AgentWorkerEvent =
  | { type: 'tool'; sequence: number; name: string; callId: string; params: unknown }
  | { type: 'tool-cancel'; callId: string }
  | { type: 'native-close'; sequence: number }
  | { type: 'session-bound'; sequence: number; nativeSessionId: string }
  | { type: 'process-started'; sequence: number; pid: number }
  | { type: 'update'; sequence: number; notification: UpdateSessionNotification }
  | { type: 'result'; id: number; value?: unknown }
  | { type: 'error'; id: number; error: { name: string; message: string; stack?: string } }
