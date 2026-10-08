import type { AuditInitiator, AuditInitiatorKind } from "../audit";
import type { Decides } from "./broker";

/**
 * Who may steer a run that uses a Shared app's account — the rules, with no database.
 *
 * Checked on every call rather than when configuration changes, so a way of starting a run that
 * nobody thought of here is refused rather than allowed: the facts come from the run itself, and
 * an initiator this file does not name is never read as a person.
 */

export const SHARED_AUDIENCES = ["owner", "people", "team"] as const;
export type SharedAudience = (typeof SHARED_AUDIENCES)[number];
export type ApprovalMember = { kind: "user" | "group"; value: string };
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
};

/** The two sources a person writes the prompt for. Every other source, including ones added later, is outside input. */
export const OWNER_STEERED_SOURCES: ReadonlySet<string> = new Set([
  "manual",
  "schedule",
]);

export type Steering =
  | { kind: "refuse"; why: string }
  | { kind: "actor"; outside: boolean };

export async function steeringOf(
  initiator: AuditInitiator | undefined,
  sourcesOf: (responsibilityId: string) => Promise<readonly string[]>,
): Promise<Steering> {
  /*
   * NO INITIATOR IS NOT A PERSON. Every path that runs a Bot says what started the run — a person's
   * chat, a routine, a responsibility, a memory sync, a handoff — so a call that arrives without one
   * is a path that forgot, and a shared account must not guess who is steering it. Refused, rather
   * than read as the actor, so a background caller added later cannot reach the team account by
   * omission.
   */
  if (!initiator)
    return { kind: "refuse", why: "the run does not say what started it" };
  type _SteeringDecides = Decides<
    AuditInitiatorKind,
    {
      person: "the actor, who signed in and asked";
      routine: "the owner, who wrote the routine's prompt";
      memory: "the owner, who chose the sync's fixed arguments";
      responsibility: "the owner, and outside input when any source is not manual or schedule";
      handoff: "whatever started the first run, read from origin; refused without one";
      deployment: "refused — no person is behind it";
    }
  >;
  switch (initiator.kind) {
    case "person":
    case "routine":
    case "memory":
      return { kind: "actor", outside: false };
    case "responsibility": {
      const sources = await sourcesOf(initiator.id);
      return {
        kind: "actor",
        outside: sources.some((source) => !OWNER_STEERED_SOURCES.has(source)),
      };
    }
    case "handoff":
      if (!initiator.origin || initiator.origin.kind === "handoff") {
        return {
          kind: "refuse",
          why: "a handoff that does not say what started it",
        };
      }
      return steeringOf(initiator.origin, sourcesOf);
    case "deployment":
      return { kind: "refuse", why: "a run with no person behind it" };
    default:
      return {
        kind: "refuse",
        why: "a run started in a way this deployment does not recognise",
      };
  }
}

export type ActorFacts = {
  actorId: string;
  isAdmin: boolean;
  groups: readonly string[];
};

export function admits(
  approval: SharedUseApproval,
  ownerUserId: string | null,
  actor: ActorFacts,
  steering: { outside: boolean },
): boolean {
  if (steering.outside && !approval.outsideInput) return false;
  if (actor.isAdmin || (ownerUserId !== null && actor.actorId === ownerUserId))
    return true;
  type _AudienceDecides = Decides<
    SharedAudience,
    {
      owner: "nobody but the owner and administrators";
      people: "people listed by id, and members of groups listed by name, as they were approved";
      team: "any signed-in person";
    }
  >;
  if (approval.audience === "team") return true;
  if (approval.audience === "owner") return false;
  return approval.members.some(
    (member) =>
      (member.kind === "user" && member.value === actor.actorId) ||
      (member.kind === "group" && actor.groups.includes(member.value)),
  );
}

export type BotFacts = {
  ownerUserId: string | null;
  visibility: "public" | "private";
  publication: {
    audience: "team" | "people";
    members: ApprovalMember[];
  } | null;
  assignments: readonly string[];
  sources: readonly string[];
};

export function exposureOf(bot: BotFacts): SharedUseApproval {
  const outsideInput = bot.sources.some(
    (source) => !OWNER_STEERED_SOURCES.has(source),
  );
  if (
    bot.visibility === "public" ||
    bot.publication?.audience === "team" ||
    bot.assignments.includes("*")
  ) {
    return { audience: "team", outsideInput, members: [] };
  }
  const members: ApprovalMember[] = [
    ...(bot.publication?.members ?? []),
    ...bot.assignments.map((group) => ({
      kind: "group" as const,
      value: group,
    })),
  ];
  if (members.length > 0) return { audience: "people", outsideInput, members };
  return { audience: "owner", outsideInput, members: [] };
}

const RANK: Record<SharedAudience, number> = { owner: 0, people: 1, team: 2 };

export function covers(
  approved: SharedUseApproval | null,
  needed: SharedUseApproval,
): boolean {
  if (!approved) return false;
  if (needed.outsideInput && !approved.outsideInput) return false;
  if (RANK[approved.audience] > RANK[needed.audience]) return true;
  if (RANK[approved.audience] < RANK[needed.audience]) return false;
  if (needed.audience !== "people") return true;
  return needed.members.every((member) =>
    approved.members.some(
      (held) => held.kind === member.kind && held.value === member.value,
    ),
  );
}

export function asSharedUseApproval(value: unknown): SharedUseApproval | null {
  if (!value || typeof value !== "object") return null;
  const { audience, outsideInput, members } = value as Record<string, unknown>;
  if (
    !SHARED_AUDIENCES.includes(audience as SharedAudience) ||
    typeof outsideInput !== "boolean"
  )
    return null;
  const listed = members === undefined ? [] : members;
  if (!Array.isArray(listed)) return null;
  const read: ApprovalMember[] = [];
  for (const member of listed) {
    const { kind, value: named } = (member ?? {}) as Record<string, unknown>;
    if (
      (kind !== "user" && kind !== "group") ||
      typeof named !== "string" ||
      !named.trim()
    )
      return null;
    read.push({ kind, value: named.trim() });
  }
  return {
    audience: audience as SharedAudience,
    outsideInput,
    members: audience === "people" ? read : [],
  };
}
