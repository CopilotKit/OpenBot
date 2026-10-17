import { expect, test } from "bun:test";
import { buildManifest, MINIMUM_CHROME_VERSION } from "../src/manifest";

const base = { version: "0.2.0", publicKey: "MIIBIjANBgkqh" };
const PERMISSIONS: chrome.runtime.ManifestPermission[] = [
  "storage",
  "unlimitedStorage",
  "alarms",
  "offscreen",
  "tabCapture",
  "debugger",
  "scripting",
  "webNavigation",
  "nativeMessaging",
];

test("every build carries the committed public key, so Chrome and Edge give it one fixed id", () => {
  for (const variant of ["release", "e2e"] as const)
    expect(buildManifest({ ...base, variant }).key).toBe(base.publicKey);
});

test("every build ships the debugger permission and the fixed permission set", () => {
  for (const variant of ["release", "e2e"] as const) {
    const manifest = buildManifest({ ...base, variant });
    expect(manifest.permissions).toEqual(PERMISSIONS);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe(MINIMUM_CHROME_VERSION);
    expect(manifest.incognito).toBe("not_allowed");
    expect(manifest.externally_connectable).toEqual({
      matches: ["<all_urls>"],
    });
    expect(manifest.storage).toEqual({ managed_schema: "managed_schema.json" });
    expect(manifest.background).toEqual({
      service_worker: "service-worker.js",
      type: "module",
    });
    expect("content_scripts" in manifest).toBe(false);
    expect("update_url" in manifest).toBe(false); // no store; a company install names its update URL in policy (Task 22)
    expect(manifest.content_security_policy).toEqual({
      extension_pages:
        "script-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  }
});

test("the release build asks for host access at the first Record; the e2e build holds it up front", () => {
  const release = buildManifest({ ...base, variant: "release" });
  expect(release.host_permissions).toBeUndefined();
  expect(release.optional_host_permissions).toEqual(["<all_urls>"]);
  const e2e = buildManifest({ ...base, variant: "e2e" });
  // e2e grants host access up front because Playwright cannot click Chrome's permission prompt,
  // and lists it once: the same pattern in optional_host_permissions too draws a manifest warning.
  expect(e2e.host_permissions).toEqual(["<all_urls>"]);
  expect(e2e.optional_host_permissions).toBeUndefined();
});

test("the version is the release version", () => {
  expect(buildManifest({ ...base, variant: "release" }).version).toBe("0.2.0");
});
