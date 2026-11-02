import { SHOW_APP_ACCESS_TOOL } from "@openbot/shared/connect-prompt";
import {
  RESEARCH_ROLE_LABELS,
  researchRoleOfTool,
} from "@openbot/shared/research";

/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

export function readToolName(name: string, running = false): ToolName {
  const own = ownToolLabel(name, running);
  if (own) return { label: own };
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return { label: name };

  const [, rawServer, ...rest] = parts;
  const server = rawServer ?? "";
  const tool = rest.join("__");
  const broker = brokeredApp(server);
  /*
   * Research is named for what it did, not for who did it. `web_search_exa` would read "Web search
   * exa", which tells the person which vendor this deployment buys search from and nothing about
   * their answer. Which provider is granted is an administrator's fact, on the Bot's access page.
   */
  const role = researchRoleOfTool(server, tool);
  if (role) return { label: RESEARCH_ROLE_LABELS[role] };
  /*
   * A BROKERED APP IS NAMED ONCE, AS THE APP, BESIDE THE ACTION. Composio publishes
   * `<APP>_<VERB>_<NOUN>`, so its app leads every action and reads as a vendor's prefix
   * ("Airtable list bases"); Arcade has already dropped its toolkit from the name. Either way the
   * action starts at the verb and the app is said once, in its own name.
   */
  if (broker) {
    const appWords = wordsOf(broker);
    const toolWords = wordsOf(tool);
    const leads = appWords.every((word, index) => toolWords[index] === word);
    const action = leads ? toolWords.slice(appWords.length) : toolWords;
    return {
      label: action.length > 0 ? humanise(action.join(" ")) : humanise(tool),
      detail: connectorName(server),
    };
  }
  const label = humanise(tool);

  /*
   * The server is dropped when the action already names it as the thing acted upon. Vendors name a
   * tool after the thing it acts on, so `mcp__notes__search_notes` would otherwise read "Search
   * notes notes" and `mcp__routines__create_routine` "Create routine routines", both of which look
   * like a bug rather than a label. A server key can itself be more than one word — `google-drive`,
   * `google_drive` — so it is split into words the same way `humanise` splits the tool name, each
   * singularised, and looked for as a contiguous run inside the label's words. Whole words in an
   * unbroken sequence, never a substring test: that is what let "Create routine routines" through in
   * the first place.
   *
   * `humanise` always puts the verb first, and that leading word is excluded from the search:
   * `mcp__posts__post_message` singularises its server to "post", which is also the tool's own verb,
   * so without this exclusion "Post message" would lose its "posts" attribution over a coincidence
   * with the verb rather than a naming of the server. Same shape for `mcp__lists__list_files`
   * against "List". Only the words after the verb describe what the action was taken on, so only
   * those are eligible to match the server.
   *
   * This does not, and cannot, catch every collision: `mcp__news__get_new_items` singularises "news"
   * to "new", which genuinely is the second word of "Get new items", so the server is still dropped
   * there. English plural heuristics cannot tell that "new" apart from the "new" in "news" — that is
   * a known limit of this rule, not a bug to chase with a word list.
   */
  const labelWords = label.toLowerCase().split(" ").map(singular);
  const wordsActedOn = labelWords.slice(1);
  const serverWords = wordsOf(server).map(singular);
  const named = containsPhrase(wordsActedOn, serverWords);
  return named ? { label } : { label, detail: server };
}

/**
 * The connector a server key names, the way a person would say it: "google-drive" as "Google
 * Drive", and a broker's "composio-airtable" or "arcade-Gmail" as the app alone.
 */
export function connectorName(server: string): string {
  return wordsOf(brokeredApp(server) ?? server)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The tools every Bot holds that this deployment wrote itself, named in words somebody chose.
 *
 * These are not MCP names, so nothing above rewrites them, and the bare identifier is what a line
 * would otherwise say: "show_app_access", shimmering, while the Bot works out what an app is for the
 * person. Named twice, for the moment and for afterwards, because only these lines are drawn while
 * running AND left on screen once done.
 */
const OWN_TOOLS: Record<string, { running: string; done: string }> = {
  [SHOW_APP_ACCESS_TOOL]: {
    running: "Checking app access",
    done: "Checked app access",
  },
};

/** One of this deployment's own tools in words, or null for any other name. */
export function ownToolLabel(name: string, running = false): string | null {
  const own = OWN_TOOLS[name];
  if (!own) return null;
  return running ? own.running : own.done;
}

/**
 * The app behind a brokered server key, or null for a server this deployment dials itself.
 *
 * A brokered server is keyed `<broker>-<app>` — `composio-gmail`, `arcade-Gmail` — because the broker is how the
 * credential is held and two brokers could both offer Gmail. Neither of those is the reader's
 * business: they asked their Bot about their email, not about which company holds the grant. This
 * is the same argument the research relabelling above makes, and the answer is the same — which
 * broker a deployment buys through is an administrator's fact, on the Bot's access page.
 *
 * Only the prefix is removed, never the app. "Gmail" is what was acted upon and stays legible.
 */
function brokeredApp(server: string): string | null {
  for (const prefix of BROKER_PREFIXES) {
    if (!server.startsWith(prefix)) continue;
    const app = server.slice(prefix.length);
    return app.length > 0 ? app : null;
  }
  return null;
}

/** The brokers whose apps this deployment keys `<broker>-<app>`. See `server/src/plugins/access.ts`. */
const BROKER_PREFIXES = ["composio-", "arcade-"] as const;

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
export function humanise(tool: string): string {
  const words = wordsOf(tool).join(" ");
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `google-drive`, `google_drive` and `googleDrive` all split to the same `["google", "drive"]`.
 *
 * The same splitting `humanise` does for a tool name, pulled out so a server key can be broken into
 * words too rather than compared as one opaque token.
 */
function wordsOf(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Whether `needle` occurs in `haystack` as a run of whole words, in order and unbroken.
 *
 * This is the whole-word alternative to a substring test: `["routine"]` must line up with a word
 * in `["create", "routine"]`, not merely appear inside one of its letters.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word))
      return true;
  }
  return false;
}
