import { DEV_ACTOR } from "./auth/dev-actor";
import type { OpenBotRole } from "./auth/roles";
import type { IdentifyActor, IdentifyUser } from "./copilot";
import {
  RECORDER_BEARER_PREFIX,
  type RecorderResolver,
} from "./recorder/guard";
import { isTrajectoryConnectPath } from "./recorder/trajectory-gate";

type RequestActor = { id: string; name: string; role: OpenBotRole };

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

/** The name the runtime is given: never blank, because its `resolveUser` refuses a blank name. */
export function actorName(user: {
  id: string;
  name?: string | null;
  email?: string | null;
}): string {
  return user.name?.trim() || user.email || user.id;
}

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
export function createRequestActor(deps: {
  singleUser: boolean;
  resolveRecorder?: RecorderResolver;
  getSession(headers: Headers): Promise<SessionLike | null | undefined>;
  rolesForUser(userId: string): Promise<OpenBotRole[]>;
}): {
  resolveRequestActor(request: Request): Promise<RequestActor>;
  identifyUser: IdentifyUser;
  identifyActor: IdentifyActor;
} {
  async function resolveRequestActor(request: Request): Promise<RequestActor> {
    // A Recorder token is answered only on the capture pass, in every auth mode: it can never run a Bot.
    if (
      request.headers.get("authorization")?.startsWith(RECORDER_BEARER_PREFIX)
    ) {
      if (
        deps.resolveRecorder &&
        isTrajectoryConnectPath(new URL(request.url).pathname)
      ) {
        const resolution = await deps.resolveRecorder(request);
        if (resolution && "actor" in resolution) {
          const { actor } = resolution;
          return { id: actor.id, name: actorName(actor), role: actor.role };
        }
      }
      throw new Error("A CopilotKit run requires a signed-in user.");
    }
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
      name: actorName(user),
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
