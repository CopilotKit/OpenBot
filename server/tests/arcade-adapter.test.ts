import { afterEach, describe, expect, test } from "bun:test";
import Arcade, { APIError } from "@arcadeai/arcadejs";
import { callTool, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError } from "../src/plugins/broker";

/**
 * Same pattern as `composio-adapter.test.ts` ("the key becoming a vendor"): `new Arcade({ apiKey })`
 * opens no socket and sends no request, and its resources' methods live on their classes'
 * prototypes, so a prototype replaced BEFORE `createArcadeClient` runs is what the client it builds
 * will call. A seed instance is built only to reach the prototype.
 */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const toolsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).tools,
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

const toolOf = (toolkit: string, i: number) => ({
  qualified_name: `${toolkit}.A${i}`,
  toolkit: { name: toolkit, description: `${toolkit} things` },
});

describe("createArcadeClient", () => {
  test("declares its grant is held by the vendor", () => {
    expect(createArcadeClient("never-dialled").broker.grantIsLocal).toBe(false);
  });

  test("constructing it opens no socket and sends no request", () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(`fetch ${String(args[0])}`);
      return Promise.reject(new Error("dialled"));
    }) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = realFetch;
    });
    for (const name of ["list", "execute", "get", "authorize"])
      stub(toolsProto(), name, () => {
        calls.push(`tools.${name}`);
        return Promise.reject(new Error("dialled"));
      });
    const proto = Arcade.prototype as unknown as Methods;
    for (const name of ["request", "get", "post", "getAPIList"])
      stub(proto, name, () => {
        calls.push(`client.${name}`);
        return Promise.reject(new Error("dialled"));
      });
    createArcadeClient("never-dialled");
    expect(calls).toEqual([]);
  });

  test("listApps counts actions across the FULL paged listing", async () => {
    // Pages of 1000 — the directory's page size since the "Browse Arcade" deadline fix (see
    // `DIRECTORY_PAGE_SIZE`); this pinned [0, 100, 200] at the old size of 100. Pages are served BY
    // OFFSET, not by call order, because pages two and three are now asked for concurrently.
    const pages: [string, number][][] = [
      [["GithubApi", 1000]],
      [["GithubApi", 1000]],
      [
        ["GithubApi", 400],
        ["Github", 100],
      ],
    ];
    const asked: { limit: number; offset: number }[] = [];
    stub(toolsProto(), "list", (...args: unknown[]) => {
      const q = args[0] as { limit: number; offset: number; toolkit?: string };
      asked.push({ limit: q.limit, offset: q.offset });
      const page = pages[q.offset / 1000] ?? [];
      const items = page.flatMap(([tk, n]) =>
        Array.from({ length: n }, (_, i) => toolOf(tk, i)),
      );
      return Promise.resolve({ items, total_count: 2500, offset: q.offset });
    });
    const apps = await createArcadeClient("never-dialled").broker.listApps();
    expect(asked).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ]);
    expect(apps.find((a) => a.slug === "GithubApi")?.actionCount).toBe(2400);
    expect(apps.find((a) => a.slug === "Github")?.actionCount).toBe(100);
    expect(apps.reduce((n, a) => n + a.actionCount, 0)).toBe(2500);
  });

  test("a REAL APIError through execute reaches callTool's authorize sentence", async () => {
    stub(toolsProto(), "execute", () =>
      Promise.reject(
        new APIError(
          403,
          { name: "tool_authorization_required", message: "Authorize Gmail" },
          undefined,
          new Headers(),
        ),
      ),
    );
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);
    const result = await callTool(
      { url: "arcade://Gmail", actorId: "u1" },
      "Gmail.SendEmail",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Gmail.SendEmail has not been authorized on this account yet. Authorize it in Connections and ask again.",
    );
  });

  test("a non-SDK error is rethrown as itself, not as a synthetic failure", async () => {
    const boom = new Error("boom");
    stub(toolsProto(), "execute", () => Promise.reject(boom));
    const { actions } = createArcadeClient("never-dialled");
    await expect(
      actions.execute({ tool_name: "X.Y", input: {}, user_id: "u" }),
    ).rejects.toBe(boom);
  });

  const connectionsProto = (): Methods =>
    Object.getPrototypeOf(
      new Arcade({ apiKey: "never-dialled" }).admin.userConnections,
    ) as Methods;
  const authProvidersProto = (): Methods =>
    Object.getPrototypeOf(
      new Arcade({ apiKey: "never-dialled" }).admin.authProviders,
    ) as Methods;
  const account = { vendorUserId: "u1" } as never;

  test("ensureAuthConfig answers not-needed in every case", async () => {
    const { broker } = createArcadeClient("never-dialled");
    for (const toolkit of ["Github", "Gmail", "GithubApi"])
      expect(
        await broker.ensureAuthConfig({
          toolkit,
          connection: { kind: "consent" },
        } as never),
      ).toBe("not-needed");
  });

  test("deleteAuthConfig is a no-op", async () => {
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.deleteAuthConfig("Github")).toBeUndefined();
  });

  test("connectionFields and connectWithFields refuse, naming the deployment-wide secret", async () => {
    const { broker } = createArcadeClient("never-dialled");
    const a = broker.connectionFields({
      toolkit: "Github",
      authScheme: "API_KEY",
    } as never);
    await expect(a).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(a).rejects.toThrow(/deployment-wide secret/);
    const b = broker.connectWithFields({
      account,
      toolkit: "Github",
      authScheme: "API_KEY",
      values: { k: "v" },
    } as never);
    await expect(b).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(b).rejects.toThrow(/deployment-wide secret/);
  });

  test("accountName reads provider_user_info.name, then .login, else null", async () => {
    const rows: unknown[] = [];
    // A PAGE, as the real `list` resolves to: `connectionsFor` pages the listing itself rather
    // than through the SDK, whose auto-pagination stops after page one when the engine omits
    // `total_count`. See `arcade-pagination-engine.test.ts`.
    stub(connectionsProto(), "list", () =>
      Promise.resolve({ items: rows, offset: 0, total_count: rows.length }),
    );
    // The toolkit's own listing names the provider TYPE its connections are held under.
    stub(toolsProto(), "list", () =>
      Promise.resolve({
        items: [
          {
            qualified_name: "Github.A0",
            requirements: { authorization: { id: "x", provider_id: "github" } },
          },
        ],
      }),
    );
    // And the project's configured providers map that type to its INSTANCE ids, which is what a
    // connection row carries. See `connectionsFor`.
    stub(authProvidersProto(), "list", () =>
      Promise.resolve({
        items: [{ id: "cpk-poc", provider_id: "github" }],
        total_count: 1,
      }),
    );
    const { broker } = createArcadeClient("never-dialled");
    const ask = () => broker.accountName({ account, toolkit: "Github" });
    rows.push({
      provider_id: "cpk-poc",
      provider_user_info: { name: "Ada", login: "ada1" },
    });
    expect(await ask()).toBe("Ada");
    rows.length = 0;
    rows.push({
      provider_id: "cpk-poc",
      provider_user_info: { login: "ada1" },
    });
    expect(await ask()).toBe("ada1");
    rows.length = 0;
    rows.push({ provider_id: "cpk-poc", provider_user_info: {} });
    expect(await ask()).toBeNull();

    // AN EMPTY NAME MUST NOT SHADOW A GOOD LOGIN. `??` falls through on null and undefined only,
    // so a `textOf` that answered `""` as text ended the chain on the empty field and drew a blank
    // where the account's identity goes — on a connection that is genuinely connected.
    rows.length = 0;
    rows.push({
      provider_id: "cpk-poc",
      provider_user_info: { name: "", login: "maxim" },
    });
    expect(await ask()).toBe("maxim");

    // Whitespace-only is the same blank to whoever reads the screen.
    rows.length = 0;
    rows.push({
      provider_id: "cpk-poc",
      provider_user_info: { name: "   ", login: "maxim" },
    });
    expect(await ask()).toBe("maxim");

    // And a row carrying nothing but empty text is no name at all, never an empty one.
    rows.length = 0;
    rows.push({
      provider_id: "cpk-poc",
      provider_user_info: { name: "", login: "" },
    });
    expect(await ask()).toBeNull();
  });

  test("a toolkit named with empty text raises no blank app", async () => {
    stub(toolsProto(), "list", (...args: unknown[]) => {
      const q = args[0] as { offset: number };
      return Promise.resolve({
        items:
          q.offset === 0
            ? [
                toolOf("Github", 0),
                { qualified_name: "X.A0", toolkit: { name: "" } },
                { qualified_name: "Y.A0", toolkit: { name: "   " } },
              ]
            : [],
        offset: q.offset,
      });
    });
    const apps = await createArcadeClient("never-dialled").broker.listApps();
    // The slug is what a URL and a picker row are built from; an empty one is unconnectable.
    expect(apps.map((a) => a.slug)).toEqual(["Github"]);
  });

  test("no app resolves to a fields connection", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({
        items: [toolOf("Github", 0), toolOf("Gmail", 0)],
        total_count: 2,
      }),
    );
    const apps = await createArcadeClient("never-dialled").broker.listApps();
    expect(apps.length).toBeGreaterThan(0);
    // `no-auth` is in the list because `toolOf` publishes no `requirements` at all, which is Arcade
    // saying this action needs authorizing by nobody — the kind is READ per app now rather than
    // written once for the catalogue, and `arcade-connection-kind-engine.test.ts` is where each
    // published shape is held to its answer. `fields` is the one this test is about and it is still
    // unreachable: Arcade has no per-person field entry.
    for (const app of apps)
      expect(["consent", "no-auth", "unsupported"]).toContain(
        app.connection.kind,
      );
  });
});
