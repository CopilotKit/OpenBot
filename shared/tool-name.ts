import { OFFER_CHECK_IN_TOOL } from "./check-in-offer";
import { SHOW_APP_ACCESS_TOOL } from "./connect-prompt";
import { RESEARCH_ROLE_LABELS, researchRoleOfTool } from "./research";
import { SUBAGENT_TOOL } from "./subagent";
import { SEARCH_TOOLS } from "./tool-search";

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
  return appToolName(rawServer ?? "", rest.join("__"));
}

/**
 * One app's tool, from its server key and the tool's own name: what `readToolName` reads out of an
 * `mcp__server__tool` name, and what an approval is asked about as `server/tool`.
 */
export function appToolName(server: string, tool: string): ToolName {
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
  /*
   * A vendor that leads its own tool names with its name (`notion-fetch`) is named once, as the
   * app, beside the action, the way a brokered app is: "Fetch" on Notion, not "Notion fetch notion".
   */
  const serverLead = wordsOf(server);
  const toolLead = wordsOf(tool);
  if (
    toolLead.length > serverLead.length &&
    serverLead.every((word, index) => toolLead[index] === word)
  )
    return {
      label: humanise(toolLead.slice(serverLead.length).join(" ")),
      detail: connectorName(server),
    };
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
 * What an approval asks to do and where, as its card says it: "Waiting for your approval: {action}
 * on {place}", and "{Bot} wants to {action}" over the place on a list.
 *
 * An app's tool is asked about as `<app>/<tool>` on the app itself (`toolRef` and `scope` in
 * server/src/plugins/plugin-store/calls.ts), so it read "requests/get request on requests": the app's
 * key twice and the tool's raw name. It is named the way the conversation names the same call, the
 * action in words and the app by its name, so the card reads "get request on Requests". Every other
 * action keeps the words it had: a computer's on the site or folder it acts on, a command on the
 * computer it runs on.
 */
