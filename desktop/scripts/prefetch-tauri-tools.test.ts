/**
 * prefetch-tauri-tools.sh, run against a stand-in for GitHub that answers the way it did on
 * 2026-11-08: github.com's release downloads from tauri-apps/binary-releases failing with a 504 (the
 * "failed to bundle project: http status: 504" that failed the Windows and Linux desktop builds),
 * while the REST API still answered. Like the real API, the stand-in describes a release asset or a
 * file as JSON unless asked for its bytes, and redirects a release asset to the file itself.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "prefetch-tauri-tools.sh");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "prefetch-tauri-tools-"));
  temps.push(dir);
  return dir;
}

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

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

/** A release asset: where github.com serves it, and its id in the REST API. */
type Asset = { repo: string; tag: string; name: string; id: number };
/** A repository file Tauri reads from a branch, pinned to a commit. */
type RepoFile = { repo: string; commit: string; path: string };

const nsisZip: Asset = {
  repo: "tauri-apps/binary-releases",
  tag: "nsis-3.11",
  name: "nsis-3.11.zip",
  id: 317051073,
};
const nsisPlugin: Asset = {
  repo: "tauri-apps/nsis-tauri-utils",
  tag: "nsis_tauri_utils-v0.5.3",
  name: "nsis_tauri_utils.dll",
  id: 345882097,
};
const appRun: Asset = {
  repo: "tauri-apps/binary-releases",
  tag: "apprun-old",
  name: "AppRun-x86_64",
  id: 274691722,
};
const linuxdeploy: Asset = {
  repo: "tauri-apps/binary-releases",
  tag: "linuxdeploy",
  name: "linuxdeploy-x86_64.AppImage",
  id: 182515537,
};
const gtk: RepoFile = {
  repo: "tauri-apps/linuxdeploy-plugin-gtk",
  commit: "dda522bce37387f1b853d9095713bfaa924c8423",
  path: "linuxdeploy-plugin-gtk.sh",
};
const gstreamer: RepoFile = {
  repo: "tauri-apps/linuxdeploy-plugin-gstreamer",
  commit: "2a2e67491c32995a3f279ad0ecbe77abd512b42a",
  path: "linuxdeploy-plugin-gstreamer.sh",
};

const content = new Map<number | string, Uint8Array<ArrayBuffer>>([
  [nsisPlugin.id, bytes("nsis_tauri_utils.dll stand-in\n")],
  [appRun.id, bytes("AppRun stand-in\n")],
  [linuxdeploy.id, bytes("linuxdeploy stand-in\n")],
  [gtk.path, bytes("#!/bin/sh\n# gtk plugin stand-in\n")],
  [gstreamer.path, bytes("#!/bin/sh\n# gstreamer plugin stand-in\n")],
]);
const of = (key: number | string) =>
  content.get(key) as Uint8Array<ArrayBuffer>;

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
  content.set(nsisZip.id, new Uint8Array(readFileSync(join(dir, "nsis.zip"))));
});

type Answer = number | "serve";
/** What each kind of source answers, request by request, per path; the last answer repeats. */
let answers: { api: Answer[]; github: Answer[]; raw: Answer[] };
type Seen = { source: string; path: string; accept: string; auth: string };
let requests: Seen[] = [];

function answer(list: Answer[], path: string, source: string) {
  const index =
    requests.filter((seen) => seen.source === source && seen.path === path)
      .length - 1;
  return list[Math.min(index, list.length - 1)];
}

const gateway = (status: number) =>
  new Response("<h1>504 Gateway Time-out</h1>", { status });

const github = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const accept = request.headers.get("accept") ?? "";
    const auth = request.headers.get("authorization") ?? "";
    const assets = [nsisZip, nsisPlugin, appRun, linuxdeploy];
    const files = [gtk, gstreamer];

    const blob = path.match(/^\/blob\/(\d+)$/);
    if (blob) {
      requests.push({ source: "blob", path, accept, auth });
      return new Response(of(Number(blob[1])));
    }
    for (const asset of assets) {
      if (path === `/repos/${asset.repo}/releases/assets/${asset.id}`) {
        requests.push({ source: "api", path, accept, auth });
        if (accept !== "application/octet-stream")
          return Response.json({ id: asset.id, name: asset.name });
        const next = answer(answers.api, path, "api");
        return next === "serve"
          ? Response.redirect(`${url.origin}/blob/${asset.id}`, 302)
          : gateway(next as number);
      }
      if (
        path === `/${asset.repo}/releases/download/${asset.tag}/${asset.name}`
      ) {
        requests.push({ source: "github", path, accept, auth });
        const next = answer(answers.github, path, "github");
        return next === "serve"
          ? new Response(of(asset.id))
          : gateway(next as number);
      }
    }
    for (const file of files) {
      if (path === `/${file.repo}/${file.commit}/${file.path}`) {
        requests.push({ source: "raw", path, accept, auth });
        const next = answer(answers.raw, path, "raw");
        return next === "serve"
          ? new Response(of(file.path))
          : gateway(next as number);
      }
      if (
        path === `/repos/${file.repo}/contents/${file.path}` &&
        url.searchParams.get("ref") === file.commit
      ) {
        requests.push({ source: "contents", path, accept, auth });
        return accept === "application/vnd.github.raw"
          ? new Response(of(file.path))
          : Response.json({ name: file.path, encoding: "base64" });
      }
    }
    requests.push({ source: "unknown", path, accept, auth });
    return new Response("Not Found", { status: 404 });
  },
});
afterAll(() => github.stop(true));

