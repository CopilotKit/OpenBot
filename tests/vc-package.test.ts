import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const vcDirectory = join(import.meta.dir, "..", "examples", "vc");

test("includes the complete venture deployment package example", () => {
  for (const fileName of [
    "brand.yaml",
    "agents.yaml",
    "channels.yaml",
    "model.yaml",
    "knowledge.yaml",
  ]) {
    expect(existsSync(join(vcDirectory, fileName))).toBe(true);
  }

  expect(readFileSync(join(vcDirectory, "brand.yaml"), "utf8")).toContain(
    "id: venture",
  );
});

test("names every environment variable with a fallback, so a clone can read it", () => {
  // Same property the fintech package holds: a package a checkout can load with no .env. A name here
  // without a `:-` fallback would leave a clone unable to read the package.
  const agents = readFileSync(join(vcDirectory, "agents.yaml"), "utf8");
  const referenced = [
    ...agents.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g),
  ];

  expect(referenced.length).toBeGreaterThan(0);
  for (const [, name, rest] of referenced) {
    expect(
      rest.startsWith(":-"),
      `\${${name}} in agents.yaml has no fallback, so a clone with no .env cannot read it`,
    ).toBe(true);
  }
});
