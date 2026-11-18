/**
 * scripts/release-security-floor.sh against a pretend repository whose releases each hold their own
 * files: a signed floor goes on the Latest release, a release that becomes Latest carries it, and a
 * release never trades its floor for one with a lower serial.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "release-security-floor.sh");

// A `gh` that keeps each release's files in releases/<tag>/ and the Latest tag in latest.
const GH = `#!/usr/bin/env bash
printf '%s\\n' "gh $*" >> "$FAKE_STATE/calls.log"
if [ "$1" = api ] && [[ "$2" == repos/*/releases/latest ]]; then
  latest="$(cat "$FAKE_STATE/latest")"
  if [ -z "$latest" ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
  echo "$latest"; exit 0
fi
if [ "$1 $2" = "release view" ]; then
  ls "$FAKE_STATE/releases/$3" 2> /dev/null; exit 0
fi
if [ "$1 $2" = "release download" ]; then
  tag="$3"; pattern=""; dir="."
  while [ "$#" -gt 0 ]; do
    case "$1" in --pattern) pattern="$2"; shift ;; --dir) dir="$2"; shift ;; esac
    shift
  done
  if [ ! -f "$FAKE_STATE/releases/$tag/$pattern" ]; then echo 'no assets match' >&2; exit 1; fi
  mkdir -p "$dir"; cp "$FAKE_STATE/releases/$tag/$pattern" "$dir/$pattern"; exit 0
fi
if [ "$1 $2" = "release upload" ]; then
  tag="$3"; shift 3; mkdir -p "$FAKE_STATE/releases/$tag"
  while [ "$#" -gt 0 ]; do
    case "$1" in -R) shift ;; --*) ;; *) cp "$1" "$FAKE_STATE/releases/$tag/$(basename "$1")" ;; esac
    shift
  done
  exit 0
fi
exit 0
`;

/** A floor document as the script sees it: only the payload's serial matters here. */
function floor(serial: number): string {
  const payload = Buffer.from(
    JSON.stringify({ kind: "openbot-security-floor", serial }),
  ).toString("base64");
  return `${JSON.stringify({ payload, signature: "c2lnbmVk" })}\n`;
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function repo(latest: string, releases: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), "security-floor-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), GH);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeFileSync(join(dir, "latest"), latest);
  writeFileSync(join(dir, "calls.log"), "");
  for (const [tag, text] of Object.entries(releases)) {
    mkdirSync(join(dir, "releases", tag), { recursive: true });
    writeFileSync(join(dir, "releases", tag, "latest.json"), "{}");
    if (text)
      writeFileSync(join(dir, "releases", tag, "security-floor.json"), text);
  }
  const run = (...args: string[]) =>
    spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        FAKE_STATE: dir,
        GITHUB_REPOSITORY: "CopilotKit/OpenBot",
        GH_TOKEN: "fake",
        TMPDIR: dir,
      },
    });
  const held = (tag: string) => {
    const path = join(dir, "releases", tag, "security-floor.json");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  return { run, held, write };
}

describe("putting the security floor on a release", () => {
  test("a signed floor goes on the Latest release", () => {
    const r = repo("v1.1.2", { "v1.1.2": null });
    const result = r.run("v1.1.2", r.write("signed.json", floor(1)));
    expect(result.status).toBe(0);
    expect(r.held("v1.1.2")).toBe(floor(1));
  });

  test("a release becoming Latest carries the Latest release's floor", () => {
    const r = repo("v1.1.2", { "v1.1.2": floor(3), "v1.1.3": null });
    const result = r.run("v1.1.3");
    expect(result.status).toBe(0);
    expect(r.held("v1.1.3")).toBe(floor(3));
  });

  test("a release keeps a floor with a higher serial than the one offered", () => {
    const r = repo("v1.1.2", { "v1.1.2": floor(2), "v1.1.3": floor(4) });
    expect(r.run("v1.1.3").status).toBe(0);
    expect(r.held("v1.1.3")).toBe(floor(4));
    expect(r.run("v1.1.2", r.write("old.json", floor(1))).status).toBe(0);
    expect(r.held("v1.1.2")).toBe(floor(2));
  });

  test("with no floor anywhere, nothing is carried", () => {
    const r = repo("v1.1.2", { "v1.1.2": null, "v1.1.3": null });
    expect(r.run("v1.1.3").status).toBe(0);
    expect(r.held("v1.1.3")).toBeNull();
  });

  test("a file that is not a floor is refused", () => {
    const r = repo("v1.1.2", { "v1.1.2": null });
    const result = r.run("v1.1.2", r.write("bad.json", "{}"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("names no serial");
    expect(r.held("v1.1.2")).toBeNull();
  });
});
