import { describe, expect, test } from "bun:test";
import {
  installPlan,
  installPlugin,
  type InstallSteps,
} from "@/lib/agent-plugins/install";
import {
  frontMatter,
  MCP_SCHEMA_1_0_0,
  PLUGIN_SCHEMA_1_0_0,
  type PluginFile,
  pathInPlugin,
  readPlugin,
  wantsText,
} from "@/lib/agent-plugins/read";
import type { App } from "@/lib/api/generated/model";

/**
 * Installing an Agent Plugins folder: reading it against the 1.0.0 spec, mapping its skills and
 * servers onto OpenBot's, and installing them in an order where one failure stops nothing else.
 */

const manifest = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    $schema: PLUGIN_SCHEMA_1_0_0,
    name: "reports",
    version: "1.2.0",
    description: "Weekly reports.",
    ...fields,
  });

const skillMd = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const mcp = (servers: Record<string, unknown>) =>
  JSON.stringify({ $schema: MCP_SCHEMA_1_0_0, mcpServers: servers });

/** A `${NAME}` placeholder as a plugin writes it, spelled so it reads as data, not interpolation. */
const placeholder = (name: string) => `\${${name}}`;

function plugin(...files: [string, string | null][]): PluginFile[] {
  return files.map(([path, text]) => ({ path, text }));
}

function read(files: PluginFile[]) {
  const reading = readPlugin(files);
  if (!reading.ok) throw new Error(reading.error);
  return reading;
}

describe("reading a folder", () => {
  test("a folder picker's path drops the chosen folder's own name", () => {
    expect(pathInPlugin("reports/skills/weekly/SKILL.md")).toBe(
      "skills/weekly/SKILL.md",
    );
    expect(pathInPlugin("plugin.json")).toBe("plugin.json");
  });

  test("only manifests, server configs and SKILL.md files are read", () => {
    expect(wantsText("plugin.json")).toBe(true);
    expect(wantsText(".claude-plugin/plugin.json")).toBe(true);
    expect(wantsText("mcp.json")).toBe(true);
    expect(wantsText(".mcp.json")).toBe(true);
    expect(wantsText("skills/weekly/SKILL.md")).toBe(true);
    expect(wantsText("skills/weekly/scripts/run.sh")).toBe(false);
    expect(wantsText("skills/a/b/SKILL.md")).toBe(false);
    expect(wantsText("node_modules/x/plugin.json")).toBe(false);
  });

  test("a folder with no manifest says which folder to pick", () => {
    const reading = readPlugin(plugin(["README.md", null]));
    expect(reading).toEqual({
      ok: false,
      error: expect.stringContaining("no plugin.json"),
    });
  });
});

