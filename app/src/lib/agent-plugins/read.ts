import { skillBody } from "@/lib/learning/display";

/**
 * Reading a plugin folder in the Agent Plugins format (https://agent-plugins.org/specification).
 *
 * Agent Plugins 1.0.0 is a folder with a `plugin.json` at its top, Agent Skills under
 * `skills/<name>/SKILL.md`, and MCP servers in `mcp.json`. Those are the only two component types in
 * 1.0.0, and they are the two OpenBot already has: a skill is a skill, and a remote MCP server is an
 * app added by its address. So reading a plugin is translation, not a new runtime.
 *
 * Two older layouts are read too, because most plugins written so far use one of them and they hold
 * the same two things: Claude Code's (`.claude-plugin/plugin.json` with `.mcp.json`) and Codex's
 * (`.codex-plugin/plugin.json`, same `.mcp.json`). OpenAI's own loader takes both for the same reason.
 *
 * NOTHING HERE FETCHES OR WRITES. It reads the files a person picked and says, for every skill and
 * server, either what it becomes or why it is left out, so the screen can show the whole plugin
 * before anything is installed. The spec's failure rules are kept: a broken manifest rejects the
 * plugin, a broken `mcp.json` drops only the servers, and a broken skill or server drops only itself.
 */

/** A file of the picked folder, by its path inside the plugin. `text` is null for a file not read. */
export type PluginFile = { path: string; text: string | null };

export type PluginFormat = "agent-plugins" | "claude" | "codex";

/** An Agent Skill the plugin ships. */
export type PluginSkill = {
  /** Its directory under `skills/`, which the spec requires to equal its name. */
  name: string;
  description: string;
  /** SKILL.md without its front matter. */
  body: string;
  /** The skill's other files (scripts, references, assets), by path inside the plugin. */
  otherFiles: string[];
};

/** A remote MCP server the plugin names, reached over Streamable HTTP. */
export type PluginServer = { name: string; url: string };

/** Something the plugin ships that is left out, and why, in a sentence a person reads. */
export type LeftOut = { name: string; reason: string };

export type PluginReading =
  | { ok: false; error: string }
  | {
      ok: true;
      format: PluginFormat;
      name: string;
      version: string | null;
      description: string | null;
      skills: PluginSkill[];
      skippedSkills: LeftOut[];
      servers: PluginServer[];
      skippedServers: LeftOut[];
      /** Everything else read and not used: unknown manifest fields, other component types. */
      notes: string[];
    };

export const PLUGIN_SCHEMA_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

/** Where each layout keeps its manifest, in the order they are looked for. */
const MANIFESTS: { path: string; format: PluginFormat }[] = [
  { path: "plugin.json", format: "agent-plugins" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".codex-plugin/plugin.json", format: "codex" },
];

/** Component types other clients define that 1.0.0 does not, so OpenBot has nothing to put them in. */
const OTHER_COMPONENTS = ["commands", "agents", "hooks", "output-styles"];

/**
 * Whether a file's text is needed. The rest of a picked folder (a plugin can ship binaries,
 * `node_modules` or images) is only listed, never read.
 */
export function wantsText(path: string): boolean {
  return (
    MANIFESTS.some((manifest) => manifest.path === path) ||
    path === "mcp.json" ||
    path === ".mcp.json" ||
    /^skills\/[^/]+\/SKILL\.md$/.test(path)
  );
}

/**
 * The path of a file a folder picker gave, inside the plugin: `my-plugin/skills/x/SKILL.md` is
 * `skills/x/SKILL.md`, because the picker names the chosen folder first.
 */
export function pathInPlugin(relativePath: string): string {
  const slash = relativePath.indexOf("/");
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}

/** Read a picked plugin folder. */
export function readPlugin(files: readonly PluginFile[]): PluginReading {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const found = MANIFESTS.find((manifest) => byPath.has(manifest.path));
  if (!found) {
    return {
      ok: false,
      error:
        "There's no plugin.json at the top of this folder. Pick the plugin's own folder, the one holding plugin.json.",
    };
  }
  const notes: string[] = [];
  const manifest = readManifest(
    byPath.get(found.path)?.text ?? null,
    found,
    notes,
  );
  if (!manifest.ok) return manifest;

  const { skills, skipped: skippedSkills } = readSkills(files);
  const { servers, skipped: skippedServers } = readServers(
    byPath,
    found.format,
    manifest.inlineServers,
    notes,
  );

  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  for (const component of OTHER_COMPONENTS) {
    if (tops.has(component)) {
      notes.push(
        `Its ${component}/ folder isn't part of Agent Plugins 1.0.0, so OpenBot leaves it out.`,
      );
    }
  }

  return {
    ok: true,
    format: found.format,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    skills,
    skippedSkills,
    servers,
    skippedServers,
    notes,
  };
}

