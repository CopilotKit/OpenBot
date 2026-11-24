/**
 * What the settings MCP's admin write tools answer with (`update_organization_settings`,
 * `manage_people`, `manage_teams`): the structured result each tool's output schema describes, and
 * the same shape as the preview its approval card shows before anything is written.
 *
 * Everything a card draws is in it, so the card reads the same live and after a reload, and makes
 * no second request. Read tolerantly: a field this app doesn't know is ignored, and a result that
 * isn't one of these is not drawn as one ({@link adminResultOf}).
 */

export type ChangeLine = {
  /** What changed, as the Admin screens name it. */
  label: string;
  /** How it read before. Null when it didn't exist. */
  before: string | null;
  /** How it reads now. Null when it was removed. */
  after: string | null;
};

export type AffectedPerson = {
  name: string;
  email: string;
  effect?: "gains" | "loses" | "changes" | "joins" | "leaves";
};

export type Affected = {
  summary: string;
  count: number;
  /** At most 12; the rest are counted in `count`. */
  people: AffectedPerson[];
};

export type AdminScreen = { label: string; path: string };

/** What a change does and who it reaches: the part of a result the approval card shows too. */
export type ChangeView = {
  summary: string;
  changes: ChangeLine[];
  affected: Affected;
};

type Common = ChangeView & {
  organization: string;
  screens: AdminScreen[];
};

export type OrganizationSettingsResult = Common & {
  kind: "organization_settings";
};

export type PeopleResult = Common & {
  kind: "people";
  action: "invite" | "change_role" | "remove";
  person: { name: string; email: string; role: "admin" | "member" | null };
  delivery?: "emailed" | "link";
  /** The invitation made, for its link. */
  invitationId?: string;
};

export type TeamsResult = Common & {
  kind: "teams";
  action: "create" | "rename" | "move" | "add_member" | "remove_member";
  team: {
    id: string | null;
    name: string;
    parent: string | null;
    memberCount: number;
  };
};

export type AdminToolResult =
  | OrganizationSettingsResult
  | PeopleResult
  | TeamsResult;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The result, when `value` is one: an object, or the JSON text of one, as a tool result arrives in
 * the transcript. Anything else is undefined and the card's caller draws its fallback.
 */
export function adminResultOf(value: unknown): AdminToolResult | undefined {
  const parsed = objectOf(value);
  if (!parsed) return undefined;
  const kind = parsed.kind;
  if (kind !== "organization_settings" && kind !== "people" && kind !== "teams")
    return undefined;
  const view = changeViewOf(parsed);
  if (!view) return undefined;
  return {
    ...(parsed as unknown as AdminToolResult),
    ...view,
    screens: Array.isArray(parsed.screens)
      ? (parsed.screens as AdminScreen[])
      : [],
  };
}

/** An object, or the JSON text of one, as a tool result arrives in the transcript. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return isObject(parsed) ? parsed : undefined;
}

const EFFECTS = new Set(["gains", "loses", "changes", "joins", "leaves"]);

/**
 * What a change does and who it reaches, from a result or from the preview the approval card is
 * given. Who it reaches may be a sentence alone, from a tool that names nobody.
 */
export function changeViewOf(value: unknown): ChangeView | undefined {
  const parsed = objectOf(value);
  if (!parsed || typeof parsed.summary !== "string") return undefined;
  const changes = Array.isArray(parsed.changes)
    ? parsed.changes.filter(
        (line): line is ChangeLine =>
          isObject(line) && typeof line.label === "string",
      )
    : [];
  const raw = parsed.affected;
  const affected: Affected =
    typeof raw === "string"
      ? { summary: raw, count: 0, people: [] }
      : isObject(raw) && typeof raw.summary === "string"
        ? {
            summary: raw.summary,
            count: typeof raw.count === "number" ? raw.count : 0,
            people: (Array.isArray(raw.people) ? raw.people : [])
              .filter(
                (one): one is AffectedPerson =>
                  isObject(one) &&
                  typeof one.name === "string" &&
                  typeof one.email === "string",
              )
              .map((one) => ({
                name: one.name,
                email: one.email,
                // An effect this app doesn't know is drawn as none.
                ...(one.effect && EFFECTS.has(one.effect)
                  ? { effect: one.effect }
                  : {}),
              })),
          }
        : { summary: "", count: 0, people: [] };
  return { summary: parsed.summary, changes, affected };
}