export function approvalWords(action: { toolRef: string; scope: string }): {
  action: string;
  place: string;
} {
  const slash = action.toolRef.indexOf("/");
  const app = action.toolRef.slice(0, slash);
  if (slash > 0 && app === action.scope) {
    const { label } = appToolName(app, action.toolRef.slice(slash + 1));
    return {
      action: label.charAt(0).toLowerCase() + label.slice(1),
      place: connectorName(app),
    };
  }
  return {
    action: action.toolRef
      .replace(/^computer_|^host\//, "")
      .replaceAll("_", " "),
    place: action.scope,
  };
}

type OwnTool = {
  running: string;
  done: string;
  /**
   * What it was given and what it answered were both written for the model (a tool search's query
   * and limit), so its step in a folded group says what it did and does not open.
   */
  answersTheModel?: true;
};

/**
 * The tools OpenBot itself offers a Bot, named in words somebody chose.
 *
 * These are not MCP names, so nothing above rewrites them, and the bare identifier is what a line
 * would otherwise say: "show_app_access", shimmering, while the Bot works out what an app is for the
 * person. Named twice, for the moment and for afterwards, because a line is drawn while it runs AND
 * left on screen once done.
 *
 * EVERY ONE OF THEM, including those the app draws a card for. A card is the usual picture, but the
 * same call is also a step inside a subtask, a line in a conversation opened where its card is not
 * registered, and a line in a run with no browser at all. `server/tests/built-in-tool-labels.test.ts`
 * reads every tool OpenBot registers and fails on one missing here.
 */
const OWN_TOOLS: Record<string, OwnTool> = {
  [SHOW_APP_ACCESS_TOOL]: {
    running: "Checking app access",
    done: "Checked app access",
    answersTheModel: true,
  },
  [SEARCH_TOOLS]: {
    running: "Looking for a tool",
    done: "Looked for a tool",
    answersTheModel: true,
  },

  // Bringing someone else in.
  ask_person: { running: "Asking you", done: "Asked you" },
  message_bot: { running: "Asking another Bot", done: "Asked another Bot" },
  [SUBAGENT_TOOL]: { running: "Working on a subtask", done: "Ran a subtask" },
  // A voice conversation handing what was said to the Bot behind it.
  ask_agent: { running: "Asking the Bot", done: "Asked the Bot" },

  // Skills: the ones it learned, and the ones a person writes with it.
  copilotkit_load_skill: { running: "Using a skill", done: "Used a skill" },
  copilotkit_read_skill_file: {
    running: "Reading a file from a skill",
    done: "Read a file from a skill",
  },
  list_skills: {
    running: "Checking existing skills",
    done: "Checked existing skills",
  },
  read_skill: { running: "Reading a skill", done: "Read a skill" },
  list_skill_tools: {
    running: "Checking available tools",
    done: "Checked available tools",
  },
  save_skill: { running: "Proposing a skill", done: "Proposed a skill" },

  /*
   * Drawing a generated interface in the conversation. The runtime offers it, not an OpenBot
   * registration, so `built-in-tool-labels.test.ts` cannot find it; its words go here by hand.
   */
  render_ui: { running: "Drawing an interface", done: "Drew an interface" },

  // Making a Bot from a conversation.
  list_bots: {
    running: "Checking existing Bots",
    done: "Checked existing Bots",
  },
  read_bot: {
    running: "Reading a Bot's instructions",
    done: "Read a Bot's instructions",
  },
  list_bot_skills: {
    running: "Checking available skills",
    done: "Checked available skills",
  },
  save_bot: { running: "Proposing a new Bot", done: "Proposed a new Bot" },

  // Its memory of you.
  recall_personal_memory: {
    running: "Checking its memory of you",
    done: "Checked its memory of you",
  },
  remember_personal_fact: {
    running: "Saving a memory",
    done: "Saved a memory",
  },
  save_observed_memory: {
    running: "Noting something about you",
    done: "Noted something about you",
  },
  form_memory: {
    running: "Noting something about you",
    done: "Noted something about you",
  },
  forget_personal_memory: {
    running: "Forgetting a memory",
    done: "Forgot a memory",
  },

  // Follow-ups, check-ins and next steps.
  schedule_follow_up: {
    running: "Scheduling a follow-up",
    done: "Scheduled a follow-up",
  },
  list_follow_ups: {
    running: "Checking follow-ups",
    done: "Checked follow-ups",
  },
  cancel_follow_up: {
    running: "Cancelling a follow-up",
    done: "Cancelled a follow-up",
  },
  [OFFER_CHECK_IN_TOOL]: {
    running: "Offering a check-in",
    done: "Offered a check-in",
  },
  suggest_next_step: {
    running: "Suggesting a next step",
    done: "Suggested a next step",
  },
  clear_next_step: {
    running: "Clearing a next step",
    done: "Cleared a next step",
  },

  // Responsibilities.
  create_responsibility: {
    running: "Creating a responsibility",
    done: "Created a responsibility",
  },
  list_responsibilities: {
    running: "Checking responsibilities",
    done: "Checked responsibilities",
  },
  update_responsibility: {
    running: "Updating a responsibility",
    done: "Updated a responsibility",
  },
  report_responsibility_progress: {
    running: "Recording progress",
    done: "Recorded progress",
  },
  run_responsibility: {
    running: "Starting a responsibility",
    done: "Started a responsibility",
  },
  pause_responsibility: {
    running: "Pausing a responsibility",
    done: "Paused a responsibility",
  },
  resume_responsibility: {
    running: "Resuming a responsibility",
    done: "Resumed a responsibility",
  },
  complete_responsibility: {
    running: "Marking a responsibility complete",
    done: "Marked a responsibility complete",
  },

  // The browser. A folded group names these steps in the same words (`browser-activity.ts`).
  computer_navigate: { running: "Opening page", done: "Opened page" },
  computer_read: { running: "Reading page", done: "Read page" },
  computer_snapshot: { running: "Inspecting page", done: "Inspected page" },
  computer_click: { running: "Clicking on page", done: "Clicked on page" },
  computer_type: { running: "Filling in field", done: "Filled in field" },
  computer_key: { running: "Pressing key", done: "Pressed key" },
  computer_scroll: { running: "Scrolling page", done: "Scrolled page" },
  computer_screenshot: {
    running: "Taking a screenshot",
    done: "Took a screenshot",
  },

  // The Bot's computer, and folders on yours. The same action reads the same on either.
  computer_list_files: { running: "Listing files", done: "Listed files" },
  computer_read_file: { running: "Reading a file", done: "Read a file" },
  computer_write_file: { running: "Saving a file", done: "Saved a file" },
  computer_run_command: { running: "Running a command", done: "Ran a command" },
  host_list_folders: {
    running: "Checking your folders",
    done: "Checked your folders",
  },
  host_list_files: { running: "Listing files", done: "Listed files" },
  host_read_file: { running: "Reading a file", done: "Read a file" },
  host_write_file: { running: "Saving a file", done: "Saved a file" },
  host_run_command: { running: "Running a command", done: "Ran a command" },

  // Asking the person, from the computer.
  computer_request_help: {
    running: "Asking you for help",
    done: "Asked you for help",
  },
  computer_request_secret: {
    running: "Waiting for you to fill in a field",
    done: "Asked you to fill in a field",
  },
  computer_request_sign_in: {
    running: "Waiting for you to sign in",
    done: "Asked you to sign in",
  },
  report_refusal: {
    running: "Noting a declined request",
    done: "Noted a declined request",
  },
};

/** One of OpenBot's own tools in words, or null for any other name. */
export function ownToolLabel(name: string, running = false): string | null {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  if (!own) return null;
  return running ? own.running : own.done;
}

/** Whether a step's arguments and answer were written for the model and are not shown to the person. */
export function answersTheModel(name: string): boolean {
  return (
    Object.hasOwn(OWN_TOOLS, name) && OWN_TOOLS[name]?.answersTheModel === true
  );
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
