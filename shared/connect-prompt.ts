/**
 * The refusal a person can act on: an app this call needed, that they have not connected.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `./handoff-markers.ts` sets out at length.
 * A tool that runs on the server reaches the transcript as text meant for a model, so a renderer
 * can only tell this refusal from the others by its wording — and a wording that lives in two files
 * is a contract that drifts. The server builds the sentence here and the transcript reads it here.
 *
 * WHY IT IS WORTH TELLING APART AT ALL. "Connect it in Settings and ask again" is a correct
 * sentence and a bad one to end on: it describes a screen somewhere else, in the middle of a
 * conversation the person is having now, about an app the Bot was holding a tool for all along.
 * What they need is the thing itself, where they are reading — which is what the marker lets the
 * transcript put there.
 */

/** The first characters of the refusal, immediately followed by its JSON. */
export const CONNECT_APP_MARKER = "[connect-app]";

export type ConnectPrompt = {
  /** The plugin server to connect, as `POST /api/plugins/servers/:serverId/connect` names it. */
  serverId: string;
  /** The app's own name, for a card that says what it is asking for. */
  title: string;
  /** What the Bot would have said, kept intact for a reader with no card to draw. */
  message: string;
};

/**
 * The refusal text a `PluginRefusedError` carries for an app the asker has not connected.
 *
 * The sentence stays in the string rather than being rebuilt by the card, because it is also what
 * the MODEL is told, and because a transcript that cannot parse the marker still reads correctly.
 */
export function connectAppRefusal(prompt: ConnectPrompt): string {
  const { serverId, title, message } = prompt;
  return `${CONNECT_APP_MARKER}${JSON.stringify({ serverId, title })} ${message}`;
}

/**
 * The prompt inside a refusal, or null for any other text.
 *
 * Fails to null on anything it does not fully recognise — a truncated marker, JSON that is not an
 * object, a field of the wrong type. A card drawn from a half-read refusal would offer to connect
 * something nobody named.
 */
export function readConnectPrompt(
  text: string | undefined | null,
): ConnectPrompt | null {
  if (!text?.startsWith(CONNECT_APP_MARKER)) return null;
  const rest = text.slice(CONNECT_APP_MARKER.length);
  const end = rest.indexOf("}");
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(rest.slice(0, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const { serverId, title } = parsed as {
      serverId?: unknown;
      title?: unknown;
    };
    if (typeof serverId !== "string" || typeof title !== "string") return null;
    if (!serverId || !title) return null;
    return { serverId, title, message: rest.slice(end + 1).trim() };
  } catch {
    return null;
  }
}
