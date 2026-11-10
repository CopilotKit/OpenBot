/**
 * "What would happen if…": one action a Bot might take, and what each of OpenBot's controls decides
 * about it.
 *
 * One shape for both ends. The server reads an admin's question into a {@link WhatIfAction} with the
 * deployment's model, checks it against what this OpenBot has, and runs the real deciders on it in the
 * order the product applies them (`server/src/what-if-check.ts`). The Admin page draws the action as
 * chips the admin can change, and the answer as one row per control.
 */

/** What started the run. The kinds a person can ask about: `deployment` is OpenBot itself. */
export const WHAT_IF_INITIATORS = [
  "person",
  "routine",
  "handoff",
  "responsibility",
  "memory",
] as const;
export type WhatIfInitiator = (typeof WHAT_IF_INITIATORS)[number];

/** What started the run, in words for a chip. */
export const WHAT_IF_INITIATOR_WORDS: Record<WhatIfInitiator, string> = {
  person: "A person chatting",
  routine: "A routine",
  handoff: "Another Bot",
  responsibility: "A goal it watches",
  memory: "A follow-up it set",
};

/** What a computer action does: the boundary's own `intent`, less the two an app call has. */
export const WHAT_IF_INTENTS = [
  "navigate",
  "activate",
  "type",
  "read",
  "read_file",
  "write_file",
  "list_files",
  "download_file",
  "run_command",
] as const;
export type WhatIfIntent = (typeof WHAT_IF_INTENTS)[number];

export const WHAT_IF_INTENT_WORDS: Record<WhatIfIntent, string> = {
  navigate: "Open a page",
  activate: "Press a button or link",
  type: "Type into a field",
  read: "Read a page",
  read_file: "Read a file",
  write_file: "Save a file",
  list_files: "List files",
  download_file: "Download a file",
  run_command: "Run a command",
};

/**
 * One action a Bot might take, as the deciders are asked about it.
 *
 * Who: a Bot, and either a person whose accounts and authority the run uses, or a group, for "any
 * member of it". What started the run. Then either an app's tool, or something on the Bot's computer
 * with the page it is on. `effect` is never chosen: it is the app's own classification of the tool,
 * the one a real call is judged by, and the server fills it in.
 */
export type WhatIfAction = {
  bot: string;
  person: string;
  group: string;
  initiator: WhatIfInitiator;
  surface: "app" | "computer";
  /** The app's id on this OpenBot. App calls only. */
  app: string;
  /** The tool's own name. App calls only. */
  tool: string;
  /** Computer actions only. */
  intent: WhatIfIntent | "";
  /** The page's host, such as `mail.google.com`. Computer actions only; empty for a file or a command. */
  host: string;
  /** The label of the button or field, for a press or a type. Optional. */
  label: string;
  /** The command, for a command. Optional. */
  command: string;
  /** The file's path, for a file action. Optional. */
  file: string;
};

export const EMPTY_WHAT_IF_ACTION: WhatIfAction = {
  bot: "",
  person: "",
  group: "",
  initiator: "person",
  surface: "app",
  app: "",
  tool: "",
  intent: "",
  host: "",
  label: "",
  command: "",
  file: "",
};

/** The controls, in no particular order: each surface lists the ones that apply to it in its own. */
export type WhatIfLayerId =
  | "grant"
  | "app_allowlist"
  | "capabilities"
  | "network"
  | "boundaries"
  | "safety"
  | "approvals";

/**
 * What one control says.
 *
 * `refuses` stops the action. `asks` and `hands_off` stop it until a person answers or does it
 * themselves. `trial` is a boundary in trial mode: it would refuse, records that, and lets the action
 * through. `allows` lets it past this control.
 */
export type WhatIfVerdict =
  | "allows"
  | "refuses"
  | "asks"
  | "hands_off"
  | "trial";

export type WhatIfLayer = {
  id: WhatIfLayerId;
  title: string;
  verdict: WhatIfVerdict;
  /** One sentence: what this control says about the action, and why. */
  summary: string;
  /** The rule, grant or switch that decided it, by name where it has one. */
  basis?: string;
  /** The rule as written, where it is a rule. */
  rule?: string;
  /** Where an admin changes it. Absent for what is built in and can't be changed. */
  page?: WhatIfPage;
  /** This control is the one that settles the action. */
  decides: boolean;
  /** An earlier control already stopped the action, so a real one never gets here. */
  unreached: boolean;
  /** Something this control would check that a what-if can't know. */
  caveat?: string;
};

/** The Admin pages a control is set on, by route. */
export type WhatIfPage =
  | "/admin/plugins"
  | "/admin/permissions"
  | "/admin/computers"
  | "/admin/boundaries"
  | "/admin/approvals";

export type WhatIfOutcome = "allowed" | "refused" | "asks" | "hands_off";

export type WhatIfResult = {
  outcome: WhatIfOutcome;
  /** The control that settles it. Null when every control lets it through. */
  decidedBy: WhatIfLayerId | null;
  /** One line: the outcome, and the control that settles it. */
  headline: string;
  /** The controls that apply to this kind of action, in the order the product applies them. */
  layers: WhatIfLayer[];
  /** The controls that don't apply to this kind of action, by title. */
  notApplicable: string[];
  /** What a real action is also checked for that depends on what it sends, so a what-if can't say. */
  notChecked: string[];
  /** The app's own classification of the tool. App calls only. */
  effect?: "read" | "write";
};

