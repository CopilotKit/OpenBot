import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import {
  RESEARCH_TOOLS as SHARED_RESEARCH_TOOLS,
  researchRoleOf,
} from "@openbot/shared/research";
import { parse } from "yaml";
import { z } from "zod";
import {
  catalogueEntry,
  classifyTool,
  researchRoleFor,
  resolveServerUrl,
  serverCredentialKind,
  tokenHeaderFor,
} from "../src/plugins/catalogue";
import { listTools } from "../src/plugins/mcp";
import { selectTools } from "../src/plugins/selection";
import { grantedToolGuidance } from "../src/plugins/tools";

const tool = (server: string, name: string): GrantedTool => ({
  name: `mcp__${server}__${name}`,
  ref: `${server}/${name}`,
  description: "Public web",
  parameters: z.object({}),
  execute: async () => "unused",
});
const RESEARCH_TOOLS: Record<string, [string, string]> = {
  parallel: ["web_search", "web_fetch"],
  "parallel-authenticated": ["web_search", "web_fetch"],
  exa: ["web_search_exa", "web_fetch_exa"],
  "exa-authenticated": ["web_search_exa", "web_fetch_exa"],
  firecrawl: ["firecrawl_search", "firecrawl_scrape"],
  "firecrawl-authenticated": ["firecrawl_search", "firecrawl_scrape"],
};
const pair = (server = "parallel") =>
  (RESEARCH_TOOLS[server] ?? []).map((name) => tool(server, name));

describe("research providers in the catalogue", () => {
  test("each is pinned to its vendor's official endpoint", () => {
    const urls: Record<string, string> = {
      parallel: "https://search.parallel.ai/mcp",
      "parallel-authenticated": "https://search.parallel.ai/mcp",
      exa: "https://mcp.exa.ai/mcp",
      "exa-authenticated": "https://mcp.exa.ai/mcp",
      firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
      "firecrawl-authenticated": "https://mcp.firecrawl.dev/v2/mcp",
    };
    for (const [key, url] of Object.entries(urls)) {
      expect(resolveServerUrl(key, "https://attacker.example")?.url).toBe(url);
    }
  });

  test("names its search and fetch tools, and both read", () => {
    for (const [key, [search, fetch]] of Object.entries(RESEARCH_TOOLS)) {
      const entry = catalogueEntry(key)!;
      expect(SHARED_RESEARCH_TOOLS[key]).toMatchObject({ search, fetch });
      expect(classifyTool(entry, search, true)).toBe("read");
      expect(classifyTool(entry, fetch, true)).toBe("read");
      expect(classifyTool(entry, "not_advertised", false)).toBe("write");
      expect(classifyTool(entry, search, true, "write")).toBe("write");
      expect(researchRoleFor(`${key}/${search}`)).toBe("search");
      expect(researchRoleFor(`${key}/${fetch}`)).toBe("fetch");
    }
    expect(researchRoleFor("notion/notion-search")).toBeNull();
    // The app labels research from this table, so every key must be a real catalogue entry.
    for (const key of Object.keys(SHARED_RESEARCH_TOOLS))
      expect(catalogueEntry(key)).not.toBeNull();
    // Instructions are built from these, so a tool missing its ref must not throw.
    expect(researchRoleFor(undefined as never)).toBeNull();
    expect(
      grantedToolGuidance([{ name: "mcp__drive__search" } as GrantedTool]),
    ).toContain("drive: search");
  });

  test("a tool outside an entry's reads is a write, even one the vendor called a read", () => {
    const firecrawl = catalogueEntry("firecrawl")!;
    // Published as a family, so no write list could have named it.
    expect(classifyTool(firecrawl, "firecrawl_monitor_delete", true)).toBe(
      "write",
    );
    expect(
      classifyTool(firecrawl, "firecrawl_monitor_delete", true, "read"),
    ).toBe("write");
    expect(classifyTool(firecrawl, "firecrawl_crawl", true)).toBe("write");
    expect(classifyTool(firecrawl, "firecrawl_map", true)).toBe("read");
    expect(classifyTool(firecrawl, "firecrawl_parse", true)).toBe("read");
    // Spends credits on a multi-step run.
    expect(classifyTool(catalogueEntry("exa")!, "agent_run", true)).toBe(
      "write",
    );
  });

  test("says whose credential each uses, and where Exa's key goes", () => {
    expect(serverCredentialKind(catalogueEntry("parallel")!)).toBeNull();
    expect(serverCredentialKind(catalogueEntry("exa")!)).toBeNull();
    expect(serverCredentialKind(catalogueEntry("firecrawl")!)).toBeNull();
    for (const key of [
      "parallel-authenticated",
      "exa-authenticated",
      "firecrawl-authenticated",
    ])
      expect(serverCredentialKind(catalogueEntry(key)!)).toBe("mcp");
    expect(tokenHeaderFor(catalogueEntry("exa-authenticated"))).toBe(
      "x-api-key",
    );
    expect(
      tokenHeaderFor(catalogueEntry("firecrawl-authenticated")),
    ).toBeUndefined();
    expect(tokenHeaderFor(catalogueEntry("parallel"))).toBeUndefined();
    expect(tokenHeaderFor(null)).toBeUndefined();
  });
});

