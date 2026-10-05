/**
 * What the model is told a governed tool call came back with.
 *
 * Its own module for the reason `history.ts` is: `index.ts` calls `serve()` at module scope, so
 * importing it to reach one function binds a port.
 *
 * A DEPLOYMENT THAT WOULD NOT RUN THE CALL DID NOT RETURN NOTHING. `/api/agent-tools/call` answers a
 * callback it cannot verify with 401 or 403 and the reason under `error`, and no `text`. Read as a
 * result, that became "The tool returned nothing.", and a model told a search returned nothing tells
 * the person nothing was found: the false negative delivered as an answer that `mcp.callback_refused`
 * was added to leave a trail for. The trail was fixed; what the model was told was not.
 *
 * So an answer that is not a success is a refusal, in the words `agent-langgraph-agui` already uses
 * for the same response (`tool_runtime.py`), with the deployment's own reason after it when it gave
 * one. It leads with the marker the transcript reads, as this Bot's other two refusals in `callTool`
 * do. A success is passed on exactly as before.
 */
export async function toolAnswer(response: Response): Promise<string> {
  if (!response.ok) {
    const refusal = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const reason =
      typeof refusal?.error === "string" && refusal.error.trim()
        ? ` ${refusal.error.trim()}`
        : "";
    return `Refused. Tool callback returned HTTP ${response.status}.${reason}`;
  }
  const body = (await response.json()) as { text?: string };
  return body.text ?? "The tool returned nothing.";
}
