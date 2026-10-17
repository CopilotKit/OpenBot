import { DEV_ACTOR } from "./auth/dev-actor";
import type { OpenBotRole } from "./auth/roles";
import type { IdentifyActor, IdentifyUser } from "./copilot";

export type RequestActor = { id: string; name: string; role: OpenBotRole };

type SessionLike = {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    role?: OpenBotRole | null;
  };
};

/**
 * The authorization projection's answer for an unauthenticated request: a person who owns nothing
 * rather than an error, so the runtime can still describe itself, `/info` reports the licence and
 * the public roster, which is what a deployment check reads to tell "the licence is invalid" apart
 * from "chat is silently broken". It grants nothing: this actor matches no private profile and is
 * not an administrator, and a run still fails in `identifyUser`, which has no anonymous case
 * because a thread must belong to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
export function createRequestActor(deps: {
  singleUser: boolean;
  getSession(headers: Headers): Promise<SessionLike | null | undefined>;
  rolesForUser(userId: string): Promise<OpenBotRole[]>;
}): {
  resolveRequestActor(request: Request): Promise<RequestActor>;
  identifyUser: IdentifyUser;
  identifyActor: IdentifyActor;
} {
  async function resolveRequestActor(request: Request): Promise<RequestActor> {
    if (deps.singleUser) {
      return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
    }
    const session = await deps.getSession(request.headers);
    const user = session?.user;
    if (!user) {
      throw new Error("A CopilotKit run requires a signed-in user.");
    }
    const roles = user.role ? [user.role] : await deps.rolesForUser(user.id);
    if (!roles.includes("admin") && !roles.includes("user")) {
      throw new Error("A CopilotKit run requires an authorized user.");
    }
    return {
      id: user.id,
      name: user.name ?? user.email ?? user.id,
      role: roles.includes("admin") ? "admin" : "user",
    };
  }

  /** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
  const identifyUser: IdentifyUser = async (request) => {
    const { id, name } = await resolveRequestActor(request);
    return { id, name };
  };

  const identifyActor: IdentifyActor = async (request) => {
    try {
      const { id, role } = await resolveRequestActor(request);
      return { id, role };
    } catch {
      return ANONYMOUS_ACTOR;
    }
  };

  return { resolveRequestActor, identifyUser, identifyActor };
}