type Manifest =
  | { ok: false; error: string }
  | {
      ok: true;
      name: string;
      version: string | null;
      description: string | null;
      /** A Claude Code manifest may hold its servers itself rather than name a file. */
      inlineServers: Record<string, unknown> | null;
    };

function readManifest(
  text: string | null,
  where: { path: string; format: PluginFormat },
  notes: string[],
): Manifest {
  const parsed = parseJson(text);
  if (!isObject(parsed)) {
    return { ok: false, error: `${where.path} isn't a JSON object.` };
  }
  return where.format === "agent-plugins"
    ? readPortableManifest(parsed, notes)
    : readOlderManifest(parsed, where, notes);
}

/**
 * Root `plugin.json`, held to Agent Plugins 1.0.0 (§5). Its schema is closed: an unknown field is
 * reported and ignored, a non-object `extensions` likewise, and any other violation rejects the
 * plugin before a single component is read.
 */
function readPortableManifest(
  manifest: Record<string, unknown>,
  notes: string[],
): Manifest {
  const schema = manifest.$schema;
  if (schema !== PLUGIN_SCHEMA_1_0_0) {
    const version =
      typeof schema === "string"
        ? /\/schemas\/([^/]+)\/plugin\.schema\.json$/.exec(schema)?.[1]
        : undefined;
    return {
      ok: false,
      error:
        typeof schema !== "string"
          ? "plugin.json has no $schema, so it doesn't say which Agent Plugins version it's written for."
          : version
            ? `This plugin is written for Agent Plugins ${version}. OpenBot reads 1.0.0.`
            : "plugin.json's $schema isn't an Agent Plugins schema.",
    };
  }
  const name = manifest.name;
  if (typeof name !== "string" || !isPluginName(name)) {
    return {
      ok: false,
      error:
        "plugin.json's name must be 1 to 64 lower-case letters, numbers, hyphens or periods, starting and ending on a letter or number.",
    };
  }
  for (const field of [
    "version",
    "description",
    "homepage",
    "repository",
    "license",
  ]) {
    if (field in manifest && typeof manifest[field] !== "string") {
      return { ok: false, error: `plugin.json's ${field} must be text.` };
    }
  }
  if (
    "keywords" in manifest &&
    !(
      Array.isArray(manifest.keywords) &&
      manifest.keywords.every((word) => typeof word === "string")
    )
  ) {
    return {
      ok: false,
      error: "plugin.json's keywords must be a list of text.",
    };
  }
  if ("author" in manifest && !isAuthor(manifest.author)) {
    return {
      ok: false,
      error:
        "plugin.json's author may only hold a name, an email and a url, each as text.",
    };
  }
  if ("extensions" in manifest && !isObject(manifest.extensions)) {
    notes.push("plugin.json's extensions isn't an object, so it was ignored.");
  }
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field)) {
      notes.push(
        `plugin.json's ${field} isn't part of Agent Plugins 1.0.0, so it was ignored.`,
      );
    }
  }
  return {
    ok: true,
    name,
    version: stringOrNull(manifest.version),
    description: stringOrNull(manifest.description),
    inlineServers: null,
  };
}

/**
 * A Claude Code or Codex manifest. Only its name, version and description are read, and its
 * components are looked for where both put them by default: `skills/` and `.mcp.json`. A manifest
 * that points elsewhere is said to, rather than followed, so what is read is what this file names.
 */
function readOlderManifest(
  manifest: Record<string, unknown>,
  where: { path: string; format: PluginFormat },
  notes: string[],
): Manifest {
  const name = manifest.name;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: `${where.path} has no name.` };
  }
  const servers = manifest.mcpServers;
  const inlineServers = isObject(servers) ? servers : null;
  if (typeof servers === "string" && !isDefaultPath(servers, ".mcp.json")) {
    notes.push(
      `${where.path} keeps its servers in ${servers}. OpenBot reads .mcp.json only.`,
    );
  }
  if (
    typeof manifest.skills === "string" &&
    !isDefaultPath(manifest.skills, "skills")
  ) {
    notes.push(
      `${where.path} keeps its skills in ${manifest.skills}. OpenBot reads skills/ only.`,
    );
  }
  return {
    ok: true,
    name: name.trim(),
    version: stringOrNull(manifest.version),
    description: stringOrNull(manifest.description),
    inlineServers,
  };
}

/**
 * Every `skills/<name>/SKILL.md`, one level deep (§7.1). A skill that doesn't meet the Agent Skills
 * format is left out on its own, with the reason.
 */
