import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventQuery,
  type AuditReader,
  type AuditStore,
  auditEventsToCsv,
  readAuditExportRows,
} from "../src/audit";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * CSV export for the admin audit trail.
 *
 * Admin > Audit was the only read surface, so a review that needed evidence — a compliance
 * pull, an incident timeline — had nowhere to take it. `?format=csv` answers the same
 * filtered query as the JSON list as RFC 4180 CSV, capped so an unbounded trail cannot
 * become an unbounded response.
 */

const config = loadConfig({ ...testEnvironment() });

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
  actorUserId: "user-1",
  initiatorKind: "person",
  initiatorId: null,
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: null,
  payload: { action: "computer_click", bot: "bot-1" },
  createdAt: "2026-08-13T12:00:00.000Z",
  ...overrides,
});

const readerOf = (pages: { events: AuditEvent[]; nextCursor?: string }[]) => {
  const seen: AuditEventQuery[] = [];
  let call = 0;
  const reader: AuditReader = {
    list: async (query) => {
      seen.push(query);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return page;
    },
  };
  return { reader, seen };
};

const appWith = (reader: AuditReader, store?: AuditStore) =>
  createApp(
    config,
    adminAuth,
    { rolesForUser: async () => ["admin"] },
    reader,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );

const storeOf = () => {
  const recorded: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (input) => {
      recorded.push(input);
    },
  };
  return { store, recorded };
};

describe("auditEventsToCsv", () => {
  // Text people and Bots control opens in a spreadsheet as text, never as a formula.
  test("a cell a spreadsheet would run as a formula is neutralised", () => {
    const csv = auditEventsToCsv([
      event({
        targetId: '=HYPERLINK("https://example.test","x")',
        actorUserId: "@admin",
        payload: { bot: "+cmd", decision: { allowed: true, rule: "-1+1" } },
      }),
    ]);
    const row = csv.split("\n")[1] as string;
    expect(row).toContain(`"'=HYPERLINK(""https://example.test"",""x"")"`);
    expect(row).toContain(",'@admin,");
    expect(row).toContain(",'-1+1,'+cmd,");
    // What the trail writes itself is left alone: the ID, the time and the JSON payload.
    expect(row.startsWith("6f1b7f28-")).toBe(true);
    expect(row).toContain(",2026-08-13T12:00:00.000Z,");
  });

  test("an empty trail is a header, so an empty export still opens as a table", () => {
    expect(auditEventsToCsv([])).toBe(`${AUDIT_EXPORT_COLUMNS.join(",")}\n`);
  });

  test("one row carries the filterable columns plus the redacted payload as JSON", () => {
    const csv = auditEventsToCsv([
      event({
        payload: {
          bot: "bot-1",
          decision: { allowed: false, rule: "deny-outside-hours" },
        },
      }),
    ]);
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(row).toContain("computer.action_allowed");
    expect(row).toContain("bot-1");
    expect(row).toContain("false");
    expect(row).toContain("deny-outside-hours");
  });

  test("commas, quotes and newlines are quoted rather than split into columns", () => {
    const csv = auditEventsToCsv([
      event({
        eventType: 'weird,"type"',
        targetId: "line1\nline2",
        payload: { note: 'say "hi", then go' },
      }),
    ]);
    const [, row = ""] = csv.trim().split("\n");
    // The row is still one line per field-join: embedded newline is inside quotes.
    expect(row).toContain('"weird,""type"""');
    expect(csv).toContain('"line1\nline2"');
    // The payload travels as one JSON column, CSV-quoted: quotes doubled, JSON's own
    // backslash-escapes intact. Assert the shape rather than the full escape stack.
    expect(csv).toContain('"{""note""');
    expect(csv).toContain("hi");
  });

  test("a missing decision or bot leaves its column empty instead of guessing", () => {
    const [, row = ""] = auditEventsToCsv([event({ payload: {} })])
      .trim()
      .split("\n");
    const cells = row.split(",");
    // decisionAllowed, decisionRule, bot are columns 9-11 of 12.
    expect(cells.slice(8, 11)).toEqual(["", "", ""]);
  });
});

