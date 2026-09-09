import { describe, expect, test } from "bun:test";
import { classifyTool } from "../src/plugins/catalogue";

/**
 * What an action does, when the vendor said so and when nobody did.
 *
 * The property under test is the direction of the failure. A recorded `read` is the only input that
 * can produce a read; everything else — a recorded write, an unrecognised value, null, an empty
 * string — is a write. That asymmetry is the point: an action wrongly gated as a write costs a
 * confirmation, and one wrongly waved through as a read costs somebody's mailbox.
 */
describe("classifyTool with a recorded effect", () => {
  test("a recorded read is a read", () => {
    expect(classifyTool(null, "GMAIL_FETCH_EMAILS", true, "read")).toBe("read");
  });

  test("a recorded write is a write", () => {
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "write")).toBe("write");
  });

  test("no recorded effect is a write, not a read", () => {
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, null)).toBe("write");
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, undefined)).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "")).toBe("write");
  });

  test("a value nothing recognises is a write", () => {
    // A future label, a typo, or a column somebody wrote by hand. None is a licence to read.
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "readonly")).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "destructive")).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "READ")).toBe("write");
  });

  test("a recorded read cannot rescue an action the server never advertised", () => {
    // The name came from somewhere other than a listing, so no recorded effect is about it.
    expect(classifyTool(null, "GMAIL_INVENTED", false, "read")).toBe("write");
  });
});
