// server/tests/request-actor.test.ts
import { describe, expect, test } from "bun:test";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { OpenBotRole } from "../src/auth/roles";
import { createRequestActor } from "../src/request-actor";

type User = {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: OpenBotRole | null;
};

function actorFor(options: {
  singleUser?: boolean;
  user?: User;
  roles?: OpenBotRole[];
}) {
  const calls = { getSession: 0, rolesForUser: 0 };
  const functions = createRequestActor({
    singleUser: options.singleUser ?? false,
    async getSession() {
      calls.getSession += 1;
      return options.user ? { user: options.user } : null;
    },
    async rolesForUser() {
      calls.rolesForUser += 1;
      return options.roles ?? [];
    },
  });
  return { ...functions, calls };
}

const request = () => new Request("http://127.0.0.1/api/copilotkit");

describe("createRequestActor", () => {
  test("single-user mode answers every request as the dev actor without asking for a session", async () => {
    const { resolveRequestActor, calls } = actorFor({ singleUser: true });
    expect(await resolveRequestActor(request())).toEqual({
      id: DEV_ACTOR.id,
      name: DEV_ACTOR.email,
      role: DEV_ACTOR.role,
    });
    expect(calls.getSession).toBe(0);
  });

  test("a session's user is answered with its own role and a name of name, email, then id", async () => {
    const named = actorFor({
      user: { id: "u1", name: "Ada", email: "ada@example.test", role: "admin" },
    });
    expect(await named.resolveRequestActor(request())).toEqual({
      id: "u1",
      name: "Ada",
      role: "admin",
    });
    expect(named.calls.rolesForUser).toBe(0);

    const emailOnly = actorFor({
      user: { id: "u2", email: "bo@example.test", role: "user" },
    });
    expect((await emailOnly.resolveRequestActor(request())).name).toBe(
      "bo@example.test",
    );

    const idOnly = actorFor({ user: { id: "u3", role: "user" } });
    expect((await idOnly.resolveRequestActor(request())).name).toBe("u3");
  });

  test("a user with no role takes it from the role repository, admin winning over user", async () => {
    const both = actorFor({ user: { id: "u4" }, roles: ["user", "admin"] });
    expect((await both.resolveRequestActor(request())).role).toBe("admin");
    expect(both.calls.rolesForUser).toBe(1);

    const plain = actorFor({ user: { id: "u5" }, roles: ["user"] });
    expect((await plain.resolveRequestActor(request())).role).toBe("user");
  });

  test("a request with no session throws, and so does identifyUser", async () => {
    const { resolveRequestActor, identifyUser } = actorFor({});
    await expect(resolveRequestActor(request())).rejects.toThrow(
      "A CopilotKit run requires a signed-in user.",
    );
    await expect(identifyUser(request())).rejects.toThrow(
      "A CopilotKit run requires a signed-in user.",
    );
  });

  test("a user with no authorized role throws", async () => {
    const { resolveRequestActor } = actorFor({ user: { id: "u6" }, roles: [] });
    await expect(resolveRequestActor(request())).rejects.toThrow(
      "A CopilotKit run requires an authorized user.",
    );
  });

  test("identifyUser returns the id and name only", async () => {
    const { identifyUser } = actorFor({
      user: { id: "u7", name: "Cy", role: "user" },
    });
    expect(await identifyUser(request())).toEqual({ id: "u7", name: "Cy" });
  });

  test("identifyActor returns id and role, and the anonymous actor when resolving throws", async () => {
    const signedIn = actorFor({ user: { id: "u8", role: "admin" } });
    expect(await signedIn.identifyActor(request())).toEqual({
      id: "u8",
      role: "admin",
    });
    const anonymous = actorFor({});
    expect(await anonymous.identifyActor(request())).toEqual({
      id: "",
      role: "user",
    });
  });
});
