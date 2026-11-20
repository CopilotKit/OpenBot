/**
 * Windows names OpenBot's publisher as CopilotKit, and the copyright reads OpenBot by CopilotKit.
 *
 * v0.3.3's installer listed the publisher as "copilotkit" in Settings > Apps and in Programs and
 * Features. tauri.conf.json set no `bundle.publisher`, so Tauri fell back to the identifier's second
 * segment, both for the NSIS installer's `Publisher` uninstall value (its `MANUFACTURER`) and for
 * the app's `CompanyName` version resource (tauri-build).
 *
 * The publisher stays CopilotKit: the installer keeps the install folder under
 * `Software\<publisher>\OpenBot` and reads it back on every update. Windows registry keys ignore
 * case, so CopilotKit is the same key v0.3.3 wrote under "copilotkit", and a different name would
 * lose the folder an update installs into.
 *
 * The copyright is what a person reads: the installer's and the uninstaller's branding text, the
 * `LegalCopyright` version resource and the Mac app's About box. It names the company as product
 * copy does, OpenBot by CopilotKit, never CopilotKit alone (.claude/skills/openbot-copy).
 *
 * Plain file reads only, so it runs on any runner.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tauri = join(import.meta.dir, "..", "src-tauri");
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(tauri, file), "utf8"));

type Json = Record<string, unknown>;
type Config = {
  identifier: string;
  bundle: { publisher?: string; copyright?: string };
};

/** RFC 7396 merge, as `tauri build --config` lays an overlay on tauri.conf.json. */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return patch;
  const out: Json =
    typeof base === "object" && base !== null && !Array.isArray(base)
      ? { ...(base as Json) }
      : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

/** What Tauri writes as the publisher: `bundle.publisher`, else the identifier's second segment. */
const publisherOf = (config: Config) =>
  config.bundle.publisher ??
  config.identifier.split(".")[1] ??
  config.identifier;

const base = readJson("tauri.conf.json");
const builds: Record<string, Config> = {
  "desktop CI": base,
  "Windows signing": merge(
    base,
    readJson("tauri.windows-signing.conf.json"),
  ) as Config,
  "Mac signing": merge(
    base,
    readJson("tauri.macos-signing.conf.json"),
  ) as Config,
};

for (const [build, config] of Object.entries(builds)) {
  test(`the ${build} build names CopilotKit as the publisher`, () => {
    expect(publisherOf(config)).toBe("CopilotKit");
  });

  test(`the ${build} build's copyright reads OpenBot by CopilotKit`, () => {
    expect(config.bundle.copyright).toBe("OpenBot by CopilotKit");
  });

  test(`the ${build} build keeps the identifier and the registry key an update reads`, () => {
    // Updates and app data are keyed on the identifier.
    expect(config.identifier).toBe("ai.copilotkit.openbot.desktop");
    // v0.3.3 kept its install folder under Software\copilotkit\OpenBot. Registry keys ignore case.
    expect(publisherOf(config).toLowerCase()).toBe("copilotkit");
  });
}