describe("plugin.json (Agent Plugins 1.0.0 §5)", () => {
  test("reads the name, version, description, skills and servers", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        [
          "skills/weekly/SKILL.md",
          skillMd("weekly", "Write the weekly report."),
        ],
        ["skills/weekly/references/template.md", null],
        [
          "mcp.json",
          mcp({
            tracker: {
              type: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          }),
        ],
      ),
    );
    expect(reading.format).toBe("agent-plugins");
    expect(reading.name).toBe("reports");
    expect(reading.version).toBe("1.2.0");
    expect(reading.skills).toEqual([
      {
        name: "weekly",
        description: "Write the weekly report.",
        body: "Do the thing.",
        otherFiles: ["skills/weekly/references/template.md"],
      },
    ]);
    expect(reading.servers).toEqual([
      { name: "tracker", url: "https://mcp.example.com/mcp" },
    ]);
    expect(reading.notes).toEqual([]);
  });

  test("a missing or other $schema rejects the plugin", () => {
    const without = readPlugin(
      plugin(["plugin.json", JSON.stringify({ name: "reports" })]),
    );
    expect(without.ok).toBe(false);
    const newer = readPlugin(
      plugin([
        "plugin.json",
        manifest({
          $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
        }),
      ]),
    );
    expect(newer).toEqual({
      ok: false,
      error:
        "This plugin is written for Agent Plugins 2.0.0. OpenBot reads 1.0.0.",
    });
  });

  test.each([
    ["My-Plugin"],
    ["-start"],
    ["has--double"],
    ["too.many..dots"],
    [""],
    ["a".repeat(65)],
  ])("the name %p rejects the plugin", (name) => {
    expect(readPlugin(plugin(["plugin.json", manifest({ name })])).ok).toBe(
      false,
    );
  });

  test.each([["acme.tools"], ["lint3r"], ["a"]])(
    "the name %p is valid",
    (name) => {
      expect(readPlugin(plugin(["plugin.json", manifest({ name })])).ok).toBe(
        true,
      );
    },
  );

  test("a wrongly typed field or author rejects the plugin", () => {
    expect(
      readPlugin(plugin(["plugin.json", manifest({ version: 2 })])).ok,
    ).toBe(false);
    expect(
      readPlugin(plugin(["plugin.json", manifest({ keywords: "reports" })])).ok,
    ).toBe(false);
    expect(
      readPlugin(
        plugin([
          "plugin.json",
          manifest({ author: { name: "A", twitter: "@a" } }),
        ]),
      ).ok,
    ).toBe(false);
  });

  test("an unknown field and a non-object extensions are reported and ignored", () => {
    const reading = read(
      plugin([
        "plugin.json",
        manifest({ skills: "./skills/", extensions: [] }),
      ]),
    );
    expect(reading.notes).toEqual([
      "plugin.json's extensions isn't an object, so it was ignored.",
      "plugin.json's skills isn't part of Agent Plugins 1.0.0, so it was ignored.",
    ]);
  });

  test("an unparseable plugin.json rejects the plugin", () => {
    expect(readPlugin(plugin(["plugin.json", "{ nope"])).ok).toBe(false);
  });
});

describe("skills (§7.1 and Agent Skills)", () => {
  test("only skills/<name>/SKILL.md, one level deep", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        ["skills/weekly/SKILL.md", skillMd("weekly", "Weekly.")],
        ["skills/weekly/nested/SKILL.md", skillMd("nested", "Nested.")],
      ),
    );
    expect(reading.skills.map((skill) => skill.name)).toEqual(["weekly"]);
    expect(reading.skills[0]?.otherFiles).toEqual([
      "skills/weekly/nested/SKILL.md",
    ]);
  });

  test("a skill that breaks the format is left out on its own, with the reason", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        ["skills/good/SKILL.md", skillMd("good", "Fine.")],
        ["skills/wrong-dir/SKILL.md", skillMd("other", "Mismatched.")],
        ["skills/no-desc/SKILL.md", "---\nname: no-desc\n---\nBody"],
        ["skills/Bad/SKILL.md", skillMd("Bad", "Upper case.")],
        ["skills/bare/SKILL.md", "Just text, no front matter."],
      ),
    );
    expect(reading.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(reading.skippedSkills).toEqual([
      { name: "Bad", reason: expect.stringContaining("lower-case") },
      { name: "bare", reason: "Its SKILL.md has no front matter." },
      { name: "no-desc", reason: expect.stringContaining("description") },
      { name: "wrong-dir", reason: "Its name, other, must match its folder." },
    ]);
  });
});