describe("what a Bot is told about research", () => {
  test("a provider is described only while both of its tools are held", () => {
    for (const server of Object.keys(RESEARCH_TOOLS)) {
      const guidance = grantedToolGuidance(pair(server));
      expect(guidance).toContain("For public-web research you can use:");
      expect(guidance).toContain("do not connect a person's private account");
      // Described, not preferred: a Bot holding another search tool is not told to pass it over.
      expect(guidance).not.toContain("by default");
      // Searches unprompted for facts that change, and only a little.
      expect(guidance).toContain(
        "Search before answering when the answer depends on facts that change",
      );
      expect(guidance).toContain("a search or two");
      expect(grantedToolGuidance(pair(server).slice(0, 1))).not.toContain(
        "public-web research",
      );
    }
    expect(grantedToolGuidance([], ["exa"])).not.toContain(
      "public-web research",
    );
    expect(grantedToolGuidance([])).toBe("");
  });

  test("names each provider's own tools and adds only its own notes", () => {
    const exa = grantedToolGuidance(pair("exa"));
    expect(exa).toContain(
      "- Exa: mcp__exa__web_search_exa finds sources and mcp__exa__web_fetch_exa reads selected pages.",
    );
    expect(exa).not.toContain("session_id");
    expect(exa).toContain("Do not name the provider in your answer");
    expect(grantedToolGuidance(pair())).toContain(
      "Parallel: Generate one session_id",
    );
  });

  test("a vendor added twice is described once, with its key", () => {
    const guidance = grantedToolGuidance([
      ...pair(),
      ...pair("parallel-authenticated"),
    ]);
    expect(guidance).toContain(
      "- Parallel: mcp__parallel-authenticated__web_search finds sources",
    );
    expect(guidance).not.toContain("mcp__parallel__web_search");
  });

  test("two vendors are both described, and the person's choice decides", () => {
    const guidance = grantedToolGuidance([...pair(), ...pair("firecrawl")]);
    expect(guidance).toContain("- Parallel:");
    expect(guidance).toContain("- Firecrawl:");
    expect(guidance).toContain("Use the one the person asks for.");
  });
});

describe("a skill declaring research by role", () => {
  const others = Array.from({ length: 12 }, (_, index) => ({
    ref: `slack/tool_${index}`,
  }));
  const research = {
    slug: "research",
    title: "Research",
    summary: "Research the public web.",
    tools: ["@research/search", "@research/fetch"],
  };
  const slack = {
    slug: "slack",
    title: "Slack",
    summary: "Slack.",
    tools: others.map((entry) => entry.ref),
  };
  const choose = (slug: string) => async () =>
    JSON.stringify({ skills: [slug] });

  test("brings whichever provider's tools the Bot holds", async () => {
    const tools = [
      ...others,
      { ref: "exa/web_search_exa" },
      { ref: "exa/web_fetch_exa" },
      { ref: "exa/web_search_advanced_exa" },
    ];
    const selection = await selectTools({
      tools,
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("exa/web_search_exa");
    expect(offered).toContain("exa/web_fetch_exa");
    expect(offered).not.toContain("slack/tool_0");
    // Not a research role, and no skill declares it, so it is offered as any undeclared tool is.
    expect(offered).toContain("exa/web_search_advanced_exa");
  });

  test("never offers a provider the Bot was not granted", async () => {
    const selection = await selectTools({
      tools: [...others, { ref: "firecrawl/firecrawl_search" }],
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toEqual(["firecrawl/firecrawl_search"]);
  });

  test("a role ref is only ever the two roles", () => {
    expect(researchRoleOf("@research/search")).toBe("search");
    expect(researchRoleOf("@research/fetch")).toBe("fetch");
    expect(researchRoleOf("@research/delete")).toBeNull();
    expect(researchRoleOf("@research/search/more")).toBeNull();
    expect(researchRoleOf("research/search")).toBeNull();
  });

  test("the shipped Research Desk skill declares roles, not one provider", () => {
    const skills = parse(
      readFileSync(
        new URL("../../examples/fintech/skills.yaml", import.meta.url),
        "utf8",
      ),
    ).skills;
    const skill = skills.find(
      (item: { slug: string }) => item.slug === "research-public-web",
    );
    expect(skill.tools).toEqual(["@research/search", "@research/fetch"]);
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

describe("the header a deployment token is sent in", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Headers | undefined;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen ??= request.headers;
        return new Response("no", { status: 401 });
      },
    });
  });
  afterAll(() => server.stop(true));

  const listed = async (connection: {
    token: string;
    tokenHeader?: string;
  }) => {
    seen = undefined;
    await listTools({
      url: `http://127.0.0.1:${server.port}/mcp`,
      ...connection,
    }).catch(() => undefined);
    return seen;
  };

  test("is Authorization as a Bearer token by default", async () => {
    const headers = await listed({ token: "secret" });
    expect(headers?.get("authorization")).toBe("Bearer secret");
  });

  test("is the vendor's own header, as stored, when the entry names one", async () => {
    const headers = await listed({
      token: " secret ",
      tokenHeader: "x-api-key",
    });
    expect(headers?.get("x-api-key")).toBe("secret");
    expect(headers?.get("authorization")).toBeNull();
  });
});
