import { expect } from "bun:test";
import type { setupServer } from "msw/node";
import type { Team } from "@/lib/api/generated/model";

/**
 * What the team-grants tests share: a team as the API answers it, the addresses the two writes go
 * to, and a record of every write a screen sent.
 */

const ORGANIZATION = "/api/v2/organizations/default";

/** Where the teams an app is granted to are read and replaced. */
export function appTeamGrantsPath(appId: string): string {
  return `${ORGANIZATION}/apps/${encodeURIComponent(appId)}/team-grants`;
}

/** Where the teams a skill is granted to are read and replaced. */
export function skillTeamGrantsPath(skillId: string): string {
  return `${ORGANIZATION}/skills/${encodeURIComponent(skillId)}/team-grants`;
}

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/**
 * The server's answer to what the Teams row reads, for a test that fakes `fetch` by hand and is
 * about something else on the page: an organization with no teams, and an app or a skill granted to
 * none. Undefined for any other request.
 */
export function answerNoTeamGrants(
  input: RequestInfo | URL,
  init?: RequestInit,
): Response | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const path = new URL(String(input), "http://openbot.invalid").pathname;
  if (path === `${ORGANIZATION}/teams`)
    return NativeResponse.json({
      teams: [],
      canCreate: true,
      nextCursor: null,
    });
  if (
    path.startsWith(ORGANIZATION) &&
    /\/(apps|skills)\/[^/]+\/team-grants$/.test(path)
  )
    return NativeResponse.json({ teams: [] });
  return undefined;
}

/** One team of the organization, as listTeams answers it to an admin. */
export function team(id: string, name: string): Team {
  return {
    id,
    name,
    description: null,
    parentTeamId: null,
    source: "openbot",
    memberCount: 2,
    role: null,
    canManage: true,
    canMove: true,
    canDelete: true,
    createdAt: "2026-11-15T09:12:40.000Z",
  };
}

/** One write, as the server received it. */
export type SentWrite = {
  method: string;
  path: string;
  /** The `Idempotency-Key` header, or null when there was none. */
  key: string | null;
  body: unknown;
};

/** What `idempotencyKey()` writes. */
export const KEY = expect.stringMatching(/^[0-9a-f]{32}$/);

/** Every write the server receives from here on, in order, in the list this returns. */
export function recordWrites(
  server: ReturnType<typeof setupServer>,
): SentWrite[] {
  const writes: SentWrite[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "GET") return;
    const text = await request.clone().text();
    writes.push({
      method: request.method,
      path: new URL(request.url).pathname,
      key: request.headers.get("idempotency-key"),
      body: text ? JSON.parse(text) : undefined,
    });
  });
  return writes;
}