describe("front matter", () => {
  test("plain, quoted and commented values", () => {
    const fields = frontMatter(
      `---\nname: weekly # the command\ndescription: "Say \\"hi\\" to the team"\nlicense: 'It''s MIT'\n---\nbody`,
    );
    expect(fields?.get("name")).toBe("weekly");
    expect(fields?.get("description")).toBe('Say "hi" to the team');
    expect(fields?.get("license")).toBe("It's MIT");
  });

  test("folded and literal blocks, and nested maps skipped", () => {
    const fields = frontMatter(
      "---\nname: weekly\ndescription: >-\n  Write the weekly report\n  from closed issues.\n\n  Use it on Fridays.\nmetadata:\n  author: acme\n  version: '1'\nnotes: |\n  line one\n  line two\n---\n",
    );
    expect(fields?.get("description")).toBe(
      "Write the weekly report from closed issues.\nUse it on Fridays.",
    );
    expect(fields?.get("notes")).toBe("line one\nline two");
    expect(fields?.get("author")).toBeUndefined();
  });

  test("a plain value continued on the next lines", () => {
    const fields = frontMatter(
      "---\ndescription: Write the weekly\n  report on Fridays.\nname: weekly\n---\n",
    );
    expect(fields?.get("description")).toBe(
      "Write the weekly report on Fridays.",
    );
    expect(fields?.get("name")).toBe("weekly");
  });

  test("no front matter is null", () => {
    expect(frontMatter("# Weekly\n")).toBeNull();
  });
});

describe("mcp.json (§7.2)", () => {
  const withServers = (servers: Record<string, unknown>) =>
    read(plugin(["plugin.json", manifest()], ["mcp.json", mcp(servers)]));

  test("only a remote Streamable HTTP server over HTTPS is added", () => {
    const reading = withServers({
      remote: { type: "streamable-http", url: "https://a.example.com/mcp" },
      local: { type: "stdio", command: "./bin/server" },
      legacy: { type: "sse", url: "https://b.example.com/sse" },
      plain: { type: "streamable-http", url: "http://c.example.com/mcp" },
      tenant: {
        type: "streamable-http",
        url: "https://d.example.com/mcp",
        headers: { "X-Tenant": "acme" },
      },
      extra: {
        type: "streamable-http",
        url: "https://e.example.com",
        command: "x",
      },
      odd: { type: "websocket", url: "wss://f.example.com" },
      secret: {
        type: "streamable-http",
        url: "https://user:pw@g.example.com/mcp",
      },
    });
    expect(reading.servers).toEqual([
      { name: "remote", url: "https://a.example.com/mcp" },
    ]);
    expect(
      Object.fromEntries(reading.skippedServers.map((s) => [s.name, s.reason])),
    ).toEqual({
      extra: "command isn't a field of a streamable-http server.",
      legacy: expect.stringContaining("SSE"),
      local: expect.stringContaining("runs a program"),
      odd: "Its type must be stdio, streamable-http or sse.",
      plain: expect.stringContaining("HTTPS"),
      secret: expect.stringContaining("user name"),
      tenant: expect.stringContaining("headers"),
    });
  });

  test("a broken mcp.json drops the servers, not the plugin", () => {
    for (const config of [
      "{ nope",
      JSON.stringify({ mcpServers: {} }),
      JSON.stringify({ $schema: MCP_SCHEMA_1_0_0, mcpServers: {}, extra: 1 }),
    ]) {
      const reading = read(
        plugin(
          ["plugin.json", manifest()],
          ["mcp.json", config],
          ["skills/weekly/SKILL.md", skillMd("weekly", "Weekly.")],
        ),
      );
      expect(reading.servers).toEqual([]);
      expect(reading.skills).toHaveLength(1);
      expect(reading.notes).toHaveLength(1);
    }
  });

  test("a 1.0.0 plugin's .mcp.json is not read", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        [
          ".mcp.json",
          JSON.stringify({
            mcpServers: { a: { type: "http", url: "https://a.example.com" } },
          }),
        ],
      ),
    );
    expect(reading.servers).toEqual([]);
    expect(reading.notes[0]).toContain(".mcp.json was left out");
  });

  test("other component folders are named, not read", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        ["commands/hi.md", null],
        ["hooks/hooks.json", null],
      ),
    );
    expect(reading.notes).toEqual([
      "Its commands/ folder isn't part of Agent Plugins 1.0.0, so OpenBot leaves it out.",
      "Its hooks/ folder isn't part of Agent Plugins 1.0.0, so OpenBot leaves it out.",
    ]);
  });
});

