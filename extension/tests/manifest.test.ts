import { expect, test } from "bun:test";
import { buildManifest, MINIMUM_CHROME_VERSION } from "../src/manifest";

const base = { version: "0.2.0", publicKey: "MIIBIjANBgkqh" };
const PERMISSIONS: chrome.runtime.ManifestPermission[] = [
  "storage",
  "unlimitedStorage",
  "alarms",
  "offscreen",
  "debugger",
  "scripting",
  "webNavigation",
  "nativeMessaging",
];

test("the manifest carries the committed public key, so Chrome and Edge give it one fixed id", () => {
  expect(buildManifest(base).key).toBe(base.publicKey);
});

test("the manifest ships the debugger permission and the fixed permission set", () => {
  const manifest = buildManifest(base);
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
});

test("website access comes with the install: <all_urls> is required, and nothing is asked for later", () => {
  // One manifest for every build variant: the e2e build, which needed host access without a prompt, gets the same one
  // as a release. Granted when the person installs, so neither Connect nor the first Record asks for it.
  const manifest = buildManifest(base);
  expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.optional_permissions).toBeUndefined();
});

test("the version is the release version", () => {
  expect(buildManifest(base).version).toBe("0.2.0");
});
