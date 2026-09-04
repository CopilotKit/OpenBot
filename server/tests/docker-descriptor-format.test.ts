import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const scripts = [
  "stage-reviewed-g1.sh",
  "verify-staged-g1.sh",
  "openbot-compose-lock-v1.sh",
  "manage-openbot-g1-activation-v1.sh",
  "recover-openbot-g0-baseline-v1.sh",
];

test.each(scripts)("%s reads Docker's lowercase descriptor map key", (name) => {
  const source = readFileSync(
    resolve(import.meta.dir, `../../deploy/netsfera/${name}`),
    "utf8",
  );
  expect(source).not.toContain("{{.Descriptor.Digest}}");
  expect(source).toContain(`{{index .Descriptor "digest"}}`);
});
