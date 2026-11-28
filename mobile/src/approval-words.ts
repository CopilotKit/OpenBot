/**
 * An approval in the words the person reads on the web: what the Bot wants to do, the change it would
 * make (before, after, and who it reaches), why it asks, and which answers it takes.
 *
 * The phone listed every approval as "general-assistant asks to use
 * openbot-settings/update_organization_settings" over its arguments as JSON (`{"settings":
 * {"proactiveDailyRuns": 22}}`), and offered "Always allow this scope" on a change the organization
 * set to ask every time, which the server refuses. These are copies of what the web reads
 * (shared/tool-name.ts `approvalPhrase` and `approvalDetails`, shared/standing-rule.ts
 * `offersStandingRule`, app/src/components/settings-tools/settings-change-card.tsx
 * `settingsChangeOf` and `changeRows`): the phone is its own package and does not import shared/.
 * tests/approval-words.test.ts holds each copy to the original. Apart from the screen so it is
 * testable without React Native.
 */

/** What an approval is about, as the API sends it. Only what is read here. */
export type ApprovalActionWords = {
  botId: string;
  toolRef: string;
  scope: string;
  args?: unknown;
  target?: unknown;
  account?: string;
  policy?: {
    source: string;
    behaviour?: string;
    reason?: string;
    closed?: boolean;
  };
};

/** OpenBot's own settings app (`SETTINGS_APP` on the server). */
const SETTINGS_APP = "openbot-settings";

/**
 * What a change to OpenBot's settings asks to do, said whole: "change your settings", "change
 * Scout's settings", "invite someone to your organization". Undefined for a tool this doesn't know.
 * A copy of `settingsAsk` in shared/tool-name.ts.
 */
function settingsAsk(
  tool: string,
  args: unknown,
  target: unknown,
): string | undefined {
  const asked =
    args && typeof args === "object"
      ? (args as { action?: unknown }).action
      : undefined;
  switch (tool) {
    case "update_my_settings":
      return "change your settings";
    case "update_my_bot": {
      const change =
        target && typeof target === "object"
          ? (target as { change?: { bot?: { name?: unknown } } }).change
          : undefined;
      const name =
        typeof change?.bot?.name === "string" ? change.bot.name.trim() : "";
      return name ? `change ${name}'s settings` : "change a Bot's settings";
    }
    case "update_organization_settings":
      return "change your organization's settings";
    case "manage_people":
      return (
        {
          invite: "invite someone to your organization",
          change_role: "change someone's role in your organization",
          remove: "remove someone from your organization",
        }[String(asked)] ?? "change people in your organization"
      );
    case "manage_teams":
      return (
        {
          create: "create a team",
          rename: "rename a team",
          move: "move a team",
          add_member: "add someone to a team",
          remove_member: "take someone out of a team",
        }[String(asked)] ?? "change your organization's teams"
      );
    default:
      return undefined;
  }
}

/** `send_email` as "send email", `getRequest` as "get request". */
function words(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

/**
 * What the Bot asks to do: "change your organization's settings" for a settings change, as the web
 * card says it; otherwise the action in words on where it acts, "send email on gmail".
 */
export function approvalAsk(action: ApprovalActionWords): string {
  if (action.toolRef.startsWith(`${SETTINGS_APP}/`)) {
    const ask = settingsAsk(
      action.toolRef.slice(SETTINGS_APP.length + 1),
      action.args,
      action.target,
    );
    if (ask) return ask;
  }
  const slash = action.toolRef.indexOf("/");
  const tool = slash > 0 ? action.toolRef.slice(slash + 1) : action.toolRef;
  const said = words(tool.replace(/^computer_|^host_/, "")) || action.toolRef;
  const from = action.account ? ` from ${action.account}` : "";
  return action.scope ? `${said}${from} on ${action.scope}` : `${said}${from}`;
}

/** The card's title: "General Assistant wants to change your organization's settings". */
export function approvalTitle(
  action: ApprovalActionWords,
  botName: string | undefined,
): string {
  return `${botName?.trim() || "Your Bot"} wants to ${approvalAsk(action)}`;
}

/**
 * Whether an approval may be answered "Always allow": not when the organization set its kind to ask
 * every time (`closed`), not for a check-in task's, not for a hand-off. A copy of shared/standing-rule.ts.
 */
export function offersStandingRule(action: ApprovalActionWords): boolean {
  const policy = action.policy;
  return (
    policy?.source !== "task" &&
    policy?.closed !== true &&
    policy?.behaviour !== "hand_off"
  );
}

/** The answers the phone offers, in the order it shows them. */
export type PhoneDecision = "allow_once" | "allow_always" | "deny";
export const DECISION_LABELS: Record<PhoneDecision, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow this scope",
  deny: "Deny",
};
export function approvalChoices(action: ApprovalActionWords): PhoneDecision[] {
  return offersStandingRule(action)
    ? ["allow_once", "allow_always", "deny"]
    : ["allow_once", "deny"];
}

