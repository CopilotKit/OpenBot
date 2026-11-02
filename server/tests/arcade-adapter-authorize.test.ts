import { afterEach, describe, expect, test } from "bun:test";
import Arcade, { APIError } from "@arcadeai/arcadejs";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";

/** Prototype stubs BEFORE construction; `new Arcade({ apiKey })` opens no socket. */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const protoOf = (pick: (c: Arcade) => object): Methods =>
  Object.getPrototypeOf(
    pick(new Arcade({ apiKey: "never-dialled" })),
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  on: Methods,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
  useArcadeClient(null);
});

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

describe("arcade adapter authorize", () => {
  test("sends tool_name and user_id with the action's case intact", async () => {
    const seen: unknown[] = [];
    stub(
      protoOf((c) => c.tools),
      "authorize",
      (params) => {
        seen.push(params);
        return Promise.resolve({
          id: "au_1",
          url: "https://consent.example/x",
        });
      },
    );
    const { broker } = createArcadeClient("never-dialled");
    const out = await broker.authorize({
      account,
      toolkit: "Github",
      returnUrl: "https://app.example/settings",
      action: "Github.CreateIssue",
    });
    expect(seen).toHaveLength(1);
    const params = seen[0] as Record<string, unknown>;
    expect(params.tool_name).toBe("Github.CreateIssue");
    expect(params.user_id).toBe("vendor-u1");
    // The mint's own `ar_…` id rides out beside the url: spec D24 binds it to the callback's auth_id.
    expect(out).toEqual({
      redirectUrl: "https://consent.example/x",
      authorizationId: "au_1",
    });
  });

  test("returns the mint's id as authorizationId, untouched", async () => {
    stub(
      protoOf((c) => c.tools),
      "authorize",
      () =>
        Promise.resolve({ id: "ar_abc123", url: "https://consent.example/y" }),
    );
    const { broker } = createArcadeClient("never-dialled");
    const out = await broker.authorize({
      account,
      toolkit: "Github",
      returnUrl: "https://app.example/settings",
      action: "Github.CreateIssue",
    });
    expect(out.authorizationId).toBe("ar_abc123");
  });

  test("a mint that answers no id is not a success, so no null is ever minted", async () => {
    stub(
      protoOf((c) => c.tools),
      "authorize",
      () => Promise.resolve({ url: "https://consent.example/y" }),
    );
    const { broker } = createArcadeClient("never-dialled");
    await expect(
      broker.authorize({
        account,
        toolkit: "Github",
        returnUrl: "https://app.example/settings",
        action: "Github.CreateIssue",
      }),
    ).rejects.toThrow("no id");
  });

  test("with no action it refuses without dialling", async () => {
    const seen: unknown[] = [];
    stub(
      protoOf((c) => c.tools),
      "authorize",
      (params) => {
        seen.push(params);
        return Promise.resolve({});
      },
    );
    const { broker } = createArcadeClient("never-dialled");
    await expect(
      broker.authorize({
        account,
        toolkit: "Github",
        returnUrl: "https://app.example/settings",
      }),
    ).rejects.toBeInstanceOf(BrokerRefusalError);
    expect(seen).toHaveLength(0);
  });

  test("the outgoing authorize params contain no next_uri key at all", async () => {
    const seen: unknown[] = [];
    stub(
      protoOf((c) => c.tools),
      "authorize",
      (params) => {
        seen.push(params);
        return Promise.resolve({
          id: "au_1",
          url: "https://consent.example/x",
        });
      },
    );
    const { broker } = createArcadeClient("never-dialled");
    await broker.authorize({
      account,
      toolkit: "Github",
      returnUrl: "https://app.example/settings",
      action: "Github.CreateIssue",
    });
    const params = seen[0] as object;
    expect(Object.keys(params)).not.toContain("next_uri");
    expect("next_uri" in params).toBe(false);
    expect(JSON.stringify(params)).not.toContain("app.example");
  });
});

describe("arcade adapter confirmReturn", () => {
  const confirmUser = (impl: (...args: unknown[]) => unknown) =>
    stub(
      protoOf((c) => c.auth),
      "confirmUser",
      impl,
    );

  test("returns the authorizationId, sending the handle as flow_id", async () => {
    const seen: unknown[] = [];
    confirmUser((params) => {
      seen.push(params);
      return Promise.resolve({ auth_id: "au_9" });
    });
    const { broker } = createArcadeClient("never-dialled");
    const out = await broker.authorizations?.confirmReturn({
      handle: "flow-abc",
      vendorUserId: "vendor-u1",
    });
    expect(out).toEqual({ authorizationId: "au_9" });
    expect(seen[0]).toEqual({ flow_id: "flow-abc", user_id: "vendor-u1" });
  });

  test("reports user_mismatch as { mismatch: true }, not a throw", async () => {
    confirmUser(() =>
      Promise.reject(
        new APIError(
          400,
          { name: "user_mismatch", message: "wrong user" },
          "400",
          new Headers(),
        ),
      ),
    );
    const { broker } = createArcadeClient("never-dialled");
    const out = await broker.authorizations?.confirmReturn({
      handle: "flow-abc",
      vendorUserId: "someone-else",
    });
    expect(out).toEqual({ mismatch: true });
  });

  test("any other failure still throws", async () => {
    confirmUser(() =>
      Promise.reject(
        new APIError(500, { name: "boom", message: "x" }, "500", new Headers()),
      ),
    );
    const { broker } = createArcadeClient("never-dialled");
    await expect(
      broker.authorizations?.confirmReturn({
        handle: "flow-abc",
        vendorUserId: "vendor-u1",
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
