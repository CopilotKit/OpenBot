import { describe, expect, test } from "bun:test";
import { normalizedServerAddress } from "../src/admin/controls";
import { serverIdFor } from "../src/plugins/route-groups/servers";

/**
 * The two pure rules behind adding a server by URL: how an address on the MCP allowlist is compared
 * with the address somebody typed, and the id a server's name becomes.
 */
describe("an address on the MCP allowlist", () => {
  test("matches the same server however the address is written", () => {
    const figma = normalizedServerAddress("https://mcp.figma.com/mcp");
    expect(figma).toBe("https://mcp.figma.com/mcp");
    for (const spelling of [
      "https://mcp.figma.com/mcp/",
      "https://MCP.Figma.com/mcp",
      " https://mcp.figma.com/mcp ",
      "https://mcp.figma.com/mcp#section",
      "https://mcp.figma.com/mcp?x=1",
    ]) {
      expect(normalizedServerAddress(spelling)).toBe(figma);
    }
  });

  test("tells a different server, port or path apart", () => {
    const figma = normalizedServerAddress("https://mcp.figma.com/mcp");
    for (const other of [
      "https://mcp.figma.com/sse",
      "https://mcp.figma.com:8443/mcp",
      "http://mcp.figma.com/mcp",
      "https://api.fireflies.ai/mcp",
    ]) {
      expect(normalizedServerAddress(other)).not.toBe(figma);
    }
  });

  test("is not an address when the entry is a server id", () => {
    for (const id of ["notion", "google-drive", "composio-gmail", "figma"]) {
      expect(normalizedServerAddress(id)).toBeNull();
    }
  });
});

describe("the id a server added by URL is stored under", () => {
  test("is its name in lower-case letters, numbers and hyphens", () => {
    expect(serverIdFor("Figma", new Set())).toBe("figma");
    expect(serverIdFor("Fireflies.ai Notes", new Set())).toBe(
      "fireflies-ai-notes",
    );
    expect(serverIdFor("DeepWiki", new Set(["deepwiki"]))).toBe("deepwiki-2");
  });

  test("keeps clear of names OpenBot already uses", () => {
    expect(serverIdFor("Notion", new Set())).toBe("mcp-notion");
    expect(serverIdFor("Memory", new Set())).toBe("mcp-memory");
    expect(serverIdFor("Composio Gmail", new Set())).toBe("mcp-composio-gmail");
    expect(serverIdFor("New", new Set())).toBe("mcp-new");
    expect(serverIdFor("!", new Set())).toBe("mcp-server");
  });
});
