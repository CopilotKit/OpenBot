/**
 * The fixed names a release attaches its installers under.
 *
 * Tauri puts the version in every installer's name, `OpenBot_0.3.0_aarch64.dmg`, so a link to
 * `releases/latest/download/<that name>` breaks with the next release. Each installer is also
 * attached under a name without the version, and a web page links to that one. These names are a
 * public address: docs/releasing.md lists them, and changing one breaks every page that links to it.
 *
 * Usage: bun scripts/release-download-names.ts <installer file name>
 * Prints the fixed name, or fails for a file that is not one of the known installers, so a new
 * platform or a renamed product is noticed instead of being published without a stable link.
 */
import { basename } from "node:path";

const names: ReadonlyArray<readonly [RegExp, string]> = [
  [/^OpenBot_[^_]+_aarch64\.dmg$/, "OpenBot-mac-arm64.dmg"],
  [/^OpenBot_[^_]+_x64\.dmg$/, "OpenBot-mac-x64.dmg"],
  [/^OpenBot_[^_]+_x64-setup\.exe$/, "OpenBot-windows-x64-setup.exe"],
];

/** The fixed name for an installer Tauri built, or undefined for any other file. */
export function downloadName(installer: string): string | undefined {
  const name = basename(installer);
  return names.find(([pattern]) => pattern.test(name))?.[1];
}

if (import.meta.main) {
  const installer = process.argv[2];
  if (!installer || process.argv.length > 3) {
    console.error(
      "Usage: bun scripts/release-download-names.ts <installer file name>",
    );
    process.exit(2);
  }
  const name = downloadName(installer);
  if (!name) {
    console.error(
      `${basename(installer)} is not an installer with a fixed download name. Add it to scripts/release-download-names.ts and docs/releasing.md.`,
    );
    process.exit(1);
  }
  console.log(name);
}
