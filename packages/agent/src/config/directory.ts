import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FOLIO_CONFIG_DIR_ENV = "FOLIO_CONFIG_DIR";
export const FOLIO_AGENT_DIR_ENV = "FOLIO_AGENT_DIR";

export interface AgentDirectoryEnvironment {
  readonly [key: string]: string | undefined;
  readonly FOLIO_CONFIG_DIR?: string;
  readonly FOLIO_AGENT_DIR?: string;
}

export interface ResolveAgentDirectoryOptions {
  readonly env?: AgentDirectoryEnvironment;
  readonly homeDirectory?: string;
}

const resolveOverride = (value: string, homeDirectory: string): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return join(homeDirectory, value.slice(2));
  return resolve(value);
};

/** Resolves Folio's global config directory without depending on Electron. */
export const resolveFolioConfigDirectory = (options: ResolveAgentDirectoryOptions = {}): string => {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configDirectory = env.FOLIO_CONFIG_DIR?.trim();
  return configDirectory
    ? resolveOverride(configDirectory, homeDirectory)
    : join(homeDirectory, ".folio");
};

/**
 * Resolves the shared Folio-owned Pi runtime directory without reading Electron APIs.
 * `FOLIO_AGENT_DIR` wins; otherwise the agent directory lives under the Folio config root.
 */
export const resolveFolioAgentDirectory = (options: ResolveAgentDirectoryOptions = {}): string => {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const explicitAgentDirectory = env.FOLIO_AGENT_DIR?.trim();
  if (explicitAgentDirectory) return resolveOverride(explicitAgentDirectory, homeDirectory);
  return join(resolveFolioConfigDirectory({ env, homeDirectory }), "agent");
};
