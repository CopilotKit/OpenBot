// server/tests/request-actor.test.ts
import { describe, expect, test } from "bun:test";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { OpenBotRole } from "../src/auth/roles";
import type { RecorderResolver } from "../src/recorder/guard";
import { actorName, createRequestActor } from "../src/request-actor";

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
  resolveRecorder?: RecorderResolver;
}) {
  const calls = { getSession: 0, rolesForUser: 0 };
  const functions = createRequestActor({
    resolveRecorder: options.resolveRecorder,
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

  test("a blank name falls back to the email, never reaching the runtime blank", async () => {
    for (const name of ["", "   "]) {
      const blank = actorFor({
        user: { id: "u9", name, email: "di@example.test", role: "user" },
      });
      expect((await blank.resolveRequestActor(request())).name).toBe(
        "di@example.test",
      );
    }
    expect(actorName({ id: "u10", name: " ", email: null })).toBe("u10");
    expect(
      actorName({ id: "u10", name: " Ada ", email: "a@example.test" }),
    ).toBe("Ada");
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

  describe("a Recorder bearer", () => {
    const bearer = `Bearer obr_${"a".repeat(43)}`;
    const passRequest = (pathname = "/api/copilotkit/trajectory/t-1/connect") =>
      new Request(`http://127.0.0.1${pathname}`, {
        method: "POST",
        headers: { authorization: bearer },
      });
    const recorderActor = {
      id: "r1",
      name: "Rae",
      email: "rae@example.test",
      image: null,
      role: "user" as const,
      connectionId: "c1",
    };

    test("is answered on the capture pass through the resolver, before single-user mode", async () => {
      for (const singleUser of [false, true]) {
        const seen: Request[] = [];
        const { resolveRequestActor, calls } = actorFor({
          singleUser,
          resolveRecorder: async (request) => {
            seen.push(request);
            return { actor: recorderActor };
          },
        });
        expect(await resolveRequestActor(passRequest())).toEqual({
          id: "r1",
          name: "Rae",
          role: "user",
        });
        expect(seen).toHaveLength(1);
        expect(calls.getSession).toBe(0);
      }
    });

    test("is refused on any other path without asking the resolver", async () => {
      for (const singleUser of [false, true]) {
        let asked = 0;
        const { resolveRequestActor, identifyActor } = actorFor({
          singleUser,
          resolveRecorder: async () => {
            asked += 1;
            return { actor: recorderActor };
          },
        });
        for (const path of [
          "/api/copilotkit/agent/bot/run",
          "/api/copilotkit/trajectory/t-1/connect/extra",
          "/api/copilotkit/trajectory/connect",
          // The id the runtime would decode: one that does not decode is no trajectory.
          "/api/copilotkit/trajectory/%E0%A4%A/connect",
        ]) {
          await expect(resolveRequestActor(passRequest(path))).rejects.toThrow(
            "A CopilotKit run requires a signed-in user.",
          );
          expect(await identifyActor(passRequest(path))).toEqual({
            id: "",
            role: "user",
          });
        }
        expect(asked).toBe(0);
      }
    });

    test("is refused when the resolver refuses, is unavailable or has no answer", async () => {
      for (const resolution of [
        { refused: "unknown" as const },
        { refused: "organization" as const, userId: "r1" },
        { unavailable: true as const },
        null,
      ]) {
        const { resolveRequestActor } = actorFor({
          user: { id: "u1", role: "admin" },
          resolveRecorder: async () => resolution,
        });
        await expect(resolveRequestActor(passRequest())).rejects.toThrow(
          "A CopilotKit run requires a signed-in user.",
        );
      }
    });

    test("never falls through to the cookie session or the dev actor", async () => {
      const { resolveRequestActor, calls } = actorFor({
        singleUser: true,
        resolveRecorder: async () => ({ refused: "removed" }),
      });
      await expect(resolveRequestActor(passRequest())).rejects.toThrow();
      expect(calls.getSession).toBe(0);
    });

    test("with no resolver wired is refused", async () => {
      const { resolveRequestActor } = actorFor({
        user: { id: "u1", role: "admin" },
      });
      await expect(resolveRequestActor(passRequest())).rejects.toThrow(
        "A CopilotKit run requires a signed-in user.",
      );
    });
  });

  test("a request without a Recorder bearer is unchanged when a resolver is wired", async () => {
    let asked = 0;
    const { resolveRequestActor } = actorFor({
      singleUser: true,
      resolveRecorder: async () => {
        asked += 1;
        return null;
      },
    });
    expect((await resolveRequestActor(request())).id).toBe(DEV_ACTOR.id);
    expect(asked).toBe(0);
  });
});