/**
 * Runs the script against the stand-in. Asynchronously: the stand-in answers on this process's
 * event loop, which a synchronous spawn would hold shut.
 */
async function run(
  platform: string,
  tools: string,
  overrides: Record<string, string | undefined> = {},
) {
  const origin = `http://127.0.0.1:${github.port}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GH_TOKEN: "stand-in-token",
    PREFETCH_TAURI_API: origin,
    PREFETCH_TAURI_GITHUB: origin,
    PREFETCH_TAURI_RAW: origin,
    PREFETCH_TAURI_RETRIES: "2",
    PREFETCH_TAURI_ARCH: "x86_64",
    NSIS_ZIP_SHA256: sha256(of(nsisZip.id)),
    NSIS_PLUGIN_SHA256: sha256(of(nsisPlugin.id)),
    APPRUN_SHA256: sha256(of(appRun.id)),
    LINUXDEPLOY_SHA256: sha256(of(linuxdeploy.id)),
    GTK_PLUGIN_SHA256: sha256(of(gtk.path)),
    GSTREAMER_PLUGIN_SHA256: sha256(of(gstreamer.path)),
    ...overrides,
  };
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name];
  const child = Bun.spawn(["bash", script, platform, tools], {
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

const from = (source: string) =>
  requests.filter((seen) => seen.source === source);
// curl waits 1s, then 2s, between its tries.
const retrying = 60_000;

function expectNsisLaidOut(tools: string) {
  for (const file of zipFiles)
    expect(readFileSync(join(tools, "NSIS", file), "utf8")).toBe(`${file}\n`);
  expect(new Uint8Array(readFileSync(join(tools, "NSIS", pluginPath)))).toEqual(
    of(nsisPlugin.id),
  );
  // Nothing but NSIS is left behind: no zip, no working directory.
  expect(readdirSync(tools)).toEqual(["NSIS"]);
}

const linuxTools: [string, number | string][] = [
  ["AppRun-x86_64", appRun.id],
  ["linuxdeploy-x86_64.AppImage", linuxdeploy.id],
  ["linuxdeploy-plugin-gtk.sh", gtk.path],
  ["linuxdeploy-plugin-gstreamer.sh", gstreamer.path],
];

function expectLinuxLaidOut(tools: string) {
  for (const [name, key] of linuxTools) {
    expect(new Uint8Array(readFileSync(join(tools, name)))).toEqual(of(key));
    // Tauri runs these, so they must be executable as Tauri's own download would be.
    expect(statSync(join(tools, name)).mode & 0o100).toBe(0o100);
  }
  expect(readdirSync(tools).sort()).toEqual(
    linuxTools.map(([name]) => name).sort(),
  );
}

test(
  "Windows: the NSIS toolset comes through the API, authenticated, and lands where Tauri looks",
  async () => {
    answers = { api: [502, "serve"], github: [504], raw: ["serve"] };
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run("windows", tools);
    expect(result.output).toContain("tauri build will not download it");
    expect(result.status).toBe(0);
    expectNsisLaidOut(tools);
    // The failing download page is never asked; a 502 from the API is simply tried again.
    expect(from("github")).toEqual([]);
    expect(from("api")).toHaveLength(4);
    for (const seen of from("api")) {
      expect(seen.accept).toBe("application/octet-stream");
      expect(seen.auth).toBe("Bearer stand-in-token");
    }
  },
  retrying,
);

test(
  "Windows: when the API fails too, the github.com download URL is the fallback",
  async () => {
    answers = { api: [503], github: [504, "serve"], raw: ["serve"] };
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run("windows", tools);
    expect(result.output).toContain("::warning::Could not fetch");
    expect(result.status).toBe(0);
    expectNsisLaidOut(tools);
    expect(from("github")).toHaveLength(4);
    // The token goes to the API and nowhere else.
    for (const seen of from("github")) expect(seen.auth).toBe("");
  },
  retrying,
);

test(
  "Windows: a toolset already in place is left alone, with no request at all",
  async () => {
    answers = { api: ["serve"], github: ["serve"], raw: ["serve"] };
    const tools = join(temp(), "tauri");
    expect((await run("windows", tools)).status).toBe(0);
    requests = [];
    const result = await run("windows", tools);
    expect(result.status).toBe(0);
    expect(result.output).toContain("NSIS is already in");
    expect(requests).toEqual([]);
  },
  retrying,
);

test(
  "Windows: a plugin with the wrong hash is replaced, as Tauri would replace it",
  async () => {
    answers = { api: ["serve"], github: ["serve"], raw: ["serve"] };
    const tools = join(temp(), "tauri");
    expect((await run("windows", tools)).status).toBe(0);
    writeFileSync(join(tools, "NSIS", pluginPath), "an older plugin\n");
    requests = [];
    const result = await run("windows", tools);
    expect(result.status).toBe(0);
    expectNsisLaidOut(tools);
  },
  retrying,
);

test(
  "Windows: bytes that do not match the pinned sha256 fail at once and leave nothing behind",
  async () => {
    answers = { api: ["serve"], github: ["serve"], raw: ["serve"] };
    requests = [];
    const tools = join(temp(), "tauri");
    // The script's own pin for the zip, which the stand-in's bytes do not match.
    const result = await run("windows", tools, { NSIS_ZIP_SHA256: undefined });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      `served a file with sha256 ${sha256(of(nsisZip.id))}, expected c7d27f78`,
    );
    // A mismatch is not something another source should paper over.
    expect(from("github")).toEqual([]);
    expect(existsSync(join(tools, "NSIS"))).toBe(false);
    expect(readdirSync(tools)).toEqual([]);
  },
  retrying,
);

test(
  "Linux: AppRun, linuxdeploy and both plugins land in Tauri's tools directory, executable",
  async () => {
    answers = { api: ["serve"], github: [504], raw: ["serve"] };
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run("linux", tools);
    expect(result.output).toContain("Fetched 4 AppImage tools");
    expect(result.status).toBe(0);
    expectLinuxLaidOut(tools);
    expect(from("github")).toEqual([]);
    expect(from("api").map((seen) => seen.path)).toEqual([
      `/repos/tauri-apps/binary-releases/releases/assets/${appRun.id}`,
      `/repos/tauri-apps/binary-releases/releases/assets/${linuxdeploy.id}`,
    ]);
    // The plugins come from the commit they are pinned to, never a moving branch.
    expect(from("raw").map((seen) => seen.path)).toEqual([
      `/${gtk.repo}/${gtk.commit}/${gtk.path}`,
      `/${gstreamer.repo}/${gstreamer.commit}/${gstreamer.path}`,
    ]);
  },
  retrying,
);

test(
  "Linux: when raw.githubusercontent.com fails, the plugins come through the contents API",
  async () => {
    answers = { api: ["serve"], github: [504], raw: [504] };
    requests = [];
    const tools = join(temp(), "tauri");
    const result = await run("linux", tools);
    expect(result.status).toBe(0);
    expectLinuxLaidOut(tools);
    expect(from("contents")).toHaveLength(2);
    for (const seen of from("contents")) {
      expect(seen.accept).toBe("application/vnd.github.raw");
      expect(seen.auth).toBe("Bearer stand-in-token");
    }
  },
  retrying,
);

test(
  "Linux: tools already there are left alone, as Tauri leaves them",
  async () => {
    answers = { api: ["serve"], github: ["serve"], raw: ["serve"] };
    const tools = join(temp(), "tauri");
    expect((await run("linux", tools)).status).toBe(0);
    // Tauri writes into linuxdeploy's header after every run, so its hash is not checked again.
    writeFileSync(join(tools, "linuxdeploy-x86_64.AppImage"), "rewritten\n");
    requests = [];
    const result = await run("linux", tools);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Fetched 0 AppImage tools");
    expect(requests).toEqual([]);
  },
  retrying,
);

test("the pins are for the Tauri CLI that desktop/bun.lock locks", () => {
  // A CLI bump can move any of these tools to new files. The pins have to be read again from the
  // new bundler's nsis/mod.rs and appimage/linuxdeploy.rs, and this is what says so.
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
