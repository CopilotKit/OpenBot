// server/tests/arcade-revoke-invariant.test.ts
/**
 * ONE OUTCOME INVARIANT ON `revoke`, STATED ONCE AND ASKED OF EVERY VENDOR RESPONSE SHAPE.
 *
 * The live defect this seam has already suffered — and which two review rounds have now reached by
 * four separate routes — is always the same OUTCOME, never the same mechanism:
 *
 *     `revoke` ANSWERS `false` WITH NO DELETE SPENT AT THE VENDOR, while the caller deletes the
 *     local `brokered_connections` row anyway — leaving a live grant at the vendor that no row
 *     this deployment holds any longer names.
 *
 * Every existing test on this seam pins a MECHANISM: "the pager loops", "the fallback returns the
 * parsed body", "the status allowlist refuses". A mechanism test passes for every shape it was
 * written against and says nothing about the next one, so each new vendor response shape re-opens
 * the same defect through whichever mechanism does not yet cover it. This file pins the OUTCOME
 * instead, so a shape nobody anticipated is caught by an assertion rather than in production.
 *
 * THE INVARIANT, from `broker.ts:712-717` ("A PARTIAL ASK IS A FAILURE RATHER THAN A TRUE … It
 * must throw, so that the row this deployment holds … is still standing when they press disconnect
 * a second time"):
 *
 *   1. `revoke` NEVER answers `false` without a DELETE having been spent at the vendor. `false`
 *      means "there was nothing to withdraw", and that is a claim about the vendor's side which
 *      only a listing read WHOLE can support.
 *   2. Where the connection listing was UNVERIFIABLE — not readable as the whole of itself — it
 *      does not answer at all. It throws. An answer either way is a guess, and both guesses are
 *      destructive: `false` orphans a live grant, `true` reports a partial ask as a clean success.
 *
 * ALL SEVEN SHAPES BELOW ARE UNVERIFIABLE LISTINGS, so for all seven the required outcome is the
 * same: THROW. None of them may answer. The seven are enumerated verbatim from round-2 findings
 * and each reaches the listing through a different door, which is the point — the assertion does
 * not know or care which door.
 *
 * SERVED OVER A REAL SOCKET, for `arcade-pagination-engine.test.ts`'s reason: the rest of the
 * adapter suite stubs SDK resource PROTOTYPES, and `OffsetPage`'s constructor manufactures
 * `items: []` and `total_count: 0` for fields the vendor never sent. A hand-built stub cannot pose
 * any of these seven questions, because the shapes ARE what the wire carried.
 *
 * DRIVEN THROUGH THE BROKER SEAM — the public `ConnectedAppBroker.revoke` — and never through an
 * adapter internal. The invariant is a property of the seam; a test that reached `connectionsFor`
 * directly would be pinning a mechanism again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/** The seven shapes, each named by what the VENDOR SENT rather than by what breaks. */
type Shape =
  /** 1. a non-JSON 200 response to the connection listing. */
  | "listing-is-not-json"
  /** 2. a 204 / `content-length: 0` response on a paged endpoint. */
  | "listing-is-204"
  /** 3. a body whose JSON is the literal `null`. */
  | "listing-is-json-null"
  /** 4. `items: [null]` on the user-connections listing. */
  | "listing-item-is-null"
  /** 5. `total_count` sent as a JSON string rather than a number, on a TRUNCATED listing. */
  | "total-count-is-a-string"
  /** 6. a toolkit whose actions name ZERO provider ids. */
  | "toolkit-names-no-provider"
  /** 7. a toolkit whose actions name TWO OR MORE provider ids. */
  | "toolkit-names-two-providers";

const CONNECTION_PAGE_SIZE = 100;

/** A live, attributable user-connection row: the thing a DELETE would be spent on. */
const connectionRow = (n: number) => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  connection_status: "active",
  // A provider INSTANCE id, never a provider type — see `connectionsFor`'s comment.
  provider_id: "google-openbot",
  provider_type: "oauth2",
  provider_user_info: { name: `person ${n}` },
  scopes: [],
  user_id: account.vendorUserId,
});

/** One listed action, carrying the provider ids `authProviderOf` reads off the listing itself. */
const toolRow = (toolkit: string, n: number, providers: string[]) => ({
  qualified_name: `${toolkit}.Action${n}`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization:
      providers.length === 0
        ? // ZERO provider ids: the authorization block is there, the id is not.
          { oauth2: { scopes: [] } }
        : {
            provider_id: providers[n % providers.length],
            oauth2: { scopes: [] },
          },
  },
});

/** Which provider ids this shape's action listing names. */
function providersFor(shape: Shape): string[] {
  if (shape === "toolkit-names-no-provider") return [];
  if (shape === "toolkit-names-two-providers") return ["google", "microsoft"];
  return ["google"];
}

type Engine = { port: number; requests: string[]; stop: () => void };

/**
 * The vendor, serving ONE shape.
 *
 * Everything the shape does not name answers the HEALTHY listing the live API answers with, so each
 * test varies exactly one thing and the DELETE path is always open: a `revoke` that wanted to spend
 * a DELETE here could always have spent one, which is what makes "no DELETE reached the vendor" a
 * statement about the adapter rather than about the stub.
 */
