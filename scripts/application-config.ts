import { isAbsolute, resolve } from "node:path";
import {
  createApplicationConfiguration,
  loadTenantPackage,
} from "../server/src/tenant-package";

const projectRoot = resolve(import.meta.dir, "..");

export async function loadApplicationConfiguration(
  configuredTenantPackageDirectory = process.env.TENANT_PACKAGE_DIR,
) {
  const tenantPackageDirectory = configuredTenantPackageDirectory
    ? isAbsolute(configuredTenantPackageDirectory)
      ? configuredTenantPackageDirectory
      : resolve(projectRoot, "server", configuredTenantPackageDirectory)
    : resolve(projectRoot, "examples/fintech");
  const tenantPackage = await loadTenantPackage(tenantPackageDirectory);
  return createApplicationConfiguration(tenantPackage);
}
