import { describe, expect, test } from "bun:test";
import { installPlan, installPlugin } from "@/lib/agent-plugins/install";
import {
  MCP_SCHEMA_1_0_0,
  PLUGIN_SCHEMA_1_0_0,
  readPlugin,
} from "@/lib/agent-plugins/read";
import { ArchiveError, readZip } from "@/lib/agent-plugins/zip";

/**
 * A plugin's `.zip`, read in the browser into the files a picked folder gives: stored and deflated
 * entries, a zipped folder or its contents, and the entries that must never land in the plugin.
 */

type ZipEntry = {
  name: string;
  text?: string;
  /** Deflate it, as `zip` and Finder do for any file worth compressing. */
  deflate?: boolean;
  encrypted?: boolean;
};

const encoder = new TextEncoder();

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal archive: local headers, a central directory, the end record. No CRCs are checked. */
async function zip(entries: ZipEntry[], comment = ""): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.text ?? "");
    const data = entry.deflate ? await deflateRaw(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const flags = entry.encrypted ? 1 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, commentBytes.length, true);
  end.set(commentBytes, 22);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const manifest = JSON.stringify({
  $schema: PLUGIN_SCHEMA_1_0_0,
  name: "reports",
});
const skill = "---\nname: weekly\ndescription: Weekly.\n---\nDo the thing.";

describe("reading a .zip", () => {
  test("stored and deflated entries read as a folder does", async () => {
    const files = await readZip(
      await zip([
        { name: "plugin.json", text: manifest },
        { name: "skills/weekly/SKILL.md", text: skill, deflate: true },
        { name: "skills/weekly/scripts/run.sh", text: "echo hi" },
        {
          name: "mcp.json",
          deflate: true,
          text: JSON.stringify({
            $schema: MCP_SCHEMA_1_0_0,
            mcpServers: {
              tracker: {
                type: "streamable-http",
                url: "https://a.example.com/mcp",
              },
            },
          }),
        },
      ]),
    );
    expect(files).toEqual([
      { path: "plugin.json", text: manifest },
      { path: "skills/weekly/SKILL.md", text: skill },
      // Not read: only manifests, server configs and SKILL.md files are.
      { path: "skills/weekly/scripts/run.sh", text: null },
      { path: "mcp.json", text: expect.stringContaining("tracker") },
    ]);
    const reading = readPlugin(files);
    expect(reading.ok && reading.skills.map((s) => s.name)).toEqual(["weekly"]);
    expect(reading.ok && reading.servers).toHaveLength(1);
  });

  test("a zipped folder is read from inside its folder", async () => {
    const files = await readZip(
      await zip([
        { name: "reports/", text: "" },
        { name: "reports/plugin.json", text: manifest },
        { name: "reports/skills/weekly/SKILL.md", text: skill, deflate: true },
      ]),
    );
    expect(files.map((file) => file.path)).toEqual([
      "plugin.json",
      "skills/weekly/SKILL.md",
    ]);
  });

  test("entries outside the plugin, and Finder's copies, are dropped", async () => {
    const files = await readZip(
      await zip([
        { name: "plugin.json", text: manifest },
        { name: "../escape.txt", text: "no" },
        { name: "/etc/passwd", text: "no" },
        { name: "__MACOSX/._plugin.json", text: "no" },
        { name: "skills/.DS_Store", text: "no" },
      ]),
    );
    expect(files.map((file) => file.path)).toEqual(["plugin.json"]);
  });

  test("an archive comment does not hide the end record", async () => {
    const files = await readZip(
      await zip([{ name: "plugin.json", text: manifest }], "made by hand"),
    );
    expect(files).toHaveLength(1);
  });

  test("a file that isn't a zip, and a password-protected one, say so", async () => {
    await expect(readZip(encoder.encode("not a zip at all"))).rejects.toThrow(
      new ArchiveError("This file isn't a .zip archive."),
    );
    await expect(
      readZip(
        await zip([{ name: "plugin.json", text: manifest, encrypted: true }]),
      ),
    ).rejects.toThrow(/password-protected/);
  });
});

describe("installing, as the screen hears it", () => {
  test("progress names each row as it is written, then nothing once done", async () => {
    const reading = readPlugin([
      { path: "plugin.json", text: manifest },
      { path: "skills/weekly/SKILL.md", text: skill },
      {
        path: "mcp.json",
        text: JSON.stringify({
          $schema: MCP_SCHEMA_1_0_0,
          mcpServers: {
            tracker: {
              type: "streamable-http",
              url: "https://a.example.com/mcp",
            },
          },
        }),
      },
    ]);
    if (!reading.ok) throw new Error(reading.error);
    const heard: string[] = [];
    await installPlugin(
      installPlan(reading, new Set()),
      {
        addServer: async () => ({
          added: false,
          error: "Needs a key.",
          code: "needs-key",
        }),
        saveSkill: async () => undefined,
      },
      (progress) =>
        heard.push(
          `${progress.working ? `${progress.working.kind}:${progress.working.key}` : "done"} ` +
            `(${progress.result.servers.length}/${progress.result.skills.length})`,
        ),
    );
    expect(heard).toEqual([
      "server:tracker (0/0)",
      "skill:weekly (1/0)",
      "done (1/1)",
    ]);
  });

  test("somebody who can't add servers has them left out, with the reason", () => {
    const reading = readPlugin([
      { path: "plugin.json", text: manifest },
      {
        path: "mcp.json",
        text: JSON.stringify({
          $schema: MCP_SCHEMA_1_0_0,
          mcpServers: {
            tracker: {
              type: "streamable-http",
              url: "https://a.example.com/mcp",
            },
            local: { type: "stdio", command: "x" },
          },
        }),
      },
    ]);
    if (!reading.ok) throw new Error(reading.error);
    const plan = installPlan(reading, new Set(), { mayAddServers: false });
    expect(plan.servers).toEqual([]);
    expect(plan.skippedServers.map((server) => server.name)).toEqual([
      "tracker",
      "local",
    ]);
    expect(plan.skippedServers[0]?.reason).toContain("Only an admin");
  });
});
