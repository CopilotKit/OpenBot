/**
 * Permission changes an admin describes in English, checked, applied and previewed before anything
 * is saved. The translator that writes them is ./capability-translate.ts; this is everything that
 * does not need a model.
 *
 * - The check ({@link checkCapabilityChanges}). Every change must name a real permission, a real
 *   role or group, and a setting the rule can honour. A group can only widen (./capabilities.ts), so
 *   "off" for a group is refused with how to say it instead: off for everybody or a role, then on for
 *   the other groups. Saved, a group's "off" reads as a restriction and restricts nothing.
 * - The preview ({@link previewCapabilityChanges}). Each member's permissions before and after,
 *   decided by `resolveCapability` itself over the rows as they are and the rows as they would be,
 *   so it can never disagree with the switches it previews. For a permission somebody loses, their
 *   own recent use of it, where the trail records that use ({@link CAPABILITY_ACTIVITY}).
 */
import type { AuditEvent, AuditEventQuery, AuditReader } from "../audit";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  type Capability,
  type CapabilityAnswer,
  type CapabilityRow,
  isCapability,
  type Member,
  resolveCapability,
} from "./capabilities";

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

/** The roles as the Permissions screen names them. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admins",
  user: "Members",
};

/** One switch to set: the organization's, a role's or a group's, for one permission. */
export type CapabilityChange = {
  scopeKind: "organization" | "role" | "group";
  /** Empty for the organization; "admin" or "user" for a role; the group's name for a group. */
  scopeId: string;
  capability: string;
  /** On, off, or null to remove the switch so the level beneath it decides. */
  allowed: boolean | null;
};

export type CapabilityChangeProblem = {
  /** Which change, counted from 1 as the screen counts them. */
  change: number;
  field: "scope" | "capability" | "allowed";
  message: string;
};

export type CapabilityChangesCheck =
  | { ok: true }
  | { ok: false; error: string; problems: CapabilityChangeProblem[] };

/**
 * Changes from one description. Enough to take three permissions from one group in an OpenBot with
 * thirty groups; more is not one sentence's worth.
 */
export const MAX_CAPABILITY_CHANGES = 100;

function list(values: readonly string[], limit = 20): string {
  const shown = values
    .slice(0, limit)
    .map((value) => `"${value}"`)
    .join(", ");
  return values.length > limit
    ? `${shown}, and ${values.length - limit} more`
    : shown;
}

const keyOf = (
  row: Pick<CapabilityRow, "scopeKind" | "scopeId" | "capability">,
) => `${row.scopeKind}\u0000${row.scopeId}\u0000${row.capability}`;

/**
 * Whether changes name real permissions, roles and groups, and set nothing the rule ignores. Every
 * change is checked, so one retry can fix all of them, in words a model can act on and an admin can
 * read.
 */
export function checkCapabilityChanges(
  changes: readonly CapabilityChange[],
  groups: readonly string[],
): CapabilityChangesCheck {
  if (changes.length === 0)
    return { ok: false, error: "No changes were written.", problems: [] };
  if (changes.length > MAX_CAPABILITY_CHANGES)
    return {
      ok: false,
      error: `That's ${changes.length} changes. Make at most ${MAX_CAPABILITY_CHANGES} at a time.`,
      problems: [],
    };

  const problems: CapabilityChangeProblem[] = [];
  const seen = new Map<string, number>();
  changes.forEach((change, index) => {
    const at = index + 1;
    const problem = (
      field: CapabilityChangeProblem["field"],
      message: string,
    ) => problems.push({ change: at, field, message });

    if (!isCapability(change.capability))
      problem(
        "capability",
        `"${change.capability}" isn't a permission here. The permissions are ${list(CAPABILITIES)}.`,
      );
    if (
      change.scopeKind === "role" &&
      !(ROLES as readonly string[]).includes(change.scopeId)
    )
      problem("scope", `A role is "admin" or "user", not "${change.scopeId}".`);
    if (change.scopeKind === "group" && !groups.includes(change.scopeId))
      problem(
        "scope",
        groups.length > 0
          ? `There's no group called "${change.scopeId}". The groups are ${list(groups)}.`
          : `There's no group called "${change.scopeId}". OpenBot has no groups yet.`,
      );
    if (change.scopeKind === "group" && change.allowed === false)
      problem(
        "allowed",
        `A group can only turn a permission on, so off for the group "${change.scopeId}" changes nothing. To take it from a group, turn it off for everybody or for a role, then turn it on for every other group.`,
      );

    const key = keyOf(change);
    const earlier = seen.get(key);
    if (earlier !== undefined)
      problem("scope", `It sets the same switch as change ${earlier}.`);
    else seen.set(key, at);
  });

  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    error: problems
      .map((problem) => `Change ${problem.change}: ${problem.message}`)
      .join(" "),
    problems,
  };
}

