import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  catalogueEntry,
  classifyTool,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import { type GrantedTool, grantedToolGuidance } from "../src/plugins/tools";

const tool = (server: string, name: string): GrantedTool => ({
  name: `mcp__${server}__${name}`,
  ref: `${server}/${name}`,
  description: "Public web",
  parameters: z.object({}),
  execute: async () => "unused",
});
const pair = (server = "parallel") => [
  tool(server, "web_search"),
  tool(server, "web_fetch"),
];
describe("Parallel public-web research", () => {
  test("pins anonymous and authenticated configurations to the official endpoint", () => {
    for (const key of ["parallel", "parallel-authenticated"]) {
      const resolved = resolveServerUrl(key, "https://attacker.example");
      expect(resolved?.url).toBe("https://search.parallel.ai/mcp");
      expect(classifyTool(resolved!.entry, "web_search", true)).toBe("read");
      expect(classifyTool(resolved!.entry, "web_fetch", true)).toBe("read");
      expect(classifyTool(resolved!.entry, "not_advertised", false)).toBe(
        "write",
      );
      expect(classifyTool(resolved!.entry, "web_search", true, "write")).toBe(
        "write",
      );
    }
    expect(catalogueEntry("parallel")?.auth.kind).toBe("none");
    expect(serverCredentialKind(catalogueEntry("parallel")!)).toBeNull();
    expect(
      serverCredentialKind(catalogueEntry("parallel-authenticated")!),
    ).toBe("mcp");
  });
  test("describes Parallel only while both research tools are actually offered", () => {
    expect(grantedToolGuidance(pair())).toContain(
      "Parallel provides public-web search and extraction",
    );
    // Described, not preferred: a Bot holding another search tool is not told to pass it over.
    expect(grantedToolGuidance(pair())).not.toContain("by default");
    expect(grantedToolGuidance([tool("parallel", "web_search")])).not.toContain(
      "Parallel provides public-web search and extraction",
    );
    expect(grantedToolGuidance([], ["parallel"])).not.toContain(
      "Parallel provides public-web search and extraction",
    );
    expect(grantedToolGuidance([])).toBe("");
  });
  test("uses deployment-authenticated research when both connectors are authorized", () => {
    const guidance = grantedToolGuidance([
      ...pair(),
      ...pair("parallel-authenticated"),
    ]);
    expect(guidance).toContain(
      "mcp__parallel-authenticated__web_search and mcp__parallel-authenticated__web_fetch discover sources",
    );
    expect(guidance).toContain(
      "it does not connect a person's private account",
    );
  });
  test("ships a Research Desk declaration referencing catalogue tools without granting access", () => {
    const skills = parse(
      readFileSync(
        new URL("../../examples/fintech/skills.yaml", import.meta.url),
        "utf8",
      ),
    ).skills;
    const skill = skills.find(
      (item: { slug: string }) => item.slug === "research-public-web",
    );
    expect(skill.tools).toEqual([
      "parallel/web_search",
      "parallel/web_fetch",
      "parallel-authenticated/web_search",
      "parallel-authenticated/web_fetch",
    ]);
    const desk = parse(
      readFileSync(
        new URL(
          "../../examples/fintech/catalog/research-desk.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(desk.skills).toContain("research-public-web");
  });
});
