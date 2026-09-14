import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import {
  auditEventTypes,
  createAuditStore,
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

/**
 * Every event type this deployment declares, it can actually write.
 *
 * The taxonomy is the trail's vocabulary, and a name in it is a promise that this deployment can
 * produce that row. Four of them could not: `connector.sync_succeeded`, `connector.sync_failed`,
 * `knowledge.searched` and `agent.invoked` outlived the document-index and connector-sync code that
 * wrote them, and stayed in the list for months because the test above named them explicitly and
 * nothing else asked. An operator filtering for one got an empty page that reads as "nothing
 * happened" rather than "nothing can".
 *
 * Read off the source rather than maintained by hand, because a hand-kept list is the thing that
 * just failed. Literal strings only: every writer today passes the type as a literal, and one that
 * computed it would fail here and should — a row type a reader cannot grep for is worse than this
 * test being strict.
 */
describe("the audit event taxonomy", () => {
  test("declares nothing this deployment cannot write", () => {
    const root = join(import.meta.dir, "..", "src");
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && entry.name !== "audit.ts") {
          sources.push(readFileSync(path, "utf8"));
        }
      }
    };
    walk(root);
    const everywhereElse = sources.join("\n");

    const unwritable = auditEventTypes.filter(
      (type) => !everywhereElse.includes(JSON.stringify(type)),
    );
    expect(unwritable).toEqual([]);
  });
});

describe("audit payload redaction", () => {
  test("defines the audit event taxonomy", () => {
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "configuration.changed",
        "credential.created",
        "credential.rotated",
        "credential.revoked",
        "mcp.call_succeeded",
        "mcp.call_rejected",
      ]),
    );
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

  test("a direct store insert is redacted too", async () => {
    // Redaction used to live only in recordAuditEvent, so a direct insert()
    // stored secrets in cleartext. The store is the last line of defence.
    let stored: unknown;
    const store = createAuditStore({
      insert: () => ({
        values: async (event: unknown) => {
          stored = event;
        },
      }),
    } as never);

    await store.insert({
      eventType: "credential.created",
      targetType: "credential",
      targetId: "credential-1",
      payload: { apiKey: "plaintext-key", provider: "openai" },
    } as never);

    expect(stored).toMatchObject({
      payload: { apiKey: "[REDACTED]", provider: "openai" },
    });
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
