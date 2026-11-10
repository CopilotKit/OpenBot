import { OFFER_CHECK_IN_TOOL } from "./check-in-offer";
import { SHOW_APP_ACCESS_TOOL } from "./connect-prompt";
import { RESEARCH_ROLE_LABELS, researchRoleOfTool } from "./research";
import { SUBAGENT_TOOL } from "./subagent";
import { lowerFirst, nameInWords } from "./tool-name-words";
import { SEARCH_TOOLS } from "./tool-search";

/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * ANY OTHER NAME IS PUT IN WORDS TOO, never drawn as it came. A line is drawn the moment a call
 * starts, before its arguments and before the app's own renderer for it may have loaded, so its name
 * is all there is to say. FOUND LIVE: a Bot first called `web_search`, a name it was never offered,
 * and its line read "web_search" until the real search joined it. A component the app draws
 * (`showBarChart`) reads "Show bar chart" while its renderer is not there yet, and a name with no
 * words in it reads as a tool being used.
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
  if (parts.length < 3 || parts[0] !== "mcp")
    return {
      label:
        wordsOf(name).length > 0
          ? humanise(name)
          : running
            ? "Using a tool"
            : "Used a tool",
    };

  const [, rawServer, ...rest] = parts;
  /*
   * OpenBot's own Routines app also carries a goal's tools for a conversation. They are the tools a
   * goal's run holds, so they read in its words, "Created a goal", and not "Create goal" beside
   * "routines".
   */
  if (rawServer === ROUTINES_APP) {
    const goal = ownToolLabel(rest.join("__"), running);
    if (goal) return { label: goal };
  }
  return appToolName(rawServer ?? "", rest.join("__"));
}

/** The key of OpenBot's own Routines app (`ALWAYS_ON_APP` on the server). */
const ROUTINES_APP = "routines";

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
      label: nameInWords(
        action.length > 0 ? humanise(action.join(" ")) : humanise(tool),
      ),
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
      label: nameInWords(humanise(toolLead.slice(serverLead.length).join(" "))),
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
  const said = nameInWords(label);
  return named ? { label: said } : { label: said, detail: server };
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
export function approvalWords(action: {
  toolRef: string;
  scope: string;
  /** What the action is aimed at, as the server resolved it. A folder's carries its name. */
  target?: unknown;
  /** Which of the person's accounts at the app, where they hold several: "from dana@work.example". */
  account?: string;
}): {
  action: string;
  place: string;
} {
  const { action: words, place } = approvalParts(action);
  return { action: words, place };
}

/**
 * What an approval waits on as one phrase, for a card's title and a task's waiting line: "send
 * email on Gmail", "click on example.com", and a file as its step and its Activity row name it,
 * "save a file todo.txt in share". A step on a whole folder is "in" it.
 */
export function approvalPhrase(action: {
  toolRef: string;
  scope: string;
  target?: unknown;
  /** Which of the person's accounts at the app, where they hold several: "from dana@work.example". */
  account?: string;
}): string {
  const { action: words, place, joiner } = approvalParts(action);
  return joiner ? `${words} ${joiner} ${place}` : `${words} ${place}`;
}

