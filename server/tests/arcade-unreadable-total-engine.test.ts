// server/tests/arcade-unreadable-total-engine.test.ts
/**
 * THE TRUNCATION CROSS-CHECK IS ONLY AS GOOD AS THE VALUE IT READS.
 *
 * `pagedItems` ends a listing on a short page and then asks one further question — did the vendor
 * claim more rows than arrived? — and that question has exactly one input: `total_count`. The
 * reading of that field used to be `typeof raw === "number" ? raw : undefined`, which answered
 * "the vendor did not say" for every shape that is not a JavaScript number. A vendor serving 100
 * of 250 connections under `"total_count": "250"` therefore had the cross-check switched off, and
 * `revoke` DELETED 100, ANSWERED `true`, AND LEFT 150 GRANTS LIVE — a partial withdrawal reported
 * to the operator as a clean success, which is the one outcome `broker.ts`'s `revoke` contract
 * forbids outright.
 *
 * This file pins the three readings the field now has, through the public broker seam:
 *
 *   - a plain decimal integer, string or number alike, IS the vendor saying a number, and the
 *     cross-check fires on it;
 *   - anything else the vendor SENT is unreadable and REFUSES, so the check can never be disabled
 *     again by a value nobody anticipated;
 *   - an ABSENT field still means "the vendor did not say", because `total_count` is optional on
 *     the wire and every listing here ends on a short page.
 *
 * SERVED OVER A REAL SOCKET, for `arcade-pagination-engine.test.ts`'s reason: `OffsetPage`'s
 * constructor manufactures `total_count: 0` for a field the vendor never sent, so only the wire
 * can pose these questions.
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

const CONNECTION_PAGE_SIZE = 100;

const connectionRow = (n: number) => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  connection_status: "active",
  provider_id: "google-openbot",
  provider_type: "oauth2",
  provider_user_info: { name: `person ${n}` },
  scopes: [],
  user_id: account.vendorUserId,
});

const toolRow = (toolkit: string, n: number) => ({
  qualified_name: `${toolkit}.Action${n}`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: "google", oauth2: { scopes: [] } },
  },
});

type Engine = { port: number; requests: string[]; stop: () => void };

/**
 * The vendor, serving `held` connection rows but only the first `served` of them, and reporting
 * the holding as `total` — whatever shape `total` is in. `undefined` omits the field entirely.
 */
function startEngine(held: number, served: number, total: unknown): Engine {
  const requests: string[] = [];
  const rows = Array.from({ length: held }, (_, n) => connectionRow(n));

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(
        url.searchParams.get("limit") ?? String(CONNECTION_PAGE_SIZE),
      );

      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/v1/admin/user_connections") {
        const page = rows.slice(offset, Math.min(offset + limit, served));
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        // The one varying thing. `undefined` disappears from the JSON, which is the vendor that
        // never sent the field at all.
        if (total !== undefined) body.total_count = total;
        return Response.json(body);
      }

      if (url.pathname === "/v1/admin/auth_providers") {
        return Response.json({
          items: [
            { id: "google-openbot", provider_id: "google", type: "oauth2" },
          ],
          offset: 0,
          limit,
          page_count: 1,
          total_count: 1,
        });
      }

      if (url.pathname === "/v1/tools") {
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const page =
          offset === 0
            ? Array.from({ length: 4 }, (_, n) => toolRow(toolkit, n))
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
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, requests, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(held: number, served: number, total: unknown): Engine {
  running = startEngine(held, served, total);
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

const deletesSpent = (e: Engine): number =>
  e.requests.filter(
    (r) => r.startsWith("DELETE ") && r.includes("/v1/admin/user_connections/"),
  ).length;

type Outcome =
  | { kind: "returned"; value: boolean }
  | { kind: "threw"; message: string };

async function revokeOutcome(
  broker: ReturnType<typeof createArcadeClient>["broker"],
): Promise<Outcome> {
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

describe("a total_count the vendor sent is read, or refused, but never ignored", () => {
  /**
   * THE DEFECT ITSELF. 250 held, 100 served, the claim spelled as a string. Before the fix this
   * answered `true` after 100 DELETEs; the cross-check must fire instead, and it must fire BEFORE
   * any DELETE is spent, so the local row survives to name the app on a second press.
   */
  test("a numeric string is the vendor saying a number, and the cross-check fires on it", async () => {
    const e = engine(250, 100, "250");
    const { broker } = createArcadeClient("never-dialled");

    const outcome = await revokeOutcome(broker);

    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") return;
    expect(outcome.message).toBe(
      "Arcade listed 100 of 250 connections, so what this account holds at Gmail could not be read in full.",
    );
    expect(deletesSpent(e)).toBe(0);
  });

  /** The same spelling on a WHOLE listing is not an error: it reads as the number it is. */
  test("a numeric string on a whole listing revokes normally", async () => {
    const e = engine(3, 3, "3");
    const { broker } = createArcadeClient("never-dialled");

    expect(await revokeOutcome(broker)).toEqual({
      kind: "returned",
      value: true,
    });
    expect(deletesSpent(e)).toBe(3);
  });

  /**
   * EVERY OTHER VALUE THE VENDOR SENT REFUSES. Each of these would, under a lenient reading, go
   * back to answering "the vendor did not say" and re-open the defect above verbatim — so the
   * refusal is the assertion, and the listing underneath is a WHOLE one to make the point that it
   * is the claim about the length, not the list, that could not be read.
   */
  const unreadable: [string, unknown, string][] = [
    ["a word", "many", '"many"'],
    ["the literal null", null, "null"],
    ["an object", { count: 3 }, "an object"],
    ["a boolean", true, "true"],
    ["a negative", -1, "-1"],
    ["a fraction", 1.5, "1.5"],
    ["an exponent spelling", "1e3", '"1e3"'],
    ["an empty string", "", '""'],
  ];
  for (const [name, value, shown] of unreadable) {
    test(`total_count as ${name} refuses rather than disabling the cross-check`, async () => {
      const e = engine(3, 3, value);
      const { broker } = createArcadeClient("never-dialled");

      const outcome = await revokeOutcome(broker);

      expect(outcome.kind).toBe("threw");
      if (outcome.kind !== "threw") return;
      expect(outcome.message).toBe(
        `Arcade reported its connection list's total_count as ${shown}, which is not a count, so whether what this account holds at Gmail was listed in full could not be checked.`,
      );
      expect(deletesSpent(e)).toBe(0);
    });
  }

  /**
   * AND AN ABSENT FIELD IS STILL SILENCE. `total_count` is optional on the wire; refusing for its
   * absence would take every engine that omits it offline, which is the opposite mistake.
   */
  test("an omitted total_count still means the vendor did not say", async () => {
    const e = engine(3, 3, undefined);
    const { broker } = createArcadeClient("never-dialled");

    expect(await revokeOutcome(broker)).toEqual({
      kind: "returned",
      value: true,
    });
    expect(deletesSpent(e)).toBe(3);
  });
});
