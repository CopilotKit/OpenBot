/**
 * The phone app's generated client is a tolerant reader (api/README.md, Enums that grow): a newer
 * server may answer with a field this app has never heard of, or a value it doesn't know in an enum the
 * spec declares open, and neither may break a read. This drives the generated functions and the
 * mutator for real, over HTTP, against a stand-in deployment that answers as a newer release would.
 *
 * What the phone's sign-in hands every request (src/auth.ts) and expo-crypto's randomUUID are the
 * platform here, stood in for as in generated-client.test.ts.
 */
import { afterAll, expect, mock, test } from "bun:test";

const ORG = "/api/v2/organizations/default";

/** A task as the spec's example has it, from a server that has added a status and a field. */
const task = {
  id: "7c2d6b1f-6f10-4a53-9d51-5f0d6c0e2f1a",
  botId: "general-assistant",
  conversationId: "5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10",
  threadId: null,
  title: "Reply to Sam about the spec",
  why: "Sam asked for the spec by Friday.",
  origin: "check_in",
  suggestionId: null,
  sourceApp: "Gmail",
  sourceLink: null,
  originConversationId: null,
  status: "parked",
  failure: null,
  failedAt: null,
  stoppedAt: null,
  next: "Read the draft and send it.",
  workingSince: null,
  lastActivityAt: "2026-11-14T09:05:00.000Z",
  resolvedAt: null,
  createdAt: "2026-11-14T09:00:00.000Z",
  updatedAt: "2026-11-14T09:05:00.000Z",
  priority: { by: "a newer server" },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /api/v2/people/me/organizations")
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme",
            role: "auditor",
            active: true,
            seats: 12,
          },
        ],
        canCreate: false,
        nextCursor: null,
        addedLater: true,
      });
    if (route === `GET ${ORG}/tasks/t_1`)
      return Response.json({ task, addedLater: true });
    if (route === `GET ${ORG}/routines/r_1/runs`)
      return Response.json({
        runs: [
          {
            id: "run_1",
            status: "cancelled",
            source: "schedule",
            startedAt: "2026-11-14T09:00:00.000Z",
            finishedAt: null,
            error: null,
            retriedBy: "a newer server",
          },
        ],
        nextCursor: null,
      });
    return Response.json(
      { detail: "Not found.", code: "NOT_FOUND" },
      { status: 404 },
    );
  },
});
const serverUrl = `http://127.0.0.1:${server.port}`;

mock.module("../src/auth", () => ({
  serverUrl,
  authClient: { getCookie: () => "better-auth.session_token=signed-in" },
}));
mock.module("expo-crypto", () => ({
  randomUUID: () => crypto.randomUUID(),
}));

const { getTask } = await import("../src/api/generated/tasks/tasks");
const { listRoutineRuns } = await import(
  "../src/api/generated/routines/routines"
);
const { listOrganizations } = await import(
  "../src/api/generated/organizations/organizations"
);
const { ORGANIZATION_ID } = await import("../src/api");

afterAll(() => {
  server.stop(true);
});

test("a task in a status this app doesn't know, with a field it doesn't know, reads as sent", async () => {
  const answer = await getTask(ORGANIZATION_ID, "t_1");
  expect(answer.task.status).toBe("parked");
  expect((answer.task as Record<string, unknown>).priority).toEqual({
    by: "a newer server",
  });
  expect((answer as Record<string, unknown>).addedLater).toBe(true);
});

test("a routine run in a status this app doesn't know reads as sent", async () => {
  const answer = await listRoutineRuns(ORGANIZATION_ID, "r_1");
  expect(answer.runs.map((run) => run.status)).toEqual(["cancelled"]);
});

test("an organization in which the person has a role this app doesn't know reads as sent", async () => {
  const answer = await listOrganizations();
  expect(answer.organizations.map((organization) => organization.role)).toEqual(
    ["auditor"],
  );
});
