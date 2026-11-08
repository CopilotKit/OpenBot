/**
 * verify-mac-arch.sh, run on stand-in apps made of real Mach-O files compiled for each
 * architecture. The Intel installer is built on the Apple silicon runner, so this check is what
 * stands between an Intel app with an Apple silicon binary in it and every Intel Mac.
 *
 * Needs a Mac (`cc -arch`, `lipo`); elsewhere it skips. Desktop macOS signing runs it on macos-15.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "verify-mac-arch.sh");
const onMac = process.platform === "darwin";
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "verify-mac-arch-"));
  temps.push(dir);
  return dir;
}

/** A Mach-O file at `path`, built for `archs` (two make a universal file). */
function machO(path: string, ...archs: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  const source = join(dirname(path), ".main.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const built = Bun.spawnSync([
    "cc",
    ...archs.flatMap((arch) => ["-arch", arch]),
    "-o",
    path,
    source,
  ]);
  rmSync(source);
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}

/** An OpenBot.app whose executable and bundled Node are `arch`, with `extra` Mach-O files. */
function app(arch: string, extra: Record<string, string[]> = {}) {
  const dir = join(temp(), "OpenBot.app");
  mkdirSync(join(dir, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(dir, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>openbot-desktop</string></dict></plist>\n',
  );
  machO(join(dir, "Contents/MacOS/openbot-desktop"), arch);
  machO(join(dir, "Contents/Resources/cli-bundle/runtime/node"), arch);
  mkdirSync(join(dir, "Contents/Resources/cli-bundle/cli"), {
    recursive: true,
  });
  writeFileSync(join(dir, "Contents/Resources/cli-bundle/cli/index.js"), "");
  for (const [path, archs] of Object.entries(extra)) {
    machO(join(dir, "Contents/Resources/cli-bundle/cli", path), ...archs);
  }
  return dir;
}

function verify(appPath: string, arch: string) {
  const result = Bun.spawnSync(["bash", script, appPath, arch], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

test.skipIf(!onMac)(
  "an Intel app whose every Mach-O is x86_64 passes, and lists each one",
  () => {
    const result = verify(
      app("x86_64", { "node_modules/a/build/a.node": ["x86_64"] }),
      "x86_64",
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "x86_64         Contents/MacOS/openbot-desktop",
    );
    expect(result.out).toContain(
      "x86_64         Contents/Resources/cli-bundle/runtime/node",
    );
    expect(result.out).toContain("3 of the 3 Mach-O files");
  },
);

// What a step that quietly used the runner's architecture leaves behind: npm picking a native module
// for the Apple silicon machine it ran on.
test.skipIf(!onMac)(
  "an Intel app with an Apple silicon native module fails, naming it",
  () => {
    const result = verify(
      app("x86_64", { "node_modules/a/build/a.node": ["arm64"] }),
      "x86_64",
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "Not built for x86_64: Contents/Resources/cli-bundle/cli/node_modules/a/build/a.node (arm64)",
    );
  },
);

test.skipIf(!onMac)(
  "an app built for the runner instead of its target fails on its own executable",
  () => {
    const result = verify(app("arm64"), "x86_64");
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "Not built for x86_64: Contents/MacOS/openbot-desktop (arm64)",
    );
    expect(result.out).toContain(
      "Not built for x86_64: Contents/Resources/cli-bundle/runtime/node (arm64)",
    );
  },
);

test.skipIf(!onMac)(
  "a universal file carries both, and passes either way",
  () => {
    const universal = { "node_modules/a/a.node": ["x86_64", "arm64"] };
    expect(verify(app("x86_64", universal), "x86_64").code).toBe(0);
    expect(verify(app("arm64", universal), "arm64").code).toBe(0);
  },
);

// @azure/msal-node-runtime ships dist/macos/arm64 and dist/macos/x64 in one package and picks one at
// run time, so every Mac installer carries the other architecture's copy beside its own.
test.skipIf(!onMac)(
  "another architecture's copy beside this one's twin passes",
  () => {
    const twins = {
      "node_modules/m/dist/macos/arm64/m.node": ["arm64"],
      "node_modules/m/dist/macos/x64/m.node": ["x86_64"],
      "node_modules/p/prebuilds/darwin-arm64/p.node": ["arm64"],
      "node_modules/p/prebuilds/darwin-x64/p.node": ["x86_64"],
    };
    const intel = verify(app("x86_64", twins), "x86_64");
    expect(intel.code).toBe(0);
    expect(intel.out).toContain(
      "the other 2 are another architecture's copies",
    );
    expect(verify(app("arm64", twins), "arm64").code).toBe(0);
  },
);

test.skipIf(!onMac)(
  "another architecture's copy with no twin for this one fails",
  () => {
    const result = verify(
      app("x86_64", { "node_modules/m/dist/macos/arm64/m.node": ["arm64"] }),
      "x86_64",
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "node_modules/m/dist/macos/arm64/m.node (arm64)",
    );
  },
);

test.skipIf(!onMac)("an architecture it does not know is refused", () => {
  const result = verify(app("x86_64"), "x64");
  expect(result.code).toBe(1);
  expect(result.out).toContain("must be x86_64 or arm64");
});
