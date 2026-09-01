import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GeneratedConfig = {
  brand: { tenantId: string; productName: string };
};

function generatedConfigFromAppBuild(
  tenantPackageDirectory?: string,
): GeneratedConfig {
  const outputDirectory = mkdtempSync(join(tmpdir(), "openbot-app-build-"));
  const outputPath = join(outputDirectory, "application-config.ts");
  writeFileSync(
    outputPath,
    [
      "export type AppConfig = { brand: { tenantId: string; productName: string } };",
      'export const appConfig: AppConfig = {"brand":{"tenantId":"sentinel","productName":"Sentinel"}};',
      "",
    ].join("\n"),
  );
  try {
    const build = Bun.spawnSync([process.execPath, "scripts/generate-app-config.ts"], {
      env: {
        ...process.env,
        APP_CONFIG_OUTPUT_PATH: outputPath,
        TENANT_PACKAGE_DIR: tenantPackageDirectory,
      },
    });
    expect(build.exitCode).toBe(0);

    const generated = readFileSync(outputPath, "utf8");
    const serializedConfig = generated.match(
      /export const appConfig: AppConfig = (\{[\s\S]*\});\n$/,
    )?.[1];
    expect(serializedConfig).toBeDefined();
    return JSON.parse(serializedConfig as string) as GeneratedConfig;
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

test("the default app-build configuration generates the OpenBot brand", () => {
  expect(generatedConfigFromAppBuild()).toEqual({
    brand: { tenantId: "openbot", productName: "OpenBot" },
  });
});

test("a Netsfera app-build configuration generates the NETSFERA ERP brand", () => {
  expect(generatedConfigFromAppBuild("../examples/netsfera")).toEqual({
    brand: { tenantId: "netsfera", productName: "NETSFERA ERP" },
  });
});
