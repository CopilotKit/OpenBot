import type { McpCallResult, McpTool } from "./mcp";

/**
 * The builtin transport for Routines — a refusing stub, this commit only.
 *
 * The four tools (`create_routine`, `update_routine`, `delete_routine`, `list_routines`) arrive in a
 * later commit. This stub exists so the closed union in {@link ./transport} is honest per commit: a
 * `TransportKind` member with no registry entry would not typecheck, and a registry entry that
 * throws at import would break every deployment that merely loads the module graph. Registering a
 * transport that refuses every call, instead, keeps the union closed and every deployment booting
 * while the actual tools are still being built.
 */

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return [];
}

export async function callTool(): Promise<McpCallResult> {
  return {
    text: "Routines is not wired up in this build.",
    isError: true,
    truncated: false,
  };
}