function startEngine(shape: Shape): Engine {
  const requests: string[] = [];
  // Shape 5's truncation: 250 rows claimed, 100 served. The claim is the only thing that could say
  // the listing is short, and it arrives as a STRING.
  const truncated = shape === "total-count-is-a-string";
  const rows = Array.from({ length: truncated ? 250 : 3 }, (_, n) =>
    connectionRow(n),
  );
  const served = truncated ? 100 : rows.length;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(
        url.searchParams.get("limit") ?? String(CONNECTION_PAGE_SIZE),
      );

      // THE DELETE, always available and always counted.
      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/v1/admin/user_connections") {
        if (shape === "listing-is-not-json") {
          // 1. A 200 that is not JSON at all — a proxy's courtesy page, served with the status of
          //    a real answer.
          return new Response("<html><body>OK</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (shape === "listing-is-204") {
          // 2. 204 with no body and `content-length: 0` on a PAGED endpoint. Nothing in it says
          //    how many connections exist; it says only that the vendor sent no list.
          return new Response(null, { status: 204 });
        }
        if (shape === "listing-is-json-null") {
          // 3. Well-formed JSON whose whole value is `null`.
          return new Response("null", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (shape === "listing-item-is-null") {
          // 4. A list with a hole in it. One row is unreadable, and the other two are real
          //    connections a DELETE is owed to.
          return Response.json({
            items: [null, connectionRow(0), connectionRow(1)],
            offset,
            limit,
            page_count: 3,
            total_count: 3,
          });
        }
        const page = rows.slice(offset, Math.min(offset + limit, served));
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        // 5. The cross-check's only input, sent as a STRING. `reportedTotalOf` keeps numbers only,
        //    so "the vendor did not say" and "the vendor said 250" collapse into one answer.
        body.total_count = truncated ? String(rows.length) : rows.length;
        return Response.json(body);
      }

      if (url.pathname === "/v1/admin/auth_providers") {
        return Response.json({
          items: [
            { id: "google-openbot", provider_id: "google", type: "oauth2" },
            {
              id: "arcade-microsoft",
              provider_id: "microsoft",
              type: "oauth2",
            },
          ],
          offset: 0,
          limit,
          page_count: 2,
          total_count: 2,
        });
      }

      if (url.pathname === "/v1/tools") {
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const providers = providersFor(shape);
        const page =
          offset === 0
            ? Array.from({ length: 4 }, (_, n) =>
                toolRow(toolkit, n, providers),
              )
            : [];
        return Response.json({
          items: page,
          offset,
          limit,
          page_count: page.length,
          total_count: 4,
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  // `Bun.serve().port` is `number | undefined`. Refuse loudly rather than coercing: a stub that
  // never bound a port would otherwise send every request of this file to a nonsense address and
  // the invariant below would "hold" for the wrong reason.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, requests, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(shape: Shape): Engine {
  running = startEngine(shape);
  // `new Arcade({ apiKey })` reads this at construction, so the server starts FIRST.
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

/** How many DELETEs actually reached the vendor. Half the invariant is counted here. */
const deletesSpent = (e: Engine): number =>
  e.requests.filter(
    (r) => r.startsWith("DELETE ") && r.includes("/v1/admin/user_connections/"),
  ).length;

type Outcome =
  | { kind: "returned"; value: boolean }
  | { kind: "threw"; message: string };

type Broker = ReturnType<typeof createArcadeClient>["broker"];

async function revokeOutcome(broker: Broker): Promise<Outcome> {
  try {
    return {
      kind: "returned",
      value: await broker.revoke({ account, toolkit: "Gmail" }),
    };
  } catch (error) {
    return {
      kind: "threw",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The seven shapes, with the sentence each one is enumerated under. */
const SHAPES: [Shape, string][] = [
  ["listing-is-not-json", "a non-JSON 200 response to the connection listing"],
  ["listing-is-204", "a 204 / content-length: 0 response on a paged endpoint"],
  ["listing-is-json-null", "a body whose JSON is the literal null"],
  ["listing-item-is-null", "items: [null] on the user-connections listing"],
  [
    "total-count-is-a-string",
    "total_count sent as a JSON string rather than a number",
  ],
  [
    "toolkit-names-no-provider",
    "a toolkit whose actions name zero provider ids",
  ],
  [
    "toolkit-names-two-providers",
    "a toolkit whose actions name two or more provider ids",
  ],
];

describe("revoke never answers off a listing it could not read whole", () => {
  for (const [shape, sentence] of SHAPES) {
    test(sentence, async () => {
      const e = engine(shape);
      const { broker } = createArcadeClient("never-dialled");

      const outcome = await revokeOutcome(broker);
      const deletes = deletesSpent(e);
      const answered =
        outcome.kind === "threw"
          ? "threw"
          : `returned ${String(outcome.value)}`;

      // (1) `false` IS A CLAIM ABOUT THE VENDOR'S SIDE and may never be made for free. Asserted
      //     first and on its own, because this is the live defect's exact signature: `false` plus
      //     zero DELETEs, with the caller deleting the local row regardless.
      const orphansAGrant = answered === "returned false" && deletes === 0;
      expect({ shape, orphansAGrant }).toEqual({ shape, orphansAGrant: false });

      // (2) AND THE LISTING WAS UNVERIFIABLE IN EVERY ONE OF THE SEVEN, so no answer is available
      //     at all. `broker.ts:712-717`: an unreadable or partial ask must THROW, so the local row
      //     survives to name the app on the second press of Disconnect.
      expect({ shape, answered, deletesSpent: deletes }).toEqual({
        shape,
        answered: "threw",
        deletesSpent: deletes,
      });
    });
  }
});
