/**
 * The refusal a person can act on: an app this call needed, that they have not connected — or
 * whose account the vendor has lost, or whose team account nobody has connected — and the answer of
 * the one tool that says what an app is for them without a call having been refused at all.
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

/**
 * Why the card was drawn, as the server saw it at the moment of the call.
 *
 * `connect` — this person has no account at the app. `reconnect` — they had one, and the vendor no
 * longer holds it: a grant withdrawn at the provider, an account removed in Composio's dashboard.
 * `shared` — a Shared app whose one team account is missing, which only an administrator connects.
 * `access` — the Bot asked what the app is for this person (`show_app_access`), with no refusal
 * behind it: switched off, not granted, or any of the above.
 *
 * A HINT, NOT THE STATE. The card asks the server for the app's state for this person and this Bot
 * when it is drawn, and draws that. The one place the hint wins is an account the vendor has lost
 * whose row still stands — a refusal from before the call that found out started deleting the row —
 * where the live state reads `ready` and only the refusal knows otherwise. See `AppAccessCard`.
 */
export type ConnectReason = "connect" | "reconnect" | "shared" | "access";

const REASONS: readonly ConnectReason[] = [
  "connect",
  "reconnect",
  "shared",
  "access",
];

export type ConnectPrompt = {
  /**
   * The app, as the server names it: the plugin server to connect, as
   * `POST /api/plugins/servers/:serverId/connect` names it, or the key an app nobody enabled would
   * have. What the card asks `GET /api/plugins/for/:agentId/apps/:app` about.
   */
  serverId: string;
  /** The app's own name, for a card that says what it is asking for. */
  title: string;
  /** What the Bot would have said, kept intact for a reader with no card to draw. */
  message: string;
  /**
   * The Bot whose call this was, so the card asks about the right one in a channel several Bots
   * answer in. Absent on a refusal written before it carried one, where the card falls back to the
   * Bot the surface declared.
   */
  agentId?: string;
  /** See {@link ConnectReason}. Absent reads as `connect`, which is all a refusal used to mean. */
  reason?: ConnectReason;
  /**
   * When the server refused, as an ISO instant — on a `reconnect` or `shared` refusal, the only
   * ones whose hint can outrank the live state. A connection made after this is the reconnection,
   * and the card stops saying Reconnect. See `AppAccess.connectedAt`.
   */
  at?: string;
  /**
   * True when the app could not be used at the moment the Bot asked: always so of a refusal, and
   * written by `show_app_access` from the state it found. What lets a card that is drawn already
   * `ready` tell "became ready since" — worth a Continue — from "was ready all along", which is not.
   * Absent on a `show_app_access` answer from before it was written, which offers nothing.
   */
  blocked?: boolean;
};

/**
 * The name of the tool every Bot holds for saying what an app is for the person asking.
 *
 * Here rather than beside the tool, because the transcript reads it too: that tool's answer is the
 * one ordinary result (not a refusal) whose marker is drawn as a card, and a renderer may only trust
 * a marker on a result it knows this deployment wrote.
 */
export const SHOW_APP_ACCESS_TOOL = "show_app_access";

/**
 * The refusal text a `PluginRefusedError` carries for an app the asker has not connected.
 *
 * The sentence stays in the string rather than being rebuilt by the card, because it is also what
 * the MODEL is told, and because a transcript that cannot parse the marker still reads correctly.
 */
export function connectAppRefusal(prompt: ConnectPrompt): string {
  const { serverId, title, message, agentId, reason, at, blocked } = prompt;
  return `${CONNECT_APP_MARKER}${JSON.stringify({
    serverId,
    title,
    ...(agentId ? { agentId } : {}),
    ...(reason ? { reason } : {}),
    ...(at ? { at } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  })} ${message}`;
}

/**
 * The same text with the Bot named on it, for the one caller that knows which Bot asked.
 *
 * WHY AFTERWARDS RATHER THAN AT THE SITE THAT WROTE IT. The refusals are raised deep in resolving a
 * credential, which is a question about a person and an app and never about a Bot — threading a Bot
 * id down there would be a parameter nothing else reads. The tool's own wrapper knows the Bot, so it
 * adds it on the way out. Text that is not a prompt, or already names a Bot, is returned unchanged.
 */
export function addressedTo(text: string, agentId: string): string {
  const prompt = readConnectPrompt(text);
  if (!prompt || prompt.agentId || !agentId) return text;
  return connectAppRefusal({ ...prompt, agentId });
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
    const { serverId, title, agentId, reason, at, blocked } = parsed as {
      serverId?: unknown;
      title?: unknown;
      agentId?: unknown;
      reason?: unknown;
      at?: unknown;
      blocked?: unknown;
    };
    if (typeof serverId !== "string" || typeof title !== "string") return null;
    if (!serverId || !title) return null;
    /*
     * The optional fields are dropped rather than failing the whole prompt when they are the
     * wrong shape: without them the card still names the right app and asks about the declared Bot,
     * which is what every refusal did before they existed.
     */
    return {
      serverId,
      title,
      message: rest.slice(end + 1).trim(),
      ...(typeof agentId === "string" && agentId ? { agentId } : {}),
      ...(REASONS.includes(reason as ConnectReason)
        ? { reason: reason as ConnectReason }
        : {}),
      ...(typeof at === "string" && !Number.isNaN(Date.parse(at))
        ? { at }
        : {}),
      ...(typeof blocked === "boolean" ? { blocked } : {}),
    };
  } catch {
    return null;
  }
}
