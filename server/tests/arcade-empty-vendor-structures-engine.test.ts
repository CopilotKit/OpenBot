import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * AN EMPTY VENDOR STRUCTURE IS NOT A VENDOR ANSWER, AGAINST A REAL HTTP ENGINE.
 *
 * `metadata: { behavior: {} }` and `requirements: { secrets: {} }` are containers Arcade opened and
 * put nothing in. Read as answers they say "not destructive" and "nothing is required" — a
 * permission decision taken on missing data, and the opposite of what an ABSENT `metadata` or an
 * absent `behavior` already answers two lines away in the same function.
 *
 * SERVED OVER A REAL SOCKET, as `arcade-pagination-engine.test.ts` and
 * `arcade-malformed-listing-engine.test.ts` are and for their reason: the rest of the adapter suite
 * stubs the SDK's resource PROTOTYPES and so decides for itself what the adapter is handed, which
 * cannot see anything that happens between the wire and the reader. Here the SDK parses the body
 * and builds its own pages, so what these assertions read is what a deployment would.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type Engine = { port: number; stop: () => void };

/** The rows `/v1/tools` serves, set per test. One short page ends the listing. */
let serving: unknown[] = [];

function startEngine(): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (url.pathname === "/v1/tools") {
        const page = serving.slice(offset, offset + limit);
        return Response.json({
          items: page,
          offset,
          limit,
          page_count: page.length,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // `Bun.serve().port` is `number | undefined`; refuse loudly rather than coerce, as
  // `arcade-revoke-invariant.test.ts` does.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(rows: unknown[]): void {
  serving = rows;
  running = startEngine();
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
}

afterEach(() => {
  running?.stop();
  running = null;
  serving = [];
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

/** One listed action, with whatever `metadata` and `requirements` the case is about. */
const toolRow = (
  name: string,
  metadata: unknown,
  requirements: unknown = {
    authorization: {
      provider_id: "google",
      oauth2: { scopes: [] },
      token_status: "completed",
    },
  },
) => ({
  qualified_name: `Gmail.${name}`,
  description: "",
  toolkit: { name: "Gmail", description: "" },
  input: { parameters: [] },
  metadata,
  requirements,
});

const listed = async () => {
  const { actions } = createArcadeClient("never-dialled");
  useArcadeClient(actions);
  return await listTools({ url: "arcade://Gmail" });
};

describe("an empty behavior object is the vendor saying nothing, not saying safe", () => {
  test("a behavior object stating neither flag is read as the closed verdict", async () => {
    engine([toolRow("EmptyBehavior", { behavior: {} })]);

    expect(await listed()).toMatchObject([
      {
        name: "EmptyBehavior",
        vendorName: "Gmail.EmptyBehavior",
        effect: "write",
        destructive: true,
      },
    ]);
  });

  test("a behavior object carrying only unrelated keys says nothing either", async () => {
    engine([toolRow("Idempotent", { behavior: { idempotent: true } })]);

    expect(await listed()).toMatchObject([
      {
        name: "Idempotent",
        vendorName: "Gmail.Idempotent",
        effect: "write",
        destructive: true,
      },
    ]);
  });

  test("an empty behavior does not count towards classifiedCount", async () => {
    engine([
      toolRow("EmptyBehavior", { behavior: {} }),
      toolRow("Annotated", {
        behavior: { read_only: true, destructive: false },
      }),
    ]);
    const { broker } = createArcadeClient("never-dialled");

    const apps = await broker.listApps();
    expect(apps.length).toBe(1);
    expect(apps[0]?.actionCount).toBe(2);
    // ONE of the two: the empty container is an action Arcade has not classified, which is exactly
    // what the coverage warning exists to name.
    expect(apps[0]?.classifiedCount).toBe(1);
  });

  test("a stated behaviour is still read, in both directions", async () => {
    engine([
      toolRow("Read", { behavior: { read_only: true } }),
      toolRow("Write", { behavior: { destructive: false, read_only: false } }),
      toolRow("Delete", { behavior: { destructive: true } }),
    ]);

    expect(await listed()).toMatchObject([
      {
        name: "Read",
        vendorName: "Gmail.Read",
        effect: "read",
        destructive: false,
      },
      {
        name: "Write",
        vendorName: "Gmail.Write",
        effect: "write",
        destructive: false,
      },
      {
        name: "Delete",
        vendorName: "Gmail.Delete",
        effect: "write",
        destructive: true,
      },
    ]);
  });
});

describe("a secrets requirement that is not a list is unreadable, not satisfied", () => {
  const withSecrets = (secrets: unknown) =>
    toolRow(
      "Send",
      { behavior: { read_only: true } },
      {
        secrets,
        authorization: {
          provider_id: "google",
          oauth2: { scopes: [] },
          token_status: "completed",
        },
      },
    );

  test("an empty secrets object does not answer authorized", async () => {
    engine([withSecrets({})]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "unknown",
        reason:
          "Arcade listed this action's deployment secrets as something other than a list, so whether any is unset could not be read.",
      },
    ]);
  });

  test("no secrets field at all is still no secrets required", async () => {
    engine([toolRow("Send", { behavior: { read_only: true } })]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
    ]);
  });

  test("a listed secret is still read, met or unset", async () => {
    engine([withSecrets([{ key: "GITHUB_SERVER_URL", met: false }])]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ]);
  });
});

/**
 * THE DEFECT: EVERY ARCADE ACTION WAS UNCALLABLE BY EVERY MODEL, AND NOTHING SAID SO.
 *
 * Arcade's listing answers `qualified_name` — `Gmail.ListEmails` — and `mcp_tools.name` used to be
 * recorded as exactly that. `toolNameFor` then spliced it into `mcp__arcade-Gmail__Gmail.ListEmails`
 * and the model API refused the request: a tool name may only match `^[a-zA-Z0-9_-]+$`, and the dot
 * does not. Because a request carries EVERY tool together, one granted Arcade action failed the
 * WHOLE call — `Invalid 'tools[47].name'` — so a Bot holding one Arcade tool could not answer
 * anything at all.
 *
 * It survived every test in this tree because no test ever asked whether the name it recorded was a
 * name a model could be offered. These do.
 */
describe("an Arcade action is recorded under a name a model may be offered", () => {
  test("the toolkit prefix is dropped, and the vendor's own spelling is kept beside it", async () => {
    engine([toolRow("ListEmails", { behavior: { read: true } })]);

    expect(await listed()).toMatchObject([
      { name: "ListEmails", vendorName: "Gmail.ListEmails" },
    ]);
  });

  test("every listed name is one the model API accepts", async () => {
    engine([
      toolRow("ListEmails", null),
      toolRow("SendEmail", null),
      toolRow("TrashEmail", null),
    ]);

    /*
     * THE PATTERN ITSELF, not a sample of names somebody thought of. This is the whole of what the
     * model API will take, and `name` is spliced into a tool name unchanged — so a listing that
     * passes here is a request that is not refused for its names.
     */
    for (const tool of await listed()) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  test("a qualified name that is not this toolkit's is left whole", async () => {
    /*
     * ONLY THE VENDOR'S OWN PREFIX IS REMOVED. A listing that qualifies an action with some other
     * name is not something to repair by guessing: the name is kept as it stands and the guard in
     * `storableTools` is what leaves it out and names it, where it has a provenance.
     */
    engine([{ ...toolRow("Other", null), qualified_name: "Elsewhere.Other" }]);

    expect(await listed()).toMatchObject([
      { name: "Elsewhere.Other", vendorName: "Elsewhere.Other" },
    ]);
  });
});
