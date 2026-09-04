import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadApplicationConfiguration } from "../../scripts/application-config";

test("the default app-build configuration loads the OpenBot brand", async () => {
  await expect(loadApplicationConfiguration()).resolves.toEqual({
    brand: { tenantId: "openbot", productName: "OpenBot" },
  });
});

test("a Netsfera app-build configuration loads the NETSFERA ERP brand", async () => {
  await expect(
    loadApplicationConfiguration("../examples/netsfera"),
  ).resolves.toEqual({
    brand: { tenantId: "netsfera", productName: "NETSFERA ERP" },
  });
});

test("the root app-build stage exports its tenant argument to prebuild", () => {
  const dockerfile = readFileSync(
    join(import.meta.dir, "../../Dockerfile"),
    "utf8",
  );
  const appBuildStage = dockerfile.match(
    /FROM deps AS app-build\n([\s\S]*?)\n\nFROM /,
  )?.[1];

  expect(appBuildStage).toContain("ARG TENANT_PACKAGE_DIR=../examples/fintech");
  expect(appBuildStage).toContain(
    `ENV TENANT_PACKAGE_DIR=\${TENANT_PACKAGE_DIR}`,
  );
  expect(appBuildStage).toContain("RUN bun run --cwd app build");
});
