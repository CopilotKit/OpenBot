import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { createApp } from "../src/app";
import {
  auditEventTypes,
  recordAuditEvent,
  redactAuditPayload,
} from "../src/audit";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const config = loadConfig({
  ...testEnvironment(),
});

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

const memberAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "member", email: "member@openbot.test" },
    }),
  },
};

describe("audit payload redaction", () => {
  test("defines the v1 audit event taxonomy", () => {
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "configuration.changed",
        "credential.created",
        "credential.rotated",
        "credential.revoked",
        "connector.sync_succeeded",
        "connector.sync_failed",
        "knowledge.searched",
        "agent.invoked",
        "mcp.call_succeeded",
        "mcp.call_rejected",
      ]),
    );
  });

  /**
   * A template's whole life, both outcomes at every step.
   *
   * Named one by one rather than by prefix, because the list is closed and the pairs are the point:
   * dropping `_declined` while keeping `_granted` would leave a trail on which every administrator
   * appeared to have approved everything they were ever asked about.
   */
  test("records both ends of a template's life", () => {
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "template.exported",
        "template.import_refused",
        "template.imported",
        "template.capability_requested",
        "template.capability_granted",
        "template.capability_declined",
        "template.boundary_applied",
        "template.boundary_removed",
        "template.retracted",
      ]),
    );
  });

  /**
   * What the redaction below does and does not do for a template payload.
   *
   * Pinned because the temptation on this surface is to treat the key list as the thing that keeps a
   * stranger's prose off the trail, and it is not. It matches key NAMES: `prompt` and `content` are
   * dropped wherever they appear, and a field called `description`, `instructions` or `title` sails
   * through untouched. So the rule that a template row carries the slug, the digest and the counts
   * and never the words is enforced where the payload is BUILT, and this test says which half of
   * that is mechanical.
   *
   * `authorClaim` surviving is the intended half. It is an unverified claim, deliberately named as
   * one, and it is exactly the sort of thing a reader needs to see.
   */
  test("keeps a template row's identifying fields and drops the prose it must never carry", () => {
    expect(
      redactAuditPayload({
        templateSlug: "standup-bot",
        authorClaim: "someone@example.test",
        digest: "sha256:0f0f",
        hasKey: false,
        stripped: ["endpoint", "key"],
        prompt: "You are a helpful assistant with access to…",
        content: "the whole document",
      }),
    ).toEqual({
      templateSlug: "standup-bot",
      authorClaim: "someone@example.test",
      digest: "sha256:0f0f",
      hasKey: false,
      stripped: ["endpoint", "key"],
      prompt: "[REDACTED]",
      content: "[REDACTED]",
    });
  });

  test("removes secret values and document content recursively", () => {
    expect(
      redactAuditPayload({
        connector: "google_drive",
        accessToken: "sensitive-token",
        nested: {
          content: "full document body",
          resultCategory: "succeeded",
        },
      }),
    ).toEqual({
      connector: "google_drive",
      accessToken: "[REDACTED]",
      nested: {
        content: "[REDACTED]",
        resultCategory: "succeeded",
      },
    });
  });

  test("writes only the redacted payload to the audit store", async () => {
    const writes: unknown[] = [];

    await recordAuditEvent(
      {
        insert: async (event) => {
          writes.push(event);
        },
      },
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "plaintext-key", provider: "openai" },
      },
    );

    expect(writes).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "[REDACTED]", provider: "openai" },
      },
    ]);
  });
});

describe("audit event immutability", () => {
  /*
   * What the guard DOES is proved against a real database in
   * audit-retention.integration.test.ts. This asserts only that it is still installed by some
   * migration, and it reads the whole chain to do it.
   *
   * Reading 0000 alone stopped being true a while ago: 0007 replaced the function and 0012 replaced
   * it again and added the truncate trigger, so the old assertions described a definition no
   * database runs and would have gone on passing if the current one were edited out from under
   * them. A mirror test pinned to one file is a test of that file, not of the deployment.
   *
   * Reported by @beardthelion, alongside the TRUNCATE hole itself.
   */
  test("some migration still installs the append-only guard", async () => {
    const directory = new URL("../drizzle/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const chain = (
      await Promise.all(
        files.map((name) => readFile(new URL(name, directory), "utf8")),
      )
    ).join("\n");

    expect(chain).toContain("FUNCTION prevent_audit_event_mutation");
    expect(chain).toContain("BEFORE UPDATE OR DELETE ON audit_events");
    expect(chain).toContain("BEFORE TRUNCATE ON audit_events");
    expect(chain).toContain("Audit events are append-only");
    // A later migration removing either trigger would otherwise satisfy every line above.
    expect(chain).not.toContain("DROP TRIGGER audit_events_append_only");
    expect(chain).not.toContain("DROP TRIGGER audit_events_no_truncate");
  });
});

describe("admin audit API", () => {
  test("returns a filtered audit page to an administrator", async () => {
    const queries: unknown[] = [];
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async (query) => {
          queries.push(query);
          return {
            events: [
              {
                id: "event-1",
                eventType: "connector.sync_succeeded",
                targetType: "connector",
                targetId: "drive-1",
                actorUserId: "admin",
                payload: { itemCount: 3 },
                createdAt: "2026-08-13T12:00:00.000Z",
              },
            ],
            nextCursor: "next-page",
          };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?eventType=connector.sync_succeeded&limit=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          id: "event-1",
          eventType: "connector.sync_succeeded",
          targetType: "connector",
          targetId: "drive-1",
          actorUserId: "admin",
          payload: { itemCount: 3 },
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    });
    expect(queries).toEqual([
      { eventType: "connector.sync_succeeded", limit: 10 },
    ]);
  });

  test("denies a non-admin caller", async () => {
    const app = createApp(
      config,
      memberAuth,
      { rolesForUser: async () => ["user"] },
      { list: async () => ({ events: [] }) },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
  });
});