describe("readAuditExportRows", () => {
  test("walks every matching page and drops the list's own paging", async () => {
    const { reader, seen } = readerOf([
      { events: [event()], nextCursor: "page-2" },
      { events: [event({ id: "second" })] },
    ]);
    const base: AuditEventQuery = {
      limit: 1,
      cursor: "stale-bookmark",
      eventType: "computer.action_allowed",
    };
    const { events, truncated } = await readAuditExportRows(reader, base, {
      pageSize: 1,
    });
    expect(events.map((row) => row.id)).toEqual([
      "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
      "second",
    ]);
    expect(truncated).toBe(false);
    // Filters travel; the JSON list's cursor/limit do not.
    expect(seen[0]?.eventType).toBe("computer.action_allowed");
    expect(seen[0]?.limit).toBe(1);
    expect(seen[0]?.cursor).toBeUndefined();
  });

  test("stops at the cap and says so, rather than silently handing back a partial trail", async () => {
    const { reader } = readerOf([
      { events: [event(), event(), event()], nextCursor: "more" },
      { events: [event()], nextCursor: "more" },
    ]);
    const { events, truncated } = await readAuditExportRows(
      reader,
      { limit: 50 },
      { maxRows: 2, pageSize: 3 },
    );
    expect(events).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe("GET /api/admin/audit-events?format=csv", () => {
  test("answers CSV with a download disposition for the same filtered query", async () => {
    const { reader, seen } = readerOf([
      { events: [event()], nextCursor: undefined },
    ]);
    const response = await appWith(reader).request(
      "http://openbot.local/api/admin/audit-events?format=csv&eventType=computer.action_allowed",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain(
      "audit-events-",
    );
    expect(await response.text()).toContain("computer.action_allowed");
    expect(seen[0]?.eventType).toBe("computer.action_allowed");
  });

  test("a truncated export names it in a header instead of looking complete", async () => {
    const page = (start: number, next?: string) => ({
      events: Array.from({ length: 500 }, (_, index) =>
        event({
          id: `00000000-0000-4000-8000-${String(start + index).padStart(12, "0")}`,
        }),
      ),
      nextCursor: next,
    });
    // Eleven full pages: one more than the cap holds.
    const { reader } = readerOf(
      Array.from({ length: 11 }, (_, index) =>
        page(index * 500, index < 10 ? `page-${index + 2}` : undefined),
      ),
    );
    const capped = await appWith(reader).request(
      "http://openbot.local/api/admin/audit-events?format=csv",
    );
    expect(capped.status).toBe(200);
    expect(capped.headers.get("x-audit-export-truncated")).toBe(
      String(AUDIT_EXPORT_MAX_ROWS),
    );
    expect((await capped.text()).trim().split("\n")).toHaveLength(
      AUDIT_EXPORT_MAX_ROWS + 1,
    );

    const { reader: small } = readerOf([{ events: [event()] }]);
    const whole = await appWith(small).request(
      "http://openbot.local/api/admin/audit-events?format=csv",
    );
    expect(whole.headers.get("x-audit-export-truncated")).toBeNull();
  });

  test("taking the trail out is itself on the trail, with who, how much and which filter", async () => {
    const { reader } = readerOf([{ events: [event(), event()] }]);
    const { store, recorded } = storeOf();
    await appWith(reader, store).request(
      "http://openbot.local/api/admin/audit-events?format=csv&eventType=computer.action_allowed&limit=5",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: "audit.exported",
      targetType: "audit_trail",
      actorUserId: "admin",
      payload: {
        format: "csv",
        rows: 2,
        truncated: false,
        filters: { eventType: "computer.action_allowed" },
      },
    });
    // Paging belongs to the table, not the export, so it is not part of what was taken.
    const [exported] = recorded;
    expect(
      (exported?.payload as { filters?: Record<string, unknown> } | undefined)
        ?.filters,
    ).not.toHaveProperty("limit");

    // Reading the table is not an export.
    await appWith(reader, store).request(
      "http://openbot.local/api/admin/audit-events",
    );
    expect(recorded).toHaveLength(1);
  });

  test("an unknown format is a 400 naming the parameter", async () => {
    const { reader } = readerOf([{ events: [] }]);
    const response = await appWith(reader).request(
      "http://openbot.local/api/admin/audit-events?format=xlsx",
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Query parameter "format" must be "json" or "csv".',
    });
  });

  test("a bad date filter is still a 400 on the export path, not a downloaded error", async () => {
    const { reader } = readerOf([{ events: [] }]);
    const response = await appWith(reader).request(
      "http://openbot.local/api/admin/audit-events?format=csv&from=not-a-date",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the JSON list is unchanged when no format is asked for", async () => {
    const { reader } = readerOf([{ events: [event()] }]);
    const response = await appWith(reader).request(
      "http://openbot.local/api/admin/audit-events?eventType=computer.action_allowed",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: AuditEvent[] };
    expect(body.events).toHaveLength(1);
  });
});
