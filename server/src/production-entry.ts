/*
 * Bun resolves eventsource@3 through its `bun` export before its `require` export. The MCP SDK's
 * CommonJS SSE transport still requires eventsource, so the production process evaluates the ESM
 * module once before the runtime can reach that CJS require.
 */
import "eventsource";

await import("./index");
