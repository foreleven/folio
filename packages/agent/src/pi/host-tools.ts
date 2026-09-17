import {
  createCodingTools, createGrepTool, createFindTool, createLsTool,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export type PiToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
export type PiToolExecutor = (name: string, callId: string, params: unknown, signal?: AbortSignal,
  onUpdate?: (result: PiToolResult) => void) => Promise<PiToolResult>;

/** Keep SDK schemas/prompts; only tool I/O is delegated to the supervising host. */
export function makeHostToolDefinitions(cwd: string, execute: PiToolExecutor): ToolDefinition<any, any>[] {
  const definitions: ToolDefinition<any, any>[] = [createReadToolDefinition(cwd), createBashToolDefinition(cwd),
    createEditToolDefinition(cwd), createWriteToolDefinition(cwd), createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd), createLsToolDefinition(cwd)];
  return definitions.map(definition => ({ ...definition,
    execute: (id, params, signal, onUpdate) => execute(definition.name, id, params, signal, onUpdate),
  }));
}

/** Host-side SDK tools preserve normal output formatting, truncation and file mutation behavior. */
export function makePiLocalToolExecutor(cwd: string, bash: import('@earendil-works/pi-coding-agent').BashOperations): PiToolExecutor {
  const tools = new Map([...createCodingTools(cwd, { bash: { operations: bash } }),
    createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)].map(tool => [tool.name, tool]));
  return async (name, callId, params, signal, onUpdate) => {
    const tool = tools.get(name);
    if (!tool) throw new Error('Unknown Pi tool.');
    if (signal?.aborted) throw new Error('Tool execution cancelled.');
    return tool.execute(callId, params, signal, onUpdate);
  };
}
