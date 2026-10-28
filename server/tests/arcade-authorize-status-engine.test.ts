import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * WHAT THE VENDOR SAID ABOUT THE AUTHORIZATION IT JUST MINTED, READ OFF A REAL HTTP ANSWER.
 *
 * The rest of the authorize suite replaces `Tools.prototype.authorize` with a function returning a
 * hand-built object. That is blind to this class: the stub returns whatever shape the test chose,
 * so it cannot show what happens when the LIVE engine answers `{"status":"completed"}` — the answer
 * Arcade gives when the account already holds this grant — or `{"status":"failed"}`. This file
 * serves those answers as JSON over a socket through `ARCADE_BASE_URL`, exactly as
 * `arcade-pagination-engine.test.ts` does, and `new Arcade({ apiKey })` reads that variable at
 * construction, which is why the engine starts BEFORE `createArcadeClient`.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type EngineOptions = {
  /**
   * The `status` the mint answers with; `null` OMITS the field, as the wire may. Anything else is
   * serialized as it stands, so a status that is not text reaches the adapter as the wire sent it.
   */
  status: unknown;
  /** Send `"status": null` explicitly rather than omitting the key. */
  explicitNull?: true;
  /** Whether the mint answers a consent url beside it. */
  url?: string | null;
};

type Engine = { port: number; stop: () => void };

function startEngine(options: EngineOptions): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/tools/authorize") {
        const body: Record<string, unknown> = { id: "ar_mint1" };
        if (options.status !== null) body.status = options.status;
        else if (options.explicitNull) body.status = null;
        const consent =
          options.url === undefined
            ? "https://consent.example/go"
            : options.url;
        if (consent !== null) body.url = consent;
        return Response.json(body);
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

function engine(options: EngineOptions): Engine {
  running = startEngine(options);
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
  return running;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

const mint = () =>
  createArcadeClient("never-dialled").broker.authorize({
    account,
    toolkit: "Gmail",
    action: "Gmail.SendEmail",
    returnUrl: "https://openbot.example/settings/plugins",
  });

describe("the mint reads the status Arcade answered with", () => {
  test("a pending mint is handed on, which is the whole of the happy path", async () => {
    engine({ status: "pending" });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("an answer with NO status is handed on: silence is not a no", async () => {
    engine({ status: null });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("a mint the vendor calls completed does not send anybody to a consent screen", async () => {
    // Arcade answers this for an account that already holds the grant, and it answers it WITH a
    // url: the defect is not an absent url, so the url guard below cannot stand in for this.
    engine({ status: "completed" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(mint()).rejects.toThrow(/already/i);
  });

  test("a mint the vendor calls failed is not handed on as a live redirect", async () => {
    engine({ status: "failed" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(mint()).rejects.toThrow(/failed/);
  });

  test("a status this deployment does not know is not read as consent-is-next", async () => {
    // The spelling is not in the SDK's declared union at all. An allowlist refuses it; a denylist
    // of the dead spellings would hand its url to a browser.
    engine({ status: "revoked" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
  });

  /*
   * D6. Every assertion above holds whether or not the status is FOLDED: an unfolded `"  Completed "`
   * is a spelling outside the allowlist and is refused anyway, so the old single row here could not
   * fail on a deleted `.trim().toLowerCase()`. The rows below can: a padded or upper-cased member of
   * the ALLOWLIST is handed on only when the read folds it, and the held-grant SENTENCE ("already")
   * is reached only by a folded `completed`.
   */
  test("the status is read case- and space-insensitively, as every other comparison here is", async () => {
    engine({ status: "  Completed " });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(mint()).rejects.toThrow(/already/i);
  });

  test("a padded, re-cased pending is still a consent to walk through", async () => {
    engine({ status: "  Pending " });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("not_started — the other half of the allowlist, and what a first mint answers — is handed on", async () => {
    engine({ status: "not_started" });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("a padded, upper-cased not_started is handed on too", async () => {
    engine({ status: " NOT_STARTED " });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("an explicit null status is silence, exactly like an omitted one", async () => {
    engine({ status: null, explicitNull: true });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });
});

/**
 * L2-b. A STATUS THAT IS PRESENT AND IS NOT STATUS TEXT IS NOT SILENCE. It once read as silence —
 * `textOf` answered `undefined` for it, and "silence is not a no" handed the bearer url beside it
 * to a browser as a live redirect, after a status the code could not read. It is refused, as a
 * DEFINITE refusal (a `BrokerRefusalError`), so the attempt is discarded and Authorize can be
 * pressed again at once.
 */
describe("a mint status this deployment cannot read is not handed on", () => {
  for (const [label, status] of [
    ["an object", {}],
    ["false", false],
    ["a number", 0],
    ["a list", []],
    ["a blank string", ""],
    ["whitespace", "   "],
  ] as const) {
    test(`${label} where the status belongs refuses, and the url is not returned`, async () => {
      engine({ status });
      const outcome = await mint().then(
        (minted) => ({ minted }),
        (error: unknown) => ({ error }),
      );
      expect("minted" in outcome).toBe(false);
      expect((outcome as { error: unknown }).error).toBeInstanceOf(
        BrokerRefusalError,
      );
      expect(String((outcome as { error: Error }).error.message)).not.toContain(
        "consent.example",
      );
    });
  }
});
