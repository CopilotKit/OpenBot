import { afterEach, expect, test } from "bun:test";
import {
  exportAuditEvents,
  listAuditEvents,
} from "../src/lib/api/generated/audit-events/audit-events";
import { ORGANIZATION_ID } from "../src/lib/api/request";
import { auditExport } from "./audit-api";

/**
 * What the generated client makes of a success, by what the spec says the operation answers.
 *
 * Every operation answers JSON but one: the audit trail's export, declared `text/csv`, which reads as
 * the file. Anything else that is not JSON is still a failed request, such as the web app's own page
 * answering an address the server does not serve, so a screen never reads HTML as data.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(response: () => Response) {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

test("the export reads as the file, and its headers reach the caller", async () => {
  answer(() => auditExport("id,createdAt\n", 5000));
  let truncated: string | null = null;

  const csv = await exportAuditEvents(
    ORGANIZATION_ID,
    { eventType: "computer.action_refused" },
    {
      onResponse: (response) => {
        truncated = response.headers.get("openbot-export-truncated");
      },
    },
  );

  expect(csv).toBe("id,createdAt\n");
  expect(truncated as string | null).toBe("5000");
});

test("a page answering a JSON operation is a failed request, with the caller's words", async () => {
  answer(
    () =>
      new Response("<!doctype html><title>OpenBot</title>", {
        headers: { "content-type": "text/html" },
      }),
  );

  await expect(
    listAuditEvents(ORGANIZATION_ID, undefined, {
      fallback: "Could not load audit events",
    }),
  ).rejects.toThrow("Could not load audit events");
});