function approvalParts(action: {
  toolRef: string;
  scope: string;
  target?: unknown;
  account?: string;
}): { action: string; place: string; joiner: "on" | "in" | "" } {
  const slash = action.toolRef.indexOf("/");
  const app = action.toolRef.slice(0, slash);
  if (slash > 0 && app === action.scope) {
    const { label } = appToolName(app, action.toolRef.slice(slash + 1));
    const words = lowerFirst(label);
    return {
      action: action.account ? `${words} from ${action.account}` : words,
      place: connectorName(app),
      joiner: "on",
    };
  }
  /*
   * A browser action on the site it acts on, with the control it presses when the page named one:
   * "click the link “Python” on en.wikipedia.org". Activity said "Approve computer_click".
   */
  const browser = browserAction(action.toolRef, action.target);
  if (browser) return { action: browser, place: action.scope, joiner: "on" };
  /*
   * A computer's or a folder's own action in the words its step and its Activity row use. The card
   * said "write file on todo.txt in share" above a step that read "Save a file todo.txt in share".
   */
  const own = ownToolAttempt(action.toolRef.replace(/^host\//, "host_"));
  const words = own
    ? lowerFirst(own)
    : action.toolRef.replace(/^computer_|^host\//, "").replaceAll("_", " ");
  /*
   * A folder on the person's computer by the name Settings > Computer shows. Its scope is the id
   * OpenBot gave the grant, which kept a rule saved from the card on that grant, and read on the
   * card as "write file on host-grant-15407-1794112361547002000".
   */
  if (action.toolRef.startsWith("host/")) {
    const file = folderFile(action.target);
    const folder = folderName(action.target);
    // "save a file todo.txt in share"; a command or a listing is in the folder itself.
    if (file)
      return {
        action: words,
        place: inFolder(file, folder) ?? file,
        joiner: "",
      };
    if (folder) return { action: words, place: folder, joiner: "in" };
  }
  // A file on the Bot's own computer by its path, as its step names it, not the folder it is in.
  const path = computerFile(action.target);
  if (path) return { action: words, place: path, joiner: "" };
  return { action: words, place: action.scope, joiner: "on" };
}

/** Handles the model cites and the run carries, which name nothing a person could check. */
const INTERNAL_ARGS = new Set(["ref", "snapshotId", "toolCallId", "signal"]);

/**
 * What an approval would send, as labelled lines for its card: "Text: hello", "To: sam@example.test".
 * The card showed the arguments as JSON, and a click read `{ "ref": "f3e43", "snapshotId": 4 }`, two
 * handles to a page snapshot nobody can see. Those are left out, so a click has nothing to add to its
 * title and shows no lines at all. Everything else stays whole: nobody allows what they were not shown.
 */
export function approvalDetails(
  args: unknown,
): { label: string; value: string }[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args).flatMap(([key, value]) => {
    if (INTERNAL_ARGS.has(key) || value === undefined || value === null)
      return [];
    const text =
      typeof value === "string"
        ? value
        : typeof value === "boolean"
          ? value
            ? "Yes"
            : "No"
          : typeof value === "number"
            ? String(value)
            : Array.isArray(value) &&
                value.every((entry) => typeof entry === "string")
              ? value.join(", ")
              : JSON.stringify(value, null, 2);
    const words = wordsOf(key)
      .map((word) => ACRONYMS[word] ?? word)
      .join(" ");
    const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
    return [{ label, value: text }];
  });
}

/** Argument words a person reads in capitals. */
const ACRONYMS: Record<string, string> = { url: "URL", id: "ID" };

/**
 * A saved approval rule's title, in the words its approval card used for the action it covers:
 * "Click", "Send email on Gmail", "Any action on Gmail". The list titled each rule by its tool id
 * ("computer_click", "mcp/gmail/*"). `place` is true when the title already names where the rule
 * applies, so the line under it need not say "on composio-gmail" again. A pattern a person typed
 * that matches several actions some other way is kept as they wrote it.
 */
export function ruleTitle(rule: { toolRef: string; scope: string }): {
  title: string;
  place: boolean;
} {
  const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (rule.toolRef === "*") return { title: "Any action", place: false };
  if (rule.toolRef === "host/*")
    return { title: "Any action in your folders", place: false };
  const ref = rule.toolRef.replace(/^mcp\//, "");
  const slash = ref.indexOf("/");
  if (slash > 0 && !ref.startsWith("host/")) {
    const app = ref.slice(0, slash);
    const tool = ref.slice(slash + 1);
    if (app.includes("*")) return { title: rule.toolRef, place: false };
    const named = rule.scope === "*" || rule.scope === app;
    if (tool === "*")
      return { title: `Any action on ${connectorName(app)}`, place: named };
    if (tool.includes("*")) return { title: rule.toolRef, place: false };
    const { action, place } = approvalWords({ toolRef: ref, scope: app });
    return { title: `${upper(action)} on ${place}`, place: named };
  }
  if (ref.includes("*")) return { title: rule.toolRef, place: false };
  return {
    title: upper(approvalWords({ toolRef: ref, scope: rule.scope }).action),
    place: false,
  };
}

/** What a browser action asks to do, said as its step says it. */
const BROWSER_ACTIONS: Record<string, string> = {
  computer_navigate: "open a page",
  computer_click: "click",
  computer_type: "fill in a field",
  computer_key: "press a key",
  computer_scroll: "scroll the page",
};

/** A page control's role in the words a person uses for it. */
const CONTROL_WORDS: Record<string, string> = {
  link: "link",
  button: "button",
  checkbox: "checkbox",
  radio: "option",
  option: "option",
  tab: "tab",
  menuitem: "menu item",
  switch: "switch",
  textbox: "field",
  searchbox: "search field",
  combobox: "list",
};

/**
 * A browser action in words, naming the control it presses from the label the server resolved
 * (`target.element`), never the ref and snapshot the model cited. Undefined for any other action.
 */
function browserAction(toolRef: string, target: unknown): string | undefined {
  const base = BROWSER_ACTIONS[toolRef];
  if (!base) return undefined;
  const element =
    target && typeof target === "object"
      ? (target as { element?: { role?: unknown; name?: unknown } }).element
      : undefined;
  const name =
    typeof element?.name === "string"
      ? element.name.replace(/\s+/g, " ").trim()
      : "";
  const role =
    typeof element?.role === "string" ? CONTROL_WORDS[element.role] : undefined;
  if (toolRef === "computer_click") {
    if (name) return `click ${role ? `the ${role} ` : ""}“${clipName(name)}”`;
    return role ? `click ${/^[aeiou]/.test(role) ? "an" : "a"} ${role}` : base;
  }
  if (toolRef === "computer_type" && name) return `fill in “${clipName(name)}”`;
  return base;
}

/** A control's label, short enough for a title. */
function clipName(name: string): string {
  const chars = Array.from(name);
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : name;
}

/** The path a file action on the Bot's own computer names (`target.filePath`), or undefined. */
function computerFile(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { filePath } = target as { filePath?: unknown };
  return typeof filePath === "string" && filePath.trim() ? filePath : undefined;
}

/**
 * A file and the folder on the person's computer it is in, said the same way on the approval card,
 * on the step and in Activity: "todo.txt in share". A step on the whole folder (a listing, a
 * command) is "in share". Undefined when neither is known.
 */
export function inFolder(
  file: string | undefined,
  folder: string | undefined,
): string | undefined {
  if (file && folder) return `${file} in ${folder}`;
  if (folder) return `in ${folder}`;
  return file || undefined;
}

/** The file a folder action's target names, or undefined for the folder itself. */
function folderFile(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { relativePath } = target as { relativePath?: unknown };
  return typeof relativePath === "string" &&
    relativePath.trim() &&
    relativePath !== "."
    ? relativePath
    : undefined;
}

/** The name of the folder a folder action's target names, or undefined. */
function folderName(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { displayName } = target as { displayName?: unknown };
  return typeof displayName === "string" && displayName.trim()
    ? displayName
    : undefined;
}

type OwnTool = {
  running: string;
  done: string;
  /**
   * What was asked for, for a step that was blocked: "Save a file", not "Saved a file". A blocked
   * step did not happen, so its line says what was tried. Without it the line keeps `done`.
   */
  attempted?: string;
  /** The argument naming what the step acted on, said beside its words: a file's path. */
  subject?: "path";
  /**
   * What it was given and what it answered were both written for the model (a tool search's query
   * and limit), so its step in a folded group says what it did and does not open.
   */
  answersTheModel?: true;
};

/** A goal's tools, under the names they are offered as. */
function goalTools(names: {
  create: string;
  list: string;
  update: string;
  report: string;
  run: string;
  pause: string;
  resume: string;
  complete: string;
}): Record<string, OwnTool> {
  return {
    [names.create]: { running: "Creating a goal", done: "Created a goal" },
    [names.list]: { running: "Checking goals", done: "Checked goals" },
    [names.update]: { running: "Updating a goal", done: "Updated a goal" },
    [names.report]: {
      running: "Recording progress",
      done: "Recorded progress",
    },
    [names.run]: { running: "Starting a goal", done: "Started a goal" },
    [names.pause]: { running: "Pausing a goal", done: "Paused a goal" },
    [names.resume]: { running: "Resuming a goal", done: "Resumed a goal" },
    [names.complete]: {
      running: "Marking a goal complete",
      done: "Marked a goal complete",
    },
  };
}

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
  // Claude Code's own search over the tools a Claude Agent SDK Bot holds, the same step as the one
  // above (`TOOL_SEARCH` in agent-claude-sdk/src/adapter.py).
  ToolSearch: {
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

  // Goals. The `*_responsibility` names are what a goal's tools were called before they said goal,
  // kept so the steps in a conversation recorded then still read as words.
  ...goalTools({
    create: "create_goal",
    list: "list_goals",
    update: "update_goal",
    report: "report_goal_progress",
    run: "run_goal",
    pause: "pause_goal",
    resume: "resume_goal",
    complete: "complete_goal",
  }),
  ...goalTools({
    create: "create_responsibility",
    list: "list_responsibilities",
    update: "update_responsibility",
    report: "report_responsibility_progress",
    run: "run_responsibility",
    pause: "pause_responsibility",
    resume: "resume_responsibility",
    complete: "complete_responsibility",
  }),

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
  computer_list_files: {
    running: "Listing files",
    done: "Listed files",
    attempted: "List files",
  },
  computer_read_file: {
    running: "Reading a file",
    done: "Read a file",
    attempted: "Read a file",
    subject: "path",
  },
  computer_write_file: {
    running: "Saving a file",
    done: "Saved a file",
    attempted: "Save a file",
    subject: "path",
  },
  computer_run_command: {
    running: "Running a command",
    done: "Ran a command",
    attempted: "Run a command",
  },
  host_list_folders: {
    running: "Checking your folders",
    done: "Checked your folders",
    attempted: "Check your folders",
  },
  host_list_files: {
    running: "Listing files",
    done: "Listed files",
    attempted: "List files",
  },
  host_read_file: {
    running: "Reading a file",
    done: "Read a file",
    attempted: "Read a file",
    subject: "path",
  },
  host_write_file: {
    running: "Saving a file",
    done: "Saved a file",
    attempted: "Save a file",
    subject: "path",
  },
  host_run_command: {
    running: "Running a command",
    done: "Ran a command",
    attempted: "Run a command",
  },

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

/**
 * What one of OpenBot's own steps asked for, for a step that was blocked and so did not happen, or
 * null when it has no words of its own for that.
 */
export function ownToolAttempt(name: string): string | null {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  return own?.attempted ?? null;
}

/**
 * What one of OpenBot's own steps acted on, read from its arguments (a JSON string while it streams,
 * or already parsed): the file a file step read or saved. Undefined for any other step, and for
 * arguments not yet complete.
 */
export function ownToolSubject(
  name: string,
  args: unknown,
): string | undefined {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  if (!own?.subject) return undefined;
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const subject = (value as Record<string, unknown>)[own.subject];
  return typeof subject === "string" && subject.trim()
    ? subject.trim()
    : undefined;
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
