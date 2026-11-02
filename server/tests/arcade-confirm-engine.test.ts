import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";

/**
 * THE RETURN LEG AGAINST A REAL HTTP ENGINE, BECAUSE NOTHING LESS CAN SEE THIS CLASS OF DEFECT.
 *
 * `arcade-adapter-authorize.test.ts` stubs the SDK's `Auth` PROTOTYPE and hands `confirmUser` a
 * hand-written object, so every field that file writes is a field the adapter is guaranteed to
 * find. The wire makes no such guarantee: `ConfirmUserResponse.auth_id` is DECLARED required in
 * the SDK's types and is not VALIDATED anywhere in it, so a vendor answer that omits the field
 * reaches the adapter as `undefined` wearing the type `string` — the same hole the mint closes by
 * hand at `arcade-adapter.ts`'s `authorize`.
 *
 * So these tests serve real JSON over a real socket through `ARCADE_BASE_URL` and let the SDK
 * build and parse its own request. `new Arcade({ apiKey })` reads that variable at construction,
 * which is why the server is started BEFORE `createArcadeClient`.
 */

const CONFIRM_PATH = "/v1/auth/confirm_user";

type Engine = {
  port: number;
  /** Every path the SDK asked for, in order. */
  requests: string[];
  stop: () => void;
};

/** Serve `body` (verbatim JSON) from the confirm endpoint. */
function startEngine(body: unknown): Engine {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === CONFIRM_PATH) return Response.json(body);
      return new Response("not found", { status: 404 });
    },
  });
  // `Bun.serve().port` is `number | undefined`; refuse loudly rather than coerce, as
  // `arcade-revoke-invariant.test.ts` does.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, requests, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(body: unknown): Engine {
  running = startEngine(body);
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

const confirm = () => {
  const { broker } = createArcadeClient("never-dialled");
  const flow = broker.authorizations;
  if (!flow) throw new Error("the Arcade broker runs an authorization flow.");
  return flow.confirmReturn({ handle: "fl_1", vendorUserId: "vendor-u1" });
};

describe("confirmReturn answers an authorization id or it answers nothing", () => {
  test("a confirmation that OMITS auth_id throws rather than answering an id-less match", async () => {
    const e = engine({ next_uri: "https://cloud.arcade.dev/done" });

    await expect(confirm()).rejects.toThrow(/no authorization id/);
    // The call was really made: this is the vendor's answer being refused, not a short circuit.
    expect(e.requests).toEqual([CONFIRM_PATH]);
  });

  test("an EMPTY auth_id is refused on the same footing as an absent one", async () => {
    engine({ auth_id: "" });

    await expect(confirm()).rejects.toThrow(/no authorization id/);
  });

  test("a non-string auth_id is refused rather than carried into the binding", async () => {
    engine({ auth_id: 7 });

    await expect(confirm()).rejects.toThrow(/no authorization id/);
  });

  test("the id the vendor really answered rides out untouched", async () => {
    engine({ auth_id: "ar_7", next_uri: "https://cloud.arcade.dev/done" });

    expect(await confirm()).toEqual({ authorizationId: "ar_7" });
  });
});
