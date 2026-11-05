import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyDist } from "../scripts/verify-dist";

const release = { variant: "release", rootVersion: "0.2.0" } as const;

const manifest = (version: string, versionName?: string) =>
  JSON.stringify({
    manifest_version: 3,
    version,
    ...(versionName === undefined ? {} : { version_name: versionName }),
    background: { service_worker: "service-worker.js", type: "module" },
    action: {
      default_popup: "popup.html",
      default_icon: { "16": "icons/16.png" },
    },
    options_page: "options.html",
    icons: { "16": "icons/16.png", "128": "icons/128.png" },
    storage: { managed_schema: "managed_schema.json" },
  });

const files = (version = "0.2.0"): Record<string, string> => ({
  "manifest.json": manifest(version),
  "service-worker.js": "console.log('worker');",
  "popup.html": '<script type="module" src="./assets/popup.js"></script>',
  "options.html": '<link rel="stylesheet" href="./assets/options.css">',
  "offscreen.html":
    '<script type="module" src="./assets/offscreen.js"></script>',
  "content.js": "(function(){console.log('content');})();",
  "page-network.js": "(function(){console.log('page');})();",
  "managed_schema.json": "{}",
  "icons/16.png": "x",
  "icons/128.png": "x",
});

let roots: string[] = [];

function fixture(overrides: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-dist-"));
  roots.push(dir);
  const all: Record<string, string | null> = { ...files(), ...overrides };
  for (const [name, content] of Object.entries(all)) {
    if (content === null) continue;
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("verifyDist", () => {
  test("a good directory has no problems", () => {
    expect(verifyDist(fixture(), release)).toEqual([]);
  });

  test("a content script that starts with an import is not classic", () => {
    const dir = fixture({ "content.js": 'import "x";\nconsole.log(1);' });
    expect(verifyDist(dir, release)).toEqual([
      "content.js must be a classic script",
    ]);
  });

  test("a page-network script with an export is not classic", () => {
    const dir = fixture({ "page-network.js": "var a = 1;\nexport { a };" });
    expect(verifyDist(dir, release)).toEqual([
      "page-network.js must be a classic script",
    ]);
  });

  test("an html page loading a remote script reports remote code", () => {
    const dir = fixture({
      "popup.html": '<script src="https://cdn.example/x.js"></script>',
    });
    expect(verifyDist(dir, release)).toEqual(["popup.html loads remote code"]);
  });

  test("an unquoted remote script src reports remote code", () => {
    const dir = fixture({
      "popup.html": "<script src=https://cdn.example/x.js></script>",
    });
    expect(verifyDist(dir, release)).toEqual(["popup.html loads remote code"]);
  });

  test("a remote src after a data-src attribute reports remote code", () => {
    const dir = fixture({
      "popup.html":
        '<script data-src="./x.js" src="https://cdn.example/x.js"></script>',
    });
    expect(verifyDist(dir, release)).toEqual(["popup.html loads remote code"]);
  });

  test("a protocol-relative stylesheet reports remote code", () => {
    const dir = fixture({
      "options.html": '<link rel="stylesheet" href="//cdn.example/x.css">',
    });
    expect(verifyDist(dir, release)).toEqual([
      "options.html loads remote code",
    ]);
  });

  test("a missing offscreen.html is reported", () => {
    expect(verifyDist(fixture({ "offscreen.html": null }), release)).toEqual([
      "missing offscreen.html",
    ]);
  });

  test("a file the manifest names but the directory lacks is reported", () => {
    expect(verifyDist(fixture({ "icons/128.png": null }), release)).toEqual([
      "missing icons/128.png",
    ]);
  });

  test("a missing manifest is reported alone", () => {
    expect(verifyDist(fixture({ "manifest.json": null }), release)).toEqual([
      "manifest.json is missing or is not valid JSON",
    ]);
  });

  test("an unparseable manifest is reported", () => {
    expect(verifyDist(fixture({ "manifest.json": "{" }), release)).toEqual([
      "manifest.json is missing or is not valid JSON",
    ]);
  });

  test("an e2e hook in a release build is reported", () => {
    const dir = fixture({
      "service-worker.js": "const x = 'RECORDER_E2E_FLOOD';",
    });
    expect(verifyDist(dir, release)).toEqual([
      "service-worker.js contains an e2e-only hook (RECORDER_E2E)",
    ]);
  });

  test("the e2e variant allows the e2e hooks", () => {
    const dir = fixture({
      "service-worker.js": "const x = 'RECORDER_E2E_FLOOD';",
    });
    expect(verifyDist(dir, { variant: "e2e", rootVersion: "0.2.0" })).toEqual(
      [],
    );
  });

  test("a source map in a release build is reported", () => {
    const dir = fixture({ "assets/popup.js.map": "{}" });
    expect(verifyDist(dir, release)).toEqual([
      "source map assets/popup.js.map in a release build",
    ]);
  });

  test("a manifest version that is not the root version is reported", () => {
    const dir = fixture({ "manifest.json": manifest("0.1.0") });
    expect(verifyDist(dir, release)).toEqual([
      "manifest version 0.1.0 is not the release version 0.2.0",
    ]);
  });

  test("an adapted prerelease artifact retains the full root identity", () => {
    const rootVersion = "0.2.0-rehearsal.2";
    const dir = fixture({ "manifest.json": manifest("0.2.0", rootVersion) });
    expect(verifyDist(dir, { ...release, rootVersion })).toEqual([]);
  });

  test("the original raw prerelease artifact fails even when it equals the root version", () => {
    const rootVersion = "0.2.0-rehearsal.2";
    const dir = fixture({
      "manifest.json": manifest(rootVersion, rootVersion),
    });
    expect(verifyDist(dir, { ...release, rootVersion })).toEqual([
      "manifest version 0.2.0-rehearsal.2 is not the release version 0.2.0",
    ]);
  });

  test.each([undefined, "0.2.0-rehearsal.1"])(
    "a prerelease artifact with display identity %j is rejected",
    (versionName) => {
      const dir = fixture({ "manifest.json": manifest("0.2.0", versionName) });
      expect(
        verifyDist(dir, { ...release, rootVersion: "0.2.0-rehearsal.2" }),
      ).toEqual([
        `manifest version_name ${String(versionName)} is not the release version_name 0.2.0-rehearsal.2`,
      ]);
    },
  );

  test("a stable artifact cannot carry a stale prerelease display identity", () => {
    const dir = fixture({
      "manifest.json": manifest("0.2.0", "0.2.0-rehearsal.2"),
    });
    expect(verifyDist(dir, release)).toEqual([
      "manifest version_name 0.2.0-rehearsal.2 is not the release version_name undefined",
    ]);
  });

  test.each(["0.0.0", "0.65536.0", "0.02.0", "0.2.0-rehearsal..2"])(
    "an invalid root identity %s cannot validate a matching artifact",
    (rootVersion) => {
      const dir = fixture({ "manifest.json": manifest(rootVersion) });
      expect(() => verifyDist(dir, { ...release, rootVersion })).toThrow(
        "Invalid Recorder release version",
      );
    },
  );
});
