import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Journal } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import {
  catalogueEntry,
  tokenHeaderForServer,
} from "../src/plugins/catalogue";
import { listTools } from "../src/plugins/mcp";
import { CustomServerRefusedError } from "../src/plugins/plugin-store/model";
import { resolveTokenHeader } from "../src/plugins/plugin-store/servers";

/**
 * A custom server naming the header its token travels in (issue #817).
 *
 * OpenBot's own Composio integration is brokered and untouched by this change. What was missing
 * was the general capability: a server added by URL had no catalogue entry to name a header in,
 * so its token could only ever travel as `Authorization: Bearer` — and a vendor that reads its
 * key from a header of its own, as Composio's consumer endpoint reads `x-consumer-api-key`,
 * could not be reached at all. These cases pin the three layers that capability stands on: the
 * header name is validated before it is stored, the stored header is what the wire carries, and a
 * catalogue entry still wins wherever one exists.
 */
describe("resolveTokenHeader", () => {
  test("accepts a vendor header name, trimmed", () => {
    expect(resolveTokenHeader("x-consumer-api-key")).toBe(
      "x-consumer-api-key",
    );
    expect(resolveTokenHeader("  X-API-Key  ")).toBe("X-API-Key");
  });

  test("an absent header leaves the column alone", () => {
    expect(resolveTokenHeader(undefined)).toBeUndefined();
  });

  test("an empty or whitespace-only header clears back to the default", () => {
    expect(resolveTokenHeader("")).toBeNull();
    expect(resolveTokenHeader("   ")).toBeNull();
  });

  test.each([
    ["a space inside the name", "x api key"],
    ["a CRLF smuggling a second header", "x-api-key\r\nX-Injected: 1"],
    ["a slash, which is not a header-name character", "x/api"],
    ["a colon, which would split the header line", "x:api"],
    ["a non-string value", 42],
  ])("refuses %s", (_name, value) => {
    expect(() => resolveTokenHeader(value)).toThrow(
      CustomServerRefusedError,
    );
  });
});

describe("tokenHeaderForServer", () => {
  test("a catalogue entry's header wins over a stored row header", () => {
    expect(
      tokenHeaderForServer(
        catalogueEntry("exa-authenticated"),
        "x-consumer-api-key",
      ),
    ).toBe("x-api-key");
  });

  test("a catalogue entry without a header means the default, even with a row header", () => {
    expect(
      tokenHeaderForServer(catalogueEntry("parallel"), "x-consumer-api-key"),
    ).toBeUndefined();
  });

  test("a custom server with no entry falls back to its stored header", () => {
    expect(tokenHeaderForServer(null, "x-consumer-api-key")).toBe(
      "x-consumer-api-key",
    );
  });

  test("a custom server with no stored header means the default", () => {
    expect(tokenHeaderForServer(null, null)).toBeUndefined();
  });
});

describe("listTools over a custom token header", () => {
  const mock = new MCPMock();
  const journal = new Journal();
  let url = "";

  /** Every tool needs one: the SDK rejects an entire listing that omits a single `inputSchema`. */
  const NO_ARGUMENTS = { type: "object", properties: {} } as const;

  beforeAll(async () => {
    mock.addTool({
      name: "consumer-echo",
      description: "Says nothing back.",
      inputSchema: NO_ARGUMENTS,
    });
    mock.setJournal(journal);
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop?.();
  });

  /** The headers the mock journaled, with keys lower-cased as they arrive off the wire. */
  function journaledHeaders(): Record<string, string>[] {
    return (mock.getRequests() as { headers?: Record<string, unknown> }[]).map(
      (entry) => {
        const lowered: Record<string, string> = {};
        for (const [key, value] of Object.entries(entry.headers ?? {})) {
          lowered[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
        return lowered;
      },
    );
  }

  test("a stored header carries the token exactly as stored, and no Authorization goes with it", async () => {
    const listed = await listTools({
      url,
      token: "tok-123",
      tokenHeader: "x-consumer-api-key",
    });
    expect(listed.map((tool) => tool.name)).toContain("consumer-echo");

    const headers = journaledHeaders();
    expect(headers.length).toBeGreaterThan(0);
    expect(
      headers.some(
        (request) => request["x-consumer-api-key"] === "tok-123",
      ),
    ).toBe(true);
    expect(
      headers.some((request) => "authorization" in request),
    ).toBe(false);
  });

  test("without a header the token still travels as Authorization", async () => {
    await listTools({ url, token: "tok-456" });
    const headers = journaledHeaders();
    /*
     * Presence, not the value: the mock's journal redacts recognised credential headers to
     * "[REDACTED]", so the value itself cannot be read back here. That an `authorization`
     * header was sent at all is the assertion — and the first case above already proves the
     * custom header is sent instead when one is named.
     */
    expect(
      headers.some(
        (request) => request["authorization"] === "[REDACTED]",
      ),
    ).toBe(true);
  });
});