/** The names a chip shows for the values in an action. */
export type WhatIfLabels = {
  bot?: string;
  person?: string;
  group?: string;
  app?: string;
};

/** What this OpenBot has that an action can name: the only values a chip may hold. */
export type WhatIfVocabulary = {
  bots: { id: string; name: string; owner: string | null }[];
  people: { id: string; name: string | null; email: string }[];
  groups: string[];
  apps: {
    id: string;
    name: string;
    /** Each tool as a call to it is judged: whether it changes something, and whether the app marks it destructive. */
    tools: { name: string; effect: "read" | "write"; destructive: boolean }[];
  }[];
};

/** What an audit row recorded, beside today's answer, for "Why did this happen?". */
export type WhatIfRecorded = {
  outcome: WhatIfOutcome | "failed";
  /** The control the row says stopped it, where the row says. */
  layer: WhatIfLayerId | null;
  /** What the row says, in a sentence. */
  summary: string;
};

/** The longest a label, a command or a path may be. */
export const WHAT_IF_DETAIL_LIMIT = 300;

/** What a Bot does on a web page, which has no meaning without the page. */
export const WHAT_IF_IN_THE_BROWSER: ReadonlySet<string> = new Set([
  "navigate",
  "activate",
  "type",
  "read",
]);

/** The rows "Why did this happen?" can answer: the ones the controls decided. */
export const WHAT_IF_EXPLAINABLE_EVENT_TYPES = [
  "mcp.call_succeeded",
  "mcp.call_failed",
  "mcp.call_rejected",
  "computer.action_allowed",
  "computer.action_refused",
  "computer.action_failed",
  "computer.action_stopped",
] as const;

/**
 * Whether "Why did this happen?" can answer for a row: a computer action or an app call a Bot took.
 * Not a folder action on the person's own computer (`host/…`), which its folder grant and the
 * desktop's own asking decide, never these controls.
 */
export function whatIfExplainable(event: {
  eventType: string;
  payload?: Record<string, unknown> | null;
}): boolean {
  if (
    !(WHAT_IF_EXPLAINABLE_EVENT_TYPES as readonly string[]).includes(
      event.eventType,
    )
  )
    return false;
  const payload = event.payload ?? {};
  if (typeof payload.bot !== "string" || payload.bot === "") return false;
  return !(
    typeof payload.action === "string" && payload.action.startsWith("host/")
  );
}

/** A host name from what the model wrote: a bare host, or one inside an address. Null when neither. */
export function hostIn(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`,
    );
    // As the gateway's `hostOf` reads a page: no root dot, and the port where there is one.
    const name = url.hostname.replace(/\.+$/, "");
    host = url.port ? `${name}:${url.port}` : name;
  } catch {
    return null;
  }
  return host && /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/.test(host)
    ? host
    : null;
}

/** The names a chip shows for the values in an action. */
export function labelsFor(
  action: WhatIfAction,
  vocabulary: WhatIfVocabulary,
): WhatIfLabels {
  const labels: WhatIfLabels = {};
  const bot = vocabulary.bots.find((entry) => entry.id === action.bot);
  if (bot) labels.bot = bot.name;
  const person = vocabulary.people.find((entry) => entry.id === action.person);
  if (person) labels.person = person.name ?? person.email;
  if (action.group) labels.group = action.group;
  const app = vocabulary.apps.find((entry) => entry.id === action.app);
  if (app) labels.app = app.name;
  return labels;
}

/** What is still missing before an action can be checked, in a sentence for the admin. Null when nothing. */
export function missingFrom(
  action: WhatIfAction,
  vocabulary: WhatIfVocabulary,
): string | null {
  if (!vocabulary.bots.some((bot) => bot.id === action.bot))
    return "Choose a Bot.";
  if (action.person && action.group)
    return "Choose a person or a group, not both.";
  if (
    !(
      (action.person &&
        vocabulary.people.some((person) => person.id === action.person)) ||
      (action.group && vocabulary.groups.includes(action.group))
    )
  )
    return "Choose whose account it runs on.";
  if (!(WHAT_IF_INITIATORS as readonly string[]).includes(action.initiator))
    return "Choose what starts the run.";
  if (action.surface === "app") {
    const app = vocabulary.apps.find((entry) => entry.id === action.app);
    if (!app) return "Choose an app.";
    if (!app.tools.some((tool) => tool.name === action.tool))
      return "Choose one of the app's tools.";
    return null;
  }
  if (action.surface !== "computer") return "Choose an app or the computer.";
  if (!(WHAT_IF_INTENTS as readonly string[]).includes(action.intent))
    return "Choose what the Bot does on its computer.";
  if (action.host && !hostIn(action.host))
    return "Enter a web site, such as www.linkedin.com.";
  if (WHAT_IF_IN_THE_BROWSER.has(action.intent) && !action.host)
    return "Enter the web site it's on.";
  for (const field of ["label", "command", "file"] as const)
    if (action[field].length > WHAT_IF_DETAIL_LIMIT)
      return `Keep the ${field} under ${WHAT_IF_DETAIL_LIMIT} characters.`;
  return null;
}