describe("Claude Code and Codex layouts", () => {
  test("a Claude Code plugin's skills and .mcp.json servers", () => {
    const reading = read(
      plugin(
        [
          ".claude-plugin/plugin.json",
          JSON.stringify({ name: "reports", version: "0.1.0" }),
        ],
        ["skills/weekly/SKILL.md", skillMd("weekly", "Weekly.")],
        [
          ".mcp.json",
          JSON.stringify({
            mcpServers: {
              tracker: { type: "http", url: "https://mcp.example.com/mcp" },
              local: {
                command: `${placeholder("CLAUDE_PLUGIN_ROOT")}/bin/server`,
              },
              tokened: {
                type: "http",
                url: `https://${placeholder("TENANT")}.example.com/mcp`,
              },
            },
          }),
        ],
      ),
    );
    expect(reading.format).toBe("claude");
    expect(reading.skills).toHaveLength(1);
    expect(reading.servers).toEqual([
      { name: "tracker", url: "https://mcp.example.com/mcp" },
    ]);
    expect(reading.skippedServers.map((server) => server.name)).toEqual([
      "local",
      "tokened",
    ]);
  });

  test("servers on their own, or inline in the manifest", () => {
    const bare = read(
      plugin(
        [".codex-plugin/plugin.json", JSON.stringify({ name: "reports" })],
        [
          ".mcp.json",
          JSON.stringify({
            tracker: { type: "http", url: "https://a.example.com/mcp" },
          }),
        ],
      ),
    );
    expect(bare.format).toBe("codex");
    expect(bare.servers).toHaveLength(1);
    const inline = read(
      plugin([
        ".claude-plugin/plugin.json",
        JSON.stringify({
          name: "reports",
          mcpServers: {
            tracker: { type: "http", url: "https://a.example.com/mcp" },
          },
        }),
      ]),
    );
    expect(inline.servers).toHaveLength(1);
  });

  test("a manifest that keeps components elsewhere is said to, not followed", () => {
    const reading = read(
      plugin([
        ".claude-plugin/plugin.json",
        JSON.stringify({
          name: "reports",
          skills: "./custom/",
          mcpServers: "./config/mcp.json",
        }),
      ]),
    );
    expect(reading.notes).toEqual([
      ".claude-plugin/plugin.json keeps its servers in ./config/mcp.json. OpenBot reads .mcp.json only.",
      ".claude-plugin/plugin.json keeps its skills in ./custom/. OpenBot reads skills/ only.",
    ]);
  });

  test("the portable manifest wins when a plugin ships both", () => {
    const reading = read(
      plugin(
        ["plugin.json", manifest()],
        [".claude-plugin/plugin.json", JSON.stringify({ name: "other" })],
      ),
    );
    expect(reading.format).toBe("agent-plugins");
    expect(reading.name).toBe("reports");
  });
});

describe("the install plan", () => {
  const reading = (skills: [string, string, string?][]) =>
    read(
      plugin(
        ["plugin.json", manifest()],
        ...skills.map(([name, description, body]): [string, string] => [
          `skills/${name}/SKILL.md`,
          skillMd(name, description, body),
        ]),
        [
          "mcp.json",
          mcp({
            "issue-tracker": {
              type: "streamable-http",
              url: "https://a.example.com/mcp",
            },
          }),
        ],
      ),
    );

  test("a skill becomes the person's own, titled from its name", () => {
    const plan = installPlan(
      reading([["weekly-report", "Write the weekly report."]]),
      new Set(),
    );
    expect(plan.skills).toEqual([
      {
        slug: "weekly-report",
        title: "Weekly report",
        summary: "Write the weekly report.",
        instructions: "Do the thing.",
        otherFiles: [],
      },
    ]);
    expect(plan.servers).toEqual([
      {
        name: "issue-tracker",
        title: "issue-tracker",
        url: "https://a.example.com/mcp",
      },
    ]);
  });

  test("a long description is cut for the one-liner and leads the instructions", () => {
    const description = `${"Write the weekly report from closed issues ".repeat(8)}end.`;
    const [skill] = installPlan(
      reading([["weekly", description]]),
      new Set(),
    ).skills;
    expect(skill?.summary.length).toBeLessThanOrEqual(200);
    expect(skill?.summary.endsWith("…")).toBe(true);
    expect(skill?.instructions).toBe(`${description}\n\nDo the thing.`);
  });

  test("a taken, too short or empty skill is left out, never overwritten", () => {
    const plan = installPlan(
      reading([
        ["weekly", "Weekly."],
        ["x", "Too short for a command."],
        ["empty", "No body.", ""],
      ]),
      new Set(["weekly"]),
    );
    expect(plan.skills).toEqual([]);
    // In folder order, as the plugin lists them.
    expect(
      plan.skippedSkills.map((skill) => [skill.name, skill.reason]),
    ).toEqual([
      ["empty", expect.stringContaining("no instructions")],
      ["weekly", "You already have /weekly, so it was left as it is."],
      ["x", expect.stringContaining("2 to 40")],
    ]);
  });
});