function readSkills(files: readonly PluginFile[]): {
  skills: PluginSkill[];
  skipped: LeftOut[];
} {
  const skills: PluginSkill[] = [];
  const skipped: LeftOut[] = [];
  const dirs = files
    .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1])
    .filter((dir): dir is string => dir !== undefined)
    .sort();
  for (const dir of dirs) {
    const text = files.find(
      (file) => file.path === `skills/${dir}/SKILL.md`,
    )?.text;
    const fields = text == null ? null : frontMatter(text);
    if (!text || !fields) {
      skipped.push({ name: dir, reason: "Its SKILL.md has no front matter." });
      continue;
    }
    const name = fields.get("name") ?? "";
    const description = (fields.get("description") ?? "").trim();
    if (!isSkillName(name)) {
      skipped.push({
        name: dir,
        reason:
          "Its name must be 1 to 64 lower-case letters, numbers and single hyphens.",
      });
      continue;
    }
    if (name !== dir) {
      skipped.push({
        name: dir,
        reason: `Its name, ${name}, must match its folder.`,
      });
      continue;
    }
    if (description === "" || description.length > 1024) {
      skipped.push({
        name: dir,
        reason: "It needs a description of 1 to 1,024 characters.",
      });
      continue;
    }
    skills.push({
      name,
      description,
      body: skillBody(text),
      otherFiles: files
        .map((file) => file.path)
        .filter(
          (path) =>
            path.startsWith(`skills/${dir}/`) &&
            path !== `skills/${dir}/SKILL.md`,
        )
        .sort(),
    });
  }
  return { skills, skipped };
}

/**
 * The plugin's MCP servers. OpenBot adds a server by its web address, so a remote server over
 * Streamable HTTP is the one kind it takes; a program to run on this computer (stdio), the older
 * SSE transport, and a server that needs headers sent are each left out with the reason.
 */
function readServers(
  byPath: ReadonlyMap<string, PluginFile>,
  format: PluginFormat,
  inlineServers: Record<string, unknown> | null,
  notes: string[],
): { servers: PluginServer[]; skipped: LeftOut[] } {
  const none = { servers: [], skipped: [] };
  if (format === "agent-plugins") {
    if (byPath.has(".mcp.json")) {
      notes.push(
        "Its .mcp.json was left out: an Agent Plugins plugin keeps its servers in mcp.json.",
      );
    }
    const file = byPath.get("mcp.json");
    if (!file) return none;
    // §7.2.2: a broken mcp.json drops the plugin's servers, not the plugin.
    const config = parseJson(file.text);
    if (!isObject(config)) {
      notes.push("Its mcp.json isn't a JSON object, so no server was read.");
      return none;
    }
    if (config.$schema !== MCP_SCHEMA_1_0_0) {
      notes.push(
        "Its mcp.json isn't written for Agent Plugins 1.0.0, so no server was read.",
      );
      return none;
    }
    const extra = Object.keys(config).filter(
      (key) => key !== "$schema" && key !== "mcpServers",
    );
    if (!isObject(config.mcpServers) || extra.length > 0) {
      notes.push(
        "Its mcp.json must hold only $schema and mcpServers, so no server was read.",
      );
      return none;
    }
    return eachServer(config.mcpServers, portableServer);
  }

  const file = byPath.get(".mcp.json");
  const config = inlineServers ?? (file ? parseJson(file.text) : undefined);
  if (config === undefined) return none;
  if (!isObject(config)) {
    notes.push("Its .mcp.json isn't a JSON object, so no server was read.");
    return none;
  }
  // Claude Code takes both `{ "mcpServers": { … } }` and the servers on their own.
  const servers = isObject(config.mcpServers) ? config.mcpServers : config;
  return eachServer(servers, olderServer);
}