/** The switches as they would stand with the changes saved. Pure; the store does the saving. */
export function applyCapabilityChanges(
  rows: readonly CapabilityRow[],
  changes: readonly CapabilityChange[],
): CapabilityRow[] {
  const next = new Map(rows.map((row) => [keyOf(row), row]));
  for (const change of changes) {
    const key = keyOf(change);
    if (change.allowed === null) next.delete(key);
    else
      next.set(key, {
        scopeKind: change.scopeKind,
        scopeId: change.scopeId,
        capability: change.capability,
        allowed: change.allowed,
      });
  }
  return [...next.values()];
}

/** The permissions the changes set a switch for, each once, in the order they first appear. */
export function touchedCapabilities(
  changes: readonly CapabilityChange[],
): Capability[] {
  return [
    ...new Set(changes.map((change) => change.capability).filter(isCapability)),
  ];
}

const onOff = (allowed: boolean) => (allowed ? "on" : "off");

/**
 * What each changed permission comes to, worked out with `resolveCapability` over the rows before and
 * after, for the reader: who has it with no group giving it, by role, and which groups give it. So the
 * reader states what the rule does with the changes, and never has to apply the rule itself.
 */
export function outcomeLines(
  before: readonly CapabilityRow[],
  after: readonly CapabilityRow[],
  changes: readonly CapabilityChange[],
  groups: readonly string[],
): string[] {
  return touchedCapabilities(changes).flatMap((capability) => {
    const baseline = (rows: readonly CapabilityRow[], role: Role) =>
      resolveCapability(rows, { role, groups: [] }, capability).allowed;
    const giving = (rows: readonly CapabilityRow[]) =>
      groups.filter(
        (group) =>
          resolveCapability(rows, { role: "user", groups: [group] }, capability)
            .decidedBy === "group",
      );
    const named = (names: string[]) =>
      names.length > 0 ? names.join(", ") : "none";
    const givingBefore = giving(before);
    const givingAfter = giving(after);
    return [
      `${CAPABILITY_LABELS[capability].title}:`,
      ...ROLES.map(
        (role) =>
          `- ${ROLE_LABELS[role]} in no group that gives it: ${onOff(baseline(before, role))} before, ${onOff(baseline(after, role))} after.`,
      ),
      `- Groups that give it to their members whatever the organization or role says: ${named(givingBefore)} before; ${named(givingAfter)} after.`,
      `- Groups that don't give it, after: ${named(groups.filter((group) => !givingAfter.includes(group)))}.`,
    ];
  });
}

/**
 * A sentence for changes that leave a permission with nobody, worked out with the rule over the roles
 * and every group: the shape a restriction takes when it was meant for one group and reaches all of
 * them. Null otherwise.
 */
export function changesWarning(
  after: readonly CapabilityRow[],
  changes: readonly CapabilityChange[],
  groups: readonly string[],
): string | null {
  const nobody = touchedCapabilities(changes).filter(
    (capability) =>
      ROLES.every(
        (role) =>
          !resolveCapability(after, { role, groups: [] }, capability).allowed,
      ) &&
      groups.every(
        (group) =>
          !resolveCapability(
            after,
            { role: "user", groups: [group] },
            capability,
          ).allowed,
      ),
  );
  if (nobody.length === 0) return null;
  const titles = nobody.map(
    (capability) => `"${CAPABILITY_LABELS[capability].title}"`,
  );
  return `After this, nobody has ${titles.length > 1 ? `${titles.slice(0, -1).join(", ")} or ${titles.at(-1)}` : titles[0]}.`;
}

/**
 * Where a permission's use shows on the trail: the rows a person's use of it writes, filed under
 * them, and the words for what is counted. Null where the trail records no use of it.
 *
 * Read with the trail's own filters (`AuditEventQuery`) wherever they can say it, and `keep` only for
 * what lives in a row's payload alone.
 */
type ActivityMapping = {
  query: Pick<AuditEventQuery, "eventType" | "targetType" | "intent">;
  keep?: (event: AuditEvent) => boolean;
  /** What the count is a count of, after a number: "14 actions on their own computer". */
  counts: string;
};