/** One row of a change: the setting's name on its screen, and its value before and after, in words. */
export type ChangeRow = {
  label: string;
  before: string | null;
  after: string | null;
};

/** A settings change as the approval carries it (`target.change`). */
export type ApprovalChange = {
  summary: string;
  rows: ChangeRow[];
  /** Who it reaches: the sentence, up to 12 people by name, and how many more. */
  affected?: { summary: string; people: string[]; more: number };
};

/** A key as a label: `standingInstructions` reads "Standing instructions". */
function labelOf(key: string): string {
  const said = words(key);
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** A value in words, as the web card says it. */
function inWords(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? null : value.map(inWords).join(", ");
  return JSON.stringify(value);
}

/** The change a settings approval would make, or null when it isn't one. */
export function approvalChange(target: unknown): ApprovalChange | null {
  const value =
    target && typeof target === "object"
      ? (target as { change?: unknown }).change
      : undefined;
  if (!value || typeof value !== "object") return null;
  const change = value as Record<string, unknown>;
  if (typeof change.summary !== "string") return null;
  const given = Array.isArray(change.changes)
    ? change.changes.flatMap((row): ChangeRow[] => {
        if (!row || typeof row !== "object") return [];
        const { label, before, after } = row as Record<string, unknown>;
        if (typeof label !== "string") return [];
        return [
          {
            label,
            before: typeof before === "string" ? before : null,
            after: typeof after === "string" ? after : null,
          },
        ];
      })
    : [];
  const rows =
    given.length > 0 ? given : differing(change.before, change.after);
  return {
    summary: change.summary,
    rows,
    ...affectedOf(change.affected),
  };
}

/** The top-level values of before and after that differ, when the server sent no rows. */
function differing(beforeValue: unknown, afterValue: unknown): ChangeRow[] {
  const before =
    beforeValue && typeof beforeValue === "object"
      ? (beforeValue as Record<string, unknown>)
      : {};
  const after =
    afterValue && typeof afterValue === "object"
      ? (afterValue as Record<string, unknown>)
      : {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => inWords(before[key]) !== inWords(after[key]))
    .map((key) => ({
      label: labelOf(key),
      before: inWords(before[key]),
      after: inWords(after[key]),
    }));
}

function affectedOf(value: unknown): Pick<ApprovalChange, "affected"> {
  if (typeof value === "string")
    return { affected: { summary: value, people: [], more: 0 } };
  if (!value || typeof value !== "object") return {};
  const { summary, count, people } = value as Record<string, unknown>;
  if (typeof summary !== "string") return {};
  const named = Array.isArray(people)
    ? people.flatMap((person) =>
        person &&
        typeof person === "object" &&
        typeof (person as { name?: unknown }).name === "string"
          ? [(person as { name: string }).name]
          : [],
      )
    : [];
  const total = typeof count === "number" ? count : named.length;
  return {
    affected: {
      summary,
      people: named,
      more: Math.max(0, total - named.length),
    },
  };
}

/** Handles the model cites and the run carries, which name nothing a person could check. */
const INTERNAL_ARGS = new Set([
  "ref",
  "snapshotId",
  "toolCallId",
  "signal",
  "contentDigest",
]);

/** Argument words a person reads in capitals. */
const ACRONYMS: Record<string, string> = { url: "URL", id: "ID" };

/**
 * What an action would send, as labelled lines, for an approval that carries no change: "Text: hello",
 * "To: sam@example.test". A copy of `approvalDetails` in shared/tool-name.ts.
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
    const said = words(key)
      .split(" ")
      .filter(Boolean)
      .map((word) => ACRONYMS[word] ?? word)
      .join(" ");
    const label = said ? said.charAt(0).toUpperCase() + said.slice(1) : key;
    return [{ label, value: text }];
  });
}
