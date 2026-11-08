/**
 * prefetch-nsis.sh, run against a stand-in for GitHub that answers the way it did on 2026-11-08:
 * github.com's release download timing out with a 504 (the "failed to bundle project: http status:
 * 504" that left the internal build without a Windows installer), while the REST API's
 * release-asset endpoint still answered. Like the real endpoint, the stand-in returns the asset's
 * JSON description unless asked for `application/octet-stream`, and then redirects to the bytes.
 *
 * Needs bash, curl, zip and unzip, so it runs wherever the desktop scripts' tests do.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "prefetch-nsis.sh");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "prefetch-nsis-"));
  temps.push(dir);
  return dir;
}

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const pluginPath = "Plugins/x86-unicode/additional/nsis_tauri_utils.dll";
// Tauri's NSIS_REQUIRED_FILES, less the plugin, which comes separately.
const zipFiles = [
  "makensis.exe",
  "Bin/makensis.exe",
  "Stubs/lzma-x86-unicode",
  "Stubs/lzma_solid-x86-unicode",
  "Include/MUI2.nsh",
  "Include/FileFunc.nsh",
  "Include/x64.nsh",
  "Include/nsDialogs.nsh",
  "Include/WinMessages.nsh",
  "Include/Win/COM.nsh",
  "Include/Win/Propkey.nsh",
  "Include/Win/RestartManager.nsh",
  "Plugins/x86-unicode/System.dll",
];

let zip: Uint8Array<ArrayBuffer>;
const plugin = new TextEncoder().encode("nsis_tauri_utils.dll stand-in\n");

beforeAll(() => {
  // An NSIS zip with the layout the real one has: everything under nsis-3.11/.
  const dir = temp();
  for (const file of zipFiles) {
    const path = join(dir, "nsis-3.11", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${file}\n`);
  }
  const made = spawnSync("zip", ["-qr", "nsis.zip", "nsis-3.11"], {
    cwd: dir,
  });
  expect(made.status).toBe(0);
  zip = new Uint8Array(readFileSync(join(dir, "nsis.zip")));
  temps.splice(temps.indexOf(dir), 1);
  rmSync(dir, { recursive: true, force: true });
});

type Answer = number | "serve";
const assets = {
  "/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip": {
    id: 317051073,
    repo: "tauri-apps/binary-releases",
    bytes: () => zip,
  },
  "/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll":
    {
      id: 345882097,
      repo: "tauri-apps/nsis-tauri-utils",
      bytes: () => plugin,
    },
};

/** What the stand-in will answer each github.com download with, in order; the last repeats. */
let downloads: Answer[] = ["serve"];
let requests: string[] = [];

const github = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const accept = request.headers.get("accept") ?? "";
    requests.push(`${url.pathname}${accept.includes("octet") ? " octet" : ""}`);
    if (url.pathname.startsWith("/blob/")) {
      const asset = Object.values(assets).find(
        (candidate) => url.pathname === `/blob/${candidate.id}`,
      );
      return asset
        ? new Response(asset.bytes())
        : new Response("", { status: 404 });
    }
    for (const [path, asset] of Object.entries(assets)) {
      if (url.pathname === path) {
        const index = requests.filter((line) => line === path).length - 1;
        const answer = downloads[Math.min(index, downloads.length - 1)];
        return answer === "serve"
          ? new Response(asset.bytes())
          : new Response("<h1>504 Gateway Time-out</h1>", { status: answer });
      }
      if (url.pathname === `/repos/${asset.repo}/releases/assets/${asset.id}`) {
        return accept === "application/octet-stream"
          ? Response.redirect(`${url.origin}/blob/${asset.id}`, 302)
          : Response.json({ id: asset.id, url: request.url });
      }
    }
    return new Response("Not Found", { status: 404 });
  },
});
afterAll(() => github.stop(true));

/**
 * Runs the script against the stand-in. Asynchronously: the stand-in answers on this process's
 * event loop, which a synchronous spawn would hold shut.
 */
