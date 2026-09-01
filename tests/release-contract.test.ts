import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("a release moves the Helm default to the image built from that release", () => {
  const prepare = read(".github/workflows/release.yml");
  const publish = read(".github/workflows/publish-release.yml");

  expect(prepare).toContain(
    'sed -i -E "s/^appVersion: .*/appVersion: \\"$version\\"/" charts/openbot/Chart.yaml',
  );
  expect(publish).toMatch(
    /grep -qx "appVersion: \\"\$\{VERSION#v\}\\"" charts\/openbot\/Chart\.yaml/,
  );
});

test("computer pods stay bootable on the last release while the next image is unpublished", () => {
  const statefulSet = read(
    "charts/openbot/templates/computer/statefulset.yaml",
  );
  const sandboxTemplate = read("charts/openbot/templates/_helpers.tpl");

  for (const template of [statefulSet, sandboxTemplate]) {
    expect(template).toContain("/app/agent-computer/entrypoint.sh");
    expect(template).toContain("/app/agent-computer/src/index.ts");
    expect(template).toContain("/bin/bash");
  }
});
