import { describe, expect, test } from "bun:test";
import { auditFilterParams } from "../src/lib/audit/queries";

/**
 * The filters a view of the Audit page asks the API for, in the list and the export alike.
 *
 * The page builds each view as a query string. The file must carry the page's current filter, or the
 * download and the table disagree about what was reviewed. Paging belongs to the list, and `format`
 * to the address the export used to share with it, so neither is a filter.
 */

describe("auditFilterParams", () => {
  test("no filter asks for the whole trail", () => {
    expect(auditFilterParams()).toEqual({});
    expect(auditFilterParams("")).toEqual({});
  });

  test("the current filter travels as it is, several values in one parameter", () => {
    expect(
      auditFilterParams(
        "?eventType=computer.action_refused,mcp.call_rejected&bot=inbox&excludeCalls=ROUTINES_CREATE",
      ),
    ).toEqual({
      eventType: "computer.action_refused,mcp.call_rejected",
      bot: "inbox",
      excludeCalls: "ROUTINES_CREATE",
    });
  });

  test("paging and format are dropped, and anything that is not a filter with them", () => {
    expect(
      auditFilterParams(
        "?eventType=computer.action_allowed&limit=50&cursor=abc&format=csv&view=blocked",
      ),
    ).toEqual({ eventType: "computer.action_allowed" });
  });
});
