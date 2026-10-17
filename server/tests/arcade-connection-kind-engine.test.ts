import { afterEach, describe, expect, test } from "bun:test";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { BrokerApp } from "../src/plugins/broker";

/**
 * WHICH FLOW AN ARCADE APP GETS IS READ OFF THE LISTING, AND THIS IS THE FILE THAT WATCHES IT.
 *
 * `listApps` used to write `connection: { kind: "consent" }` onto every toolkit in the catalogue,
 * which is a claim about the vendor made without reading the vendor. `Apollo` — verbatim below,
 * from `fixtures/arcade-catalogue.json` — publishes NO `requirements.authorization` at all and one
 * deployment-wide secret instead, so it was announced as an app somebody connects by clicking
 * through a consent screen when there is no consent screen for it anywhere: pressing Connect mints
 * an authorization for a tool that requires none.
 *
 * SERVED OVER A REAL SOCKET THROUGH `ARCADE_BASE_URL`, as `arcade-pagination-engine.test.ts` does
 * and for its reason: the adapter suite's prototype stubs hand the adapter whatever shape the test
 * felt like, and the shapes this file is about — a `requirements` the SDK's own types forbid — are
 * exactly the ones a stub cannot be trusted to reproduce.
 */

type Engine = { port: number; stop: () => void };

const toolkitOf = (name: string) => ({
  name,
  description: `Arcade tools designed for LLMs to interact with ${name}`,
  version: "1.0.0",
});

/** Verbatim from the live listing: an oauth2 authorization, which IS a consent flow. */
const OAUTH_REQUIREMENTS = {
  met: true,
  authorization: {
    id: "arcade-asana",
    provider_id: "asana",
    provider_type: "oauth2",
    oauth2: { scopes: ["default"] },
    status: "active",
  },
};

/** Verbatim from the live listing: a deployment-wide secret and NO authorization whatsoever. */
const SECRET_REQUIREMENTS = {
  met: false,
  secrets: [
    {
      key: "APOLLO_API_KEY",
      met: false,
      status_reason: "Secret APOLLO_API_KEY not found",
    },
  ],
};

const toolOf = (toolkit: string, n: number, extra: object = {}) => ({
  qualified_name: `${toolkit}.Action${n}`,
  name: `Action${n}`,
  fully_qualified_name: `${toolkit}.Action${n}@1.0.0`,
  toolkit: toolkitOf(toolkit),
  input: { parameters: [] },
  ...extra,
});

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(tools: unknown[]): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/tools") {
        return new Response("not found", { status: 404 });
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const page = tools.slice(offset, offset + limit);
      return Response.json({
        items: page,
        offset,
        limit,
        page_count: page.length,
        total_count: tools.length,
      });
    },
  });
  // `Bun.serve().port` is `number | undefined`; refuse loudly rather than coerce, as
  // `arcade-revoke-invariant.test.ts` does.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  const started = { port, stop: () => server.stop(true) };
  running = started;
  process.env.ARCADE_BASE_URL = `http://localhost:${port}`;
  return started;
}

afterEach(() => {
  running?.stop();
  running = null;
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

const appOf = (apps: BrokerApp[], slug: string): BrokerApp => {
  const app = apps.find((a) => a.slug === slug);
  if (!app) throw new Error(`no app ${slug} in the directory`);
  return app;
};

const listed = () => createArcadeClient("never-dialled").broker.listApps();

describe("the connection kind is read off what Arcade publishes", () => {
  test("an app Arcade publishes an oauth2 authorization for is a consent app", async () => {
    engine([toolOf("Asana", 0, { requirements: OAUTH_REQUIREMENTS })]);
    expect(appOf(await listed(), "Asana").connection).toEqual({
      kind: "consent",
    });
  });

  test("an app that asks only for a deployment-wide secret is NOT a consent app", async () => {
    // Apollo's live shape: a secret an operator sets once for everybody, and no authorization at
    // all. There is no consent screen to send anybody to, so announcing one is a wrong answer.
    engine([toolOf("Apollo", 0, { requirements: SECRET_REQUIREMENTS })]);
    expect(appOf(await listed(), "Apollo").connection).toEqual({
      kind: "no-auth",
    });
  });

  test("an app that publishes no requirements at all asks nobody for anything", async () => {
    engine([toolOf("Hackernews", 0)]);
    expect(appOf(await listed(), "Hackernews").connection).toEqual({
      kind: "no-auth",
    });
  });

  test("one action's authorization makes the whole toolkit a consent app", async () => {
    // A toolkit whose actions disagree still HAS a consent flow, and that flow is how somebody
    // reaches the actions that need it.
    engine([
      toolOf("Mixed", 0, { requirements: SECRET_REQUIREMENTS }),
      toolOf("Mixed", 1, { requirements: OAUTH_REQUIREMENTS }),
    ]);
    expect(appOf(await listed(), "Mixed").connection).toEqual({
      kind: "consent",
    });
  });

  test("the kinds are read per app, not written once for the catalogue", async () => {
    engine([
      toolOf("Asana", 0, { requirements: OAUTH_REQUIREMENTS }),
      toolOf("Apollo", 0, { requirements: SECRET_REQUIREMENTS }),
      toolOf("Hackernews", 0),
    ]);
    const apps = await listed();
    expect(
      Object.fromEntries(apps.map((a) => [a.slug, a.connection.kind])),
    ).toEqual({ Asana: "consent", Apollo: "no-auth", Hackernews: "no-auth" });
  });
});

describe("a requirements shape this deployment cannot read is refused, never guessed", () => {
  test("requirements that are not an object refuse, naming the app", async () => {
    engine([toolOf("Apollo", 0, { requirements: "yes" })]);
    await expect(listed()).rejects.toThrow(
      /Arcade sent a string where Apollo's requirements belong/,
    );
  });

  test("an authorization that is not an object refuses, naming the app", async () => {
    engine([toolOf("Asana", 0, { requirements: { authorization: "oauth2" } })]);
    await expect(listed()).rejects.toThrow(
      /Arcade sent a string where Asana's authorization requirement belongs/,
    );
  });

  test("a list where requirements belong is refused as a list", async () => {
    engine([toolOf("Asana", 0, { requirements: [] })]);
    await expect(listed()).rejects.toThrow(
      /Arcade sent a list where Asana's requirements belong/,
    );
  });

  test("a null requirements is the vendor's silence and not a bad shape", async () => {
    engine([toolOf("Hackernews", 0, { requirements: null })]);
    expect(appOf(await listed(), "Hackernews").connection).toEqual({
      kind: "no-auth",
    });
  });
});
