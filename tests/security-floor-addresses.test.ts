/**
 * Where each app reads the security floor (shared/security-floor.ts). The addresses live with each
 * app, never in shared/, which every self-hosted OpenBot ships (app/tests/update-banner.test.tsx
 * fails a self-hosted OpenBot that names downloads.copilotkit.ai). So there are three copies, and
 * this holds them equal: the Recorder's, OpenBot Mobile's and OpenBot Desktop's.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECURITY_FLOOR_ADDRESSES as RECORDER } from "../extension/src/shared/security-floor-addresses";
import { SECURITY_FLOOR_ADDRESSES as PHONE } from "../mobile/src/security-floor-addresses";

const PUBLISHED = [
  "https://downloads.copilotkit.ai/latest/security-floor.json",
  "https://github.com/CopilotKit/OpenBot/releases/latest/download/security-floor.json",
];

/** `ADDRESSES` in desktop/src-tauri/src/security_floor.rs, read from the source. */
function desktops(): string[] {
  const source = readFileSync(
    join(import.meta.dir, "..", "desktop/src-tauri/src/security_floor.rs"),
    "utf8",
  );
  const block = /pub const ADDRESSES: \[&str; \d+\] = \[([^\]]*)\];/.exec(
    source,
  );
  if (!block?.[1]) throw new Error("security_floor.rs has no ADDRESSES");
  return [...block[1].matchAll(/"([^"]+)"/g)].map(
    (found) => found[1] as string,
  );
}

test("every app reads the floor beside the update feed, mirror first, in the same order", () => {
  expect([...RECORDER]).toEqual(PUBLISHED);
  expect([...PHONE]).toEqual(PUBLISHED);
  expect(desktops()).toEqual(PUBLISHED);
});

test("the floor is published where the apps read it: the Latest release and its mirror's latest/", () => {
  const sync = readFileSync(
    join(import.meta.dir, "..", "scripts/downloads-sync.sh"),
    "utf8",
  );
  expect(sync).toContain(
    `add "\${served}security-floor.json" security-floor.json`,
  );
  for (const address of PUBLISHED)
    expect(
      address.endsWith("/latest/security-floor.json") ||
        address.endsWith("/releases/latest/download/security-floor.json"),
    ).toBe(true);
});