const CLOUD_BROWSER_INTENTS = "navigate,activate,type,read";
const CLOUD_COMPUTER_INTENTS =
  "read_file,download_file,write_file,list_files,run_command";

export const CAPABILITY_ACTIVITY: Record<Capability, ActivityMapping | null> = {
  // Every action a Bot took as this person: on a computer, theirs or a cloud one, and in an app.
  useBots: {
    query: { eventType: "computer.action_allowed,mcp.call_succeeded" },
    counts: "actions Bots took for them",
  },
  // The gateway asks for this one on every computer action that is not a file or a command.
  cloudBrowser: {
    query: {
      eventType: "computer.action_allowed",
      targetType: "computer",
      intent: CLOUD_BROWSER_INTENTS,
    },
    counts: "browser actions on a cloud computer",
  },
  // Asked on every navigation. Connections a computer makes by itself are not on the trail.
  cloudNetwork: {
    query: {
      eventType: "computer.action_allowed",
      targetType: "computer",
      intent: "navigate",
    },
    counts: "pages opened on a cloud computer",
  },
  cloudComputer: {
    query: {
      eventType: "computer.action_allowed",
      targetType: "computer",
      intent: CLOUD_COMPUTER_INTENTS,
    },
    counts: "commands and file actions on a cloud computer",
  },
  // A folder action on the person's own computer (host-access/tools.ts).
  localComputer: {
    query: { eventType: "computer.action_allowed", targetType: "host_access" },
    counts: "actions on their own computer",
  },
  customRules: {
    query: { eventType: "approval.rule_changed" },
    keep: (event) =>
      event.payload.layer === "personal" && event.payload.change === "created",
    counts: "approval rules of their own saved",
  },
  passwordManager: {
    query: { eventType: "password.saved,computer.sign_in_completed" },
    counts: "logins saved or sign-ins handed to a Bot",
  },
  slackTeams: {
    query: { eventType: "delivery.linked" },
    keep: (event) =>
      event.payload.transport === "slack" ||
      event.payload.transport === "teams",
    counts: "Bots connected to Slack or Teams",
  },
  teamBots: {
    query: { eventType: "bot.created,bot.updated" },
    keep: (event) => event.payload.visibility === "public",
    counts: "Bots published for the team, or changed while published",
  },
  ownerApps: {
    query: { eventType: "app_access.owner_granted" },
    counts: "apps given to their own Bots",
  },
  isolatedComputers: {
    query: { eventType: "bot.created,bot.updated" },
    keep: (event) => event.payload.isolated === true,
    counts: "Bots given a computer of their own",
  },
  // Check-ins are kept by the check-in engine, and none of them writes a row on the trail.
  proactive: null,
};

/** Recent use is read over this many days. */
export const ACTIVITY_DAYS = 30;
/** Rows read per person and permission. A count that reaches it is said as "or more". */
const ACTIVITY_SCAN = 100;
/** Rows shown per person and permission, newest first. */
const ACTIVITY_SHOWN = 3;
/** People listed with what changes for them. The counts are over everybody. */
const PEOPLE_LIMIT = 200;

/** One person as the preview reads them: who they are, and the member the rule decides for. */
export type PreviewMember = {
  id: string;
  email: string;
  name: string | null;
} & Member;

export type CapabilityActivity = {
  /** What is counted, after the number: "actions on their own computer". */
  what: string;
  /** Rows counted, at most the scan. */
  count: number;
  /** More rows than were counted. */
  more: boolean;
  /** The newest few, as the trail holds them, for Audit's own cells to draw. */
  recent: AuditEvent[];
};

export type PreviewCapability = {
  capability: Capability;
  title: string;
  before: CapabilityAnswer;
  after: CapabilityAnswer;
  /** Their recent use of it, for a permission they lose that the trail records. */
  activity?: CapabilityActivity;
};

export type PreviewPerson = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  groups: readonly string[];
  /** Each permission the changes touch, before and after. */
  capabilities: PreviewCapability[];
};

export type CapabilityPreview = {
  check: CapabilityChangesCheck;
  /**
   * People whose permissions change, or who keep one for a different reason: those losing one first,
   * then those gaining one, then those who keep. Capped; `counts` is over everybody.
   */
  people: PreviewPerson[];
  counts: {
    people: number;
    losing: number;
    gaining: number;
    keeping: number;
    unchanged: number;
  };
  activity: {
    days: number;
    /** Permissions somebody loses whose use the trail does not record. */
    unmapped: { capability: Capability; title: string }[];
  };
  warning: string | null;
};