describe("installing", () => {
  const app = (id: string, tools: string[]): App =>
    ({
      id,
      tools: tools.map((name) => ({ name, ref: `${id}/${name}` })),
    }) as unknown as App;

  const plan = installPlan(
    read(
      plugin(
        ["plugin.json", manifest()],
        ["skills/weekly/SKILL.md", skillMd("weekly", "Weekly.")],
        ["skills/monthly/SKILL.md", skillMd("monthly", "Monthly.")],
        [
          "mcp.json",
          mcp({
            first: {
              type: "streamable-http",
              url: "https://a.example.com/mcp",
            },
            second: {
              type: "streamable-http",
              url: "https://b.example.com/mcp",
            },
            third: {
              type: "streamable-http",
              url: "https://c.example.com/mcp",
            },
          }),
        ],
      ),
    ),
    new Set(),
  );

  test("servers first, then skills naming the added servers' tools; no failure stops the rest", async () => {
    const calls: string[] = [];
    const saved: { slug: string; tools: string[] }[] = [];
    const steps: InstallSteps = {
      addServer: async ({ title }) => {
        calls.push(`server:${title}`);
        if (title === "first") {
          return {
            added: true,
            server: app("first", ["list", "get"]),
            signIn: false,
          };
        }
        if (title === "second") {
          return {
            added: false,
            error: "This server needs a key.",
            code: "needs-key",
          };
        }
        throw new Error("Network down.");
      },
      saveSkill: async (input) => {
        calls.push(`skill:${input.slug}`);
        if (input.slug === "monthly")
          throw new Error("Somebody else owns /monthly.");
        saved.push({ slug: input.slug, tools: input.tools });
      },
    };

    const result = await installPlugin(plan, steps);

    expect(calls).toEqual([
      "server:first",
      "server:second",
      "server:third",
      "skill:monthly",
      "skill:weekly",
    ]);
    expect(result.servers).toEqual([
      { name: "first", status: "added", serverId: "first" },
      {
        name: "second",
        status: "needs-key",
        message: "This server needs a key.",
      },
      { name: "third", status: "failed", message: "Network down." },
    ]);
    expect(result.skills).toEqual([
      {
        slug: "monthly",
        saved: false,
        message: "Somebody else owns /monthly.",
      },
      { slug: "weekly", saved: true },
    ]);
    expect(saved).toEqual([
      { slug: "weekly", tools: ["first/list", "first/get"] },
    ]);
  });

  test("a server already added at that address is reported as such", async () => {
    const result = await installPlugin(
      { ...plan, skills: [], servers: plan.servers.slice(0, 1) },
      {
        addServer: async () => ({
          added: false,
          error: "Already added.",
          serverId: "tracker",
        }),
        saveSkill: async () => undefined,
      },
    );
    expect(result.servers).toEqual([
      {
        name: "first",
        status: "already-added",
        message: "Already added.",
        serverId: "tracker",
      },
    ]);
  });
});