function eachServer(
  servers: Record<string, unknown>,
  read: (
    entry: Record<string, unknown>,
  ) => { url: string } | { reason: string },
): { servers: PluginServer[]; skipped: LeftOut[] } {
  const result: { servers: PluginServer[]; skipped: LeftOut[] } = {
    servers: [],
    skipped: [],
  };
  for (const [name, entry] of Object.entries(servers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const outcome = isObject(entry)
      ? read(entry)
      : { reason: "Its entry isn't an object." };
    if ("url" in outcome) result.servers.push({ name, url: outcome.url });
    else result.skipped.push({ name, reason: outcome.reason });
  }
  return result;
}

const STDIO =
  "It runs a program on the computer it's installed on. OpenBot adds servers by their web address.";
const SSE =
  "It uses the older HTTP+SSE transport, which OpenBot doesn't add from a plugin yet.";
const HEADERS =
  "It sends fixed headers, which OpenBot can't send to a server yet. Add it from Connections if it works without them.";

/** One server of a 1.0.0 `mcp.json` (§7.2.1). Each variant is closed. */
function portableServer(
  entry: Record<string, unknown>,
): { url: string } | { reason: string } {
  switch (entry.type) {
    case "stdio":
      return { reason: STDIO };
    case "sse":
      return { reason: SSE };
    case "streamable-http": {
      const extra = Object.keys(entry).filter(
        (key) => !["type", "url", "headers"].includes(key),
      );
      if (extra.length > 0) {
        return {
          reason: `${extra.join(", ")} isn't a field of a streamable-http server.`,
        };
      }
      return remote(entry);
    }
    default:
      return {
        reason: "Its type must be stdio, streamable-http or sse.",
      };
  }
}

/** One server of a Claude Code or Codex `.mcp.json`, where `http` means Streamable HTTP. */
function olderServer(
  entry: Record<string, unknown>,
): { url: string } | { reason: string } {
  const type = entry.type;
  if (type === "stdio" || (type === undefined && "command" in entry)) {
    return { reason: STDIO };
  }
  if (type === "sse") return { reason: SSE };
  if (type === "http" || type === "streamable-http" || type === undefined) {
    return remote(entry);
  }
  return { reason: `OpenBot doesn't know the ${String(type)} transport.` };
}

/** The address of a remote server, held to §7.2.1, or why it can't be added. */
function remote(
  entry: Record<string, unknown>,
): { url: string } | { reason: string } {
  const url = entry.url;
  if (typeof url !== "string" || url.trim() === "") {
    return { reason: "It has no address." };
  }
  if (/\$\{[^}]*\}/.test(url)) {
    return {
      reason:
        "Its address has a placeholder in it that the plugin expects you to fill in.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: "Its address isn't a web address." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { reason: "Its address isn't a web address." };
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return {
      reason: "Its address may not carry a user name, password or fragment.",
    };
  }
  if (parsed.protocol === "http:") {
    // Loopback over plain HTTP is allowed by the spec, and refused by OpenBot's own floor.
    return {
      reason:
        "Its address isn't HTTPS. OpenBot only reaches servers over HTTPS.",
    };
  }
  const headers = entry.headers;
  if (headers !== undefined) {
    if (!isObject(headers)) return { reason: "Its headers aren't an object." };
    if (Object.keys(headers).length > 0) return { reason: HEADERS };
  }
  return { url: url.trim() };
}

/**
 * A SKILL.md's front matter, as its top-level text fields. Enough YAML for what Agent Skills
 * writes: plain, quoted and block (`|`, `>`) scalars, with nested maps such as `metadata` skipped.
 * Null when the file has no front matter at all.
 */
export function frontMatter(markdown: string): Map<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    markdown.replace(/^﻿/, ""),
  );
  if (!match) return null;
  const lines = (match[1] ?? "").split(/\r?\n/);
  const fields = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    const key = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!key?.[1]) continue;
    const more: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() !== "" && !/^\s/.test(next)) break;
      more.push(next);
      index += 1;
    }
    fields.set(key[1], scalar((key[2] ?? "").trim(), more));
  }
  return fields;
}

function scalar(first: string, more: string[]): string {
  const block = /^([|>])[+-]?\s*(?:#.*)?$/.exec(first);
  if (block) {
    const filled = more.filter((line) => line.trim() !== "");
    const indent = Math.min(
      ...filled.map((line) => line.length - line.trimStart().length),
    );
    const body = more.map((line) =>
      line.trim() === "" ? "" : line.slice(indent),
    );
    if (block[1] === "|") return body.join("\n").trim();
    // Folded: lines join with a space, and a blank line is a line break.
    return body
      .join("\n")
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, " "))
      .join("\n");
  }
  const whole = [first, ...more.map((line) => line.trim())]
    .filter((part) => part !== "")
    .join(" ");
  if (whole.startsWith('"')) {
    const end = whole.lastIndexOf('"');
    if (end > 0) {
      try {
        return JSON.parse(whole.slice(0, end + 1)) as string;
      } catch {
        return whole.slice(1, end);
      }
    }
  }
  if (whole.startsWith("'")) {
    const end = whole.lastIndexOf("'");
    if (end > 0) return whole.slice(1, end).replace(/''/g, "'");
  }
  // A plain scalar ends at a comment.
  return whole.replace(/\s+#.*$/, "");
}

/** Agent Plugins 1.0.0 §5.5. */
function isPluginName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) &&
    !name.includes("--") &&
    !name.includes("..")
  );
}

/** The Agent Skills name: lower-case letters, numbers and single hyphens, at most 64. */
function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function isAuthor(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, field]) =>
        ["name", "email", "url"].includes(key) && typeof field === "string",
    )
  );
}

function isDefaultPath(path: string, wanted: string): boolean {
  return path.replace(/^\.\//, "").replace(/\/$/, "") === wanted;
}

function parseJson(text: string | null | undefined): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