const sameAnswer = (a: CapabilityAnswer, b: CapabilityAnswer) =>
  a.allowed === b.allowed &&
  a.decidedBy === b.decidedBy &&
  a.scopeId === b.scopeId;

async function activityOf(
  reader: AuditReader,
  person: PreviewMember,
  mapping: ActivityMapping,
  from: string,
): Promise<CapabilityActivity> {
  const page = await reader.list({
    ...mapping.query,
    actorUserId: person.id,
    from,
    limit: ACTIVITY_SCAN,
  });
  const kept = mapping.keep ? page.events.filter(mapping.keep) : page.events;
  return {
    what: mapping.counts,
    count: kept.length,
    more: page.nextCursor !== undefined,
    recent: kept.slice(0, ACTIVITY_SHOWN),
  };
}

/**
 * Each member's permissions before and after, and the recent use of what they lose. Writes nothing.
 * Changes that don't check are not previewed: their switches may name nothing the rule reads.
 */
export async function previewCapabilityChanges(input: {
  changes: readonly CapabilityChange[];
  rows: readonly CapabilityRow[];
  members: readonly PreviewMember[];
  groups: readonly string[];
  reader?: AuditReader;
  now: Date;
}): Promise<CapabilityPreview> {
  const check = checkCapabilityChanges(input.changes, input.groups);
  const empty = {
    check,
    people: [],
    counts: {
      people: input.members.length,
      losing: 0,
      gaining: 0,
      keeping: 0,
      unchanged: input.members.length,
    },
    activity: { days: ACTIVITY_DAYS, unmapped: [] },
    warning: null,
  };
  if (!check.ok) return empty;

  const after = applyCapabilityChanges(input.rows, input.changes);
  const touched = touchedCapabilities(input.changes);
  const everybody = input.members.map((member) => {
    const capabilities = touched.map((capability) => ({
      capability,
      title: CAPABILITY_LABELS[capability].title,
      before: resolveCapability(input.rows, member, capability),
      after: resolveCapability(after, member, capability),
    }));
    return {
      member,
      capabilities,
      loses: capabilities.some((c) => c.before.allowed && !c.after.allowed),
      gains: capabilities.some((c) => !c.before.allowed && c.after.allowed),
      keeps: capabilities.some((c) => !sameAnswer(c.before, c.after)),
    };
  });
  const losing = everybody.filter((entry) => entry.loses);
  const gaining = everybody.filter((entry) => entry.gains && !entry.loses);
  const keeping = everybody.filter(
    (entry) => entry.keeps && !entry.loses && !entry.gains,
  );

  const from = new Date(
    input.now.getTime() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const people: PreviewPerson[] = [];
  // In turn, not together: one person's reads at a time keeps a preview of many people off the pool.
  for (const entry of [...losing, ...gaining, ...keeping].slice(
    0,
    PEOPLE_LIMIT,
  )) {
    const capabilities: PreviewCapability[] = [];
    for (const capability of entry.capabilities) {
      const mapping = CAPABILITY_ACTIVITY[capability.capability];
      const lost = capability.before.allowed && !capability.after.allowed;
      capabilities.push(
        lost && mapping && input.reader
          ? {
              ...capability,
              activity: await activityOf(
                input.reader,
                entry.member,
                mapping,
                from,
              ),
            }
          : capability,
      );
    }
    people.push({
      id: entry.member.id,
      email: entry.member.email,
      name: entry.member.name,
      role: entry.member.role,
      groups: entry.member.groups,
      capabilities,
    });
  }

  const lostSomewhere = new Set(
    losing.flatMap((entry) =>
      entry.capabilities
        .filter((c) => c.before.allowed && !c.after.allowed)
        .map((c) => c.capability),
    ),
  );
  return {
    check,
    people,
    counts: {
      people: input.members.length,
      losing: losing.length,
      gaining: gaining.length,
      keeping: keeping.length,
      unchanged:
        input.members.length - losing.length - gaining.length - keeping.length,
    },
    activity: {
      days: ACTIVITY_DAYS,
      unmapped: touched
        .filter(
          (capability) =>
            lostSomewhere.has(capability) && !CAPABILITY_ACTIVITY[capability],
        )
        .map((capability) => ({
          capability,
          title: CAPABILITY_LABELS[capability].title,
        })),
    },
    warning: changesWarning(after, input.changes, input.groups),
  };
}
