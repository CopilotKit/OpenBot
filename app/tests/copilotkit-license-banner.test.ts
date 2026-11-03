import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NexQN does not draw CopilotKit's "Powered by CopilotKit · Get a license" bar.
 *
 * The bar is rendered inside `@copilotkit/react-core`, with no prop or setting to turn it off, so
 * `patches/@copilotkit%2Freact-core@<version>.patch` removes that one render. The other licence
 * notices (expired, invalid, expiring) stay: they tell an operator something is wrong.
 *
 * A version bump that drops the patch would bring the bar back silently, since nothing else reads
 * it. This reads the copy the app actually resolves.
 */

const dist = dirname(
  fileURLToPath(import.meta.resolve("@copilotkit/react-core")),
);
const bundles = readdirSync(dist)
  .filter((name) => /\.(mjs|cjs)$/.test(name))
  .map((name) => readFileSync(join(dist, name), "utf8"))
  .filter((source) => source.includes("function LicenseWarningBanner"));

test("the installed react-core has a provider that draws licence notices", () => {
  expect(bundles.length).toBeGreaterThan(0);
});

test("no installed bundle draws the no_license bar", () => {
  for (const source of bundles) {
    expect(source).not.toContain(
      '(LicenseWarningBanner, { type: "no_license" })',
    );
  }
});

test("the expired, invalid and expiring notices are still drawn", () => {
  for (const source of bundles) {
    for (const type of ["expired", "invalid", "expiring"]) {
      expect(source).toContain(`(LicenseWarningBanner, { type: "${type}" })`);
    }
  }
});
