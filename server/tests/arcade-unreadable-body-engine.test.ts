// server/tests/arcade-unreadable-body-engine.test.ts
/**
 * WHAT A BODY THIS DEPLOYMENT COULD NOT READ ANSWERS WITH — THE REFUSAL, NEVER A `TypeError`.
 *
 * `arcade-revoke-invariant.test.ts` pins the OUTCOME on three of these shapes: a 204 with
 * `content-length: 0`, a body whose JSON is the literal `null`, and `items: [null]` on the
 * user-connections listing. All three satisfied it BY ACCIDENT before this file existed — the
 * adapter did not refuse them, it crashed on an unguarded cast with
 * `TypeError: null is not an object`, and a crash is technically "not answering".
 *
 * That is worth its own file for two reasons the invariant cannot state:
 *
 *   1. AN ACCIDENT IS ONE TIDY-UP AWAY FROM THE LIVE DEFECT. The cast that crashed is exactly the
 *      kind a reviewer waves a `?? []` through as defensive hygiene — and with one, all three
 *      shapes become `revoke` answering `false` with no DELETE spent while the caller deletes the
 *      local row, which is what `broker.ts:712-717` forbids and what `28b13e4a` already fixed once
 *      on this branch. Asserting the SENTENCE, and not merely that something was thrown, is what
 *      makes that tidy-up fail a test instead of passing review.
 *   2. A RAW `TypeError` IS THE WRONG OPERATOR EXPERIENCE. It carries a vendor stack trace where
 *      this deployment's sentence belongs and is indistinguishable in the logs from a programmer
 *      error here.
 *
 * SERVED OVER A REAL SOCKET, for the invariant file's reason: these shapes ARE what the wire
 * carried, and a hand-built stub cannot pose them — `OffsetPage`'s constructor is the thing that
 * raises on two of the three, and a stub never passes through it.
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

/** A live, attributable user-connection row: the thing a DELETE would be spent on. */
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

/** What the connection listing answers. Everything else is the healthy live listing. */
type Shape =
  /** A 204 with `content-length: 0` on a PAGED endpoint. */
  | "listing-is-204"
  /** A 200 whose whole JSON value is `null`. */
  | "listing-is-json-null"
  /** A list with a hole in it: one unreadable row beside two real connections. */
  | "listing-item-is-null";

type Engine = { port: number; requests: string[]; stop: () => void };

function startEngine(shape: Shape): Engine {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");

      // THE DELETE, always available and always counted, so "no DELETE was spent" is a statement
      // about the adapter rather than about the stub.
      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/v1/admin/user_connections") {
        if (shape === "listing-is-204")
          return new Response(null, { status: 204 });
        if (shape === "listing-is-json-null") {
          return new Response("null", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return Response.json({
          items: [null, connectionRow(0), connectionRow(1)],
          offset,
          limit,
          page_count: 3,
          total_count: 3,
        });
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

type Thrown = { name: string; message: string };

async function revokeError(): Promise<Thrown> {
  const { broker } = createArcadeClient("never-dialled");
  try {
    const value = await broker.revoke({ account, toolkit: "Gmail" });
    // An ANSWER is the failure this file exists to catch, so it is reported as one rather than
    // left to a later assertion on an error that is not there.
    return { name: "returned", message: `revoke answered ${String(value)}` };
  } catch (error) {
    return {
      name: error instanceof Error ? error.constructor.name : "non-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The refusal sentence each shape is owed, VERBATIM. Written out rather than imported, because an
 * assertion that re-derives the sentence from the code under test asserts nothing about it.
 */
const EMPTY_BODY_REFUSAL =
  "Arcade answered the connection listing for Gmail with no body this deployment could read — an empty response, or one whose JSON is the literal null — so what it says is not known here.";
const HOLE_IN_LISTING_REFUSAL =
  "Arcade's connection list carried nothing where a connection belongs, so what this account holds at Gmail could not be read.";

describe("a vendor body this deployment cannot read answers with a refusal", () => {
  const cases: [Shape, string, string][] = [
    [
      "listing-is-204",
      "a 204 / content-length: 0 response on a paged endpoint",
      EMPTY_BODY_REFUSAL,
    ],
    [
      "listing-is-json-null",
      "a body whose JSON is the literal null",
      EMPTY_BODY_REFUSAL,
    ],
    [
      "listing-item-is-null",
      "items: [null] on the user-connections listing",
      HOLE_IN_LISTING_REFUSAL,
    ],
  ];

  for (const [shape, sentence, refusal] of cases) {
    test(`${sentence} refuses, and says so`, async () => {
      const e = engine(shape);
      const thrown = await revokeError();

      // THE SENTENCE AND NOT MERELY "IT THREW". Before this fix every one of these three raised
      // `TypeError: null is not an object`, which passes any "did it throw" assertion while
      // telling an operator nothing and leaving the invariant resting on a crash.
      expect({ shape, ...thrown }).toEqual({
        shape,
        name: "Error",
        message: refusal,
      });

      // AND NOTHING WAS WITHDRAWN ON THE WAY TO SAYING IT: a listing that could not be read whole
      // is not grounds for spending a DELETE on the rows that happened to be legible.
      expect(e.requests.filter((r) => r.startsWith("DELETE "))).toEqual([]);
    });
  }

  test("a TypeError is never what escapes", async () => {
    for (const shape of [
      "listing-is-204",
      "listing-is-json-null",
      "listing-item-is-null",
    ] as Shape[]) {
      engine(shape);
      const thrown = await revokeError();
      expect({ shape, name: thrown.name }).toEqual({ shape, name: "Error" });
      expect(thrown.message).not.toContain("is not an object");
      running?.stop();
      running = null;
      useArcadeClient(null);
    }
  });
});