async function run(
  tools: string,
  overrides: Record<string, string | undefined> = {},
) {
  const origin = `http://127.0.0.1:${github.port}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    PREFETCH_NSIS_GITHUB: origin,
    PREFETCH_NSIS_API: origin,
    PREFETCH_NSIS_RETRIES: "2",
    PREFETCH_NSIS_ZIP_SHA256: sha256(zip),
    PREFETCH_NSIS_PLUGIN_SHA256: sha256(plugin),
    ...overrides,
  };
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name];
  const child = Bun.spawn(["bash", script, tools], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, output: `${stdout}${stderr}` };
}

function expectLaidOutForTauri(tools: string) {
  for (const file of zipFiles)
    expect(readFileSync(join(tools, "NSIS", file), "utf8")).toBe(`${file}\n`);
  expect(readFileSync(join(tools, "NSIS", pluginPath))).toEqual(
    Buffer.from(plugin),
  );
  // Nothing but NSIS is left behind: no zip, no working directory.
  expect(readdirSync(tools)).toEqual(["NSIS"]);
}

const zipPath = Object.keys(assets)[0] as string;
// curl waits 1s, then 2s, between its tries, for each of the two downloads.
const retrying = 30_000;

test(
  "a 504 from github.com is retried, and the toolset lands where Tauri looks",
  async () => {
    downloads = [504, 504, "serve"];
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run(tools);
    expect(result.output).toContain("tauri build will not download it");
    expect(result.status).toBe(0);
    expectLaidOutForTauri(tools);
    expect(requests.filter((line) => line === zipPath)).toHaveLength(3);
    expect(requests.some((line) => line.startsWith("/repos/"))).toBe(false);
  },
  retrying,
);

test(
  "when github.com keeps answering 504, the REST API's release-asset endpoint serves the files",
  async () => {
    downloads = [504];
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run(tools);
    expect(result.output).toContain(
      "::warning::github.com did not serve nsis-3.11.zip",
    );
    expect(result.status).toBe(0);
    expectLaidOutForTauri(tools);
    // Once the retries ran out on each download, and once through the API, asking for the bytes.
    expect(requests.filter((line) => line === zipPath)).toHaveLength(3);
    expect(requests).toContain(
      "/repos/tauri-apps/binary-releases/releases/assets/317051073 octet",
    );
    expect(requests).toContain(
      "/repos/tauri-apps/nsis-tauri-utils/releases/assets/345882097 octet",
    );
  },
  retrying,
);

test(
  "a toolset already in place is left alone, with no request at all",
  async () => {
    downloads = ["serve"];
    const tools = join(temp(), "tauri");
    expect((await run(tools)).status).toBe(0);
    requests = [];
    const result = await run(tools);
    expect(result.status).toBe(0);
    expect(result.output).toContain("NSIS is already in");
    expect(requests).toEqual([]);
  },
  retrying,
);

test(
  "a plugin with the wrong hash is replaced, as Tauri would replace it",
  async () => {
    downloads = ["serve"];
    const tools = join(temp(), "tauri");
    expect((await run(tools)).status).toBe(0);
    writeFileSync(join(tools, "NSIS", pluginPath), "an older plugin\n");
    requests = [];
    const result = await run(tools);
    expect(result.status).toBe(0);
    expectLaidOutForTauri(tools);
    expect(requests).toContain(zipPath);
  },
  retrying,
);

test(
  "bytes that do not match the pinned sha256 fail, and leave no NSIS directory behind",
  async () => {
    downloads = ["serve"];
    const tools = join(temp(), "tauri");
    // The script's own pin for the zip, which the stand-in's bytes do not match.
    const result = await run(tools, {
      PREFETCH_NSIS_RETRIES: "0",
      PREFETCH_NSIS_ZIP_SHA256: undefined,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      `::error::nsis-3.11.zip has sha256 ${sha256(zip)}, expected c7d27f78`,
    );
    expect(existsSync(join(tools, "NSIS"))).toBe(false);
    expect(readdirSync(tools)).toEqual([]);
  },
  retrying,
);

test("the pins are for the Tauri CLI that desktop/bun.lock locks", () => {
  // A CLI bump can move NSIS or the plugin to new files. The pins have to be read again from the
  // new bundler's bundle/windows/nsis/mod.rs, and this is what says so.
  const pinned = readFileSync(script, "utf8").match(
    /^TAURI_CLI_VERSION="([^"]+)"$/m,
  )?.[1];
  const lock = readFileSync(join(import.meta.dir, "../bun.lock"), "utf8");
  const locked = lock.match(
    /"@tauri-apps\/cli": \["@tauri-apps\/cli@([^"]+)"/,
  )?.[1];
  expect(pinned).toBeDefined();
  expect(locked).toBe(pinned);
});
