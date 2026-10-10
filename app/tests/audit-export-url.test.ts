import { describe, expect, test } from "bun:test";
import { auditExportUrl } from "../src/lib/audit/queries";

/**
 * The download behind Audit's Export button.
 *
 * The file must carry the page's current filter, or the download and the table disagree
 * about what was reviewed. Paging belongs to the JSON list and is dropped: the server
 * walks every matching page up to its cap.
 */

describe("auditExportUrl", () => {
  test("no filter exports the whole trail", () => {
    expect(auditExportUrl()).toBe("/api/admin/audit-events?format=csv");
    expect(auditExportUrl("")).toBe("/api/admin/audit-events?format=csv");
  });

  test("the current filter travels into the download", () => {
    expect(auditExportUrl("?eventType=computer.action_allowed")).toBe(
      "/api/admin/audit-events?eventType=computer.action_allowed&format=csv",
    );
  });

  test("paging is dropped and a stray format is replaced, not doubled", () => {
    expect(
      auditExportUrl("?eventType=computer.action_allowed&limit=50&cursor=abc"),
    ).toBe(
      "/api/admin/audit-events?eventType=computer.action_allowed&format=csv",
    );
    expect(auditExportUrl("?format=json")).toBe(
      "/api/admin/audit-events?format=csv",
    );
  });
});
