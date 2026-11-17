/**
 * The staged rollout on downloads.copilotkit.ai: a CloudFront Function
 * (scripts/downloads-rollout.js) sends a share of the requests for latest/ to rollout/<tag>/,
 * by a hash of the viewer's address, with the tag and the share read from a KeyValueStore. The
 * file runs here exactly as CloudFront runs it, with a pretend `cloudfront` module.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = readFileSync(join(root, "scripts/downloads-rollout.js"), "utf8");

type Request = {
  method: string;
  uri: string;
  querystring: Record<string, { value: string }>;
  headers: Record<string, { value: string }>;
  cookies: Record<string, { value: string }>;
};
type Rollout = {
  handler(event: {
    viewer: { ip: string };
    request: Request;
  }): Promise<Request>;
  bucketOf(tag: string, ip: string): number;
  viewerKey(ip: string): string;
  FILES: string[];
};

/** The function, with its key value store holding `store`. */
function load(store: Record<string, string>): Rollout {
  const cf = {
    kvs: () => ({
      // As CloudFront's does: a key that is not there rejects.
      get: async (key: string) => {
        if (!(key in store)) throw new Error(`Key ${key} not found`);
        return store[key];
      },
    }),
  };
  const imports = 'import cf from "cloudfront";';
  expect(source).toContain(imports);
  const body = source.replace(imports, "");
  return new Function(
    "cf",
    `${body}\nreturn { handler, bucketOf, viewerKey, FILES };`,
  )(cf) as Rollout;
}

function request(uri: string, ip = "198.51.100.7") {
  return {
    viewer: { ip },
    request: {
      method: "GET",
      uri,
      querystring: { x: { value: "1" } },
      headers: { host: { value: "downloads.copilotkit.ai" } },
      cookies: {},
    },
  };
}

const at = (tag: string, percent: string) =>
  load({ "rollout-tag": tag, "rollout-percent": percent });

/** FNV-1a, 32 bits, over `text`, worked with BigInt: a reference the function must agree with. */
function fnv1a(text: string) {
  let hash = 0x811c9dc5n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x01000193n) & 0xffffffffn;
  }
  return Number(hash);
}

/** Every address 10.<a>.<b>.<c>, spread over the space, for counting cohorts. */
function addresses(count: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = (i * 2654435761) >>> 0;
    out.push(
      `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`,
    );
  }
  return out;
}

test("the four files under latest/ go to rollout/<tag>/ for the viewers in the share, and stay otherwise", async () => {
  for (const file of FILES()) {
    const all = await at("v1.1.0", "100").handler(request(`/latest/${file}`));
    expect(all.uri).toBe(`/rollout/v1.1.0/${file}`);
    const none = await at("v1.1.0", "0").handler(request(`/latest/${file}`));
    expect(none.uri).toBe(`/latest/${file}`);
  }
  // Only the URI changes: the query string, headers and method go on as they came.
  const rewritten = await at("v1.1.0", "100").handler(
    request("/latest/latest.json"),
  );
  expect(rewritten).toEqual({
    ...request("/latest/latest.json").request,
    uri: "/rollout/v1.1.0/latest.json",
  });
});

function FILES() {
  return at("v1.1.0", "0").FILES;
}

test("the files it moves are exactly the fixed download names and the update feed", () => {
  const names = Bun.spawnSync([
    "bash",
    join(root, "scripts/release-download-names.sh"),
    "--all",
  ])
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  expect([...FILES()].sort()).toEqual([...names, "latest.json"].sort());
});

test("everything else passes through untouched: the registry, releases, tools and other paths", async () => {
  const fn = at("v1.1.0", "100");
  for (const uri of [
    "/v2/",
    "/v2/copilotkit/openbot/manifests/v1.0.3",
    "/v2/copilotkit/openbot/blobs/sha256:abc",
    "/releases/v1.0.3/OpenBot_1.0.3_aarch64.dmg",
    "/releases/v1.1.0/desktop-images.json",
    "/tools/podman/v5.4.0/podman-installer.pkg",
    "/latest/",
    "/latest/other.json",
    "/latest/latest.json/x",
    "/latest/sub/latest.json",
    "/rollout/v1.1.0/latest.json",
    "/LATEST/latest.json",
    "/",
  ]) {
    expect((await fn.handler(request(uri))).uri).toBe(uri);
  }
});

test("a missing or malformed setting leaves every request on latest/", async () => {
  for (const store of [
    {},
    { "rollout-tag": "v1.1.0" },
    { "rollout-percent": "100" },
    { "rollout-tag": "v1.1.0-rc.2", "rollout-percent": "100" },
    { "rollout-tag": "1.1.0", "rollout-percent": "100" },
    { "rollout-tag": "v1.1.0/../x", "rollout-percent": "100" },
    { "rollout-tag": "v1.1.0", "rollout-percent": "" },
    { "rollout-tag": "v1.1.0", "rollout-percent": "-5" },
    { "rollout-tag": "v1.1.0", "rollout-percent": "5.5" },
    { "rollout-tag": "v1.1.0", "rollout-percent": "101" },
    { "rollout-tag": "v1.1.0", "rollout-percent": "five" },
  ]) {
    const result = await load(store).handler(request("/latest/latest.json"));
    expect(result.uri).toBe("/latest/latest.json");
  }
});

test("a viewer's bucket is FNV-1a of the tag and its address, from 0 to 99", () => {
  const fn = at("v1.1.0", "5");
  for (const ip of [
    "198.51.100.7",
    "203.0.113.250",
    "8.8.8.8",
    "52.94.236.248",
    "100.64.0.1",
  ]) {
    expect(fn.bucketOf("v1.1.0", ip)).toBe(fnv1a(`v1.1.0 ${ip}`) % 100);
  }
  // Pinned, so a change to the hash, which would move every viewer to a new cohort mid-rollout,
  // fails here first.
  expect(fn.bucketOf("v1.1.0", "198.51.100.7")).toBe(77);
});

test("5% of addresses get the rollout, and the same ones every time", async () => {
  const fn = at("v1.1.0", "5");
  const ips = addresses(20_000);
  let moved = 0;
  for (const ip of ips) {
    const first = await fn.handler(request("/latest/latest.json", ip));
    const again = await fn.handler(
      request("/latest/OpenBot-mac-arm64.dmg", ip),
    );
    // Sticky: the feed and the installer agree, on every request.
    expect(first.uri.startsWith("/rollout/")).toBe(
      again.uri.startsWith("/rollout/"),
    );
    if (first.uri.startsWith("/rollout/")) moved++;
  }
  expect(moved / ips.length).toBeGreaterThan(0.04);
  expect(moved / ips.length).toBeLessThan(0.06);
});

test("ramping up keeps everyone who already had the rollout, and a new release draws a new cohort", () => {
  const fn = at("v1.1.0", "5");
  const ips = addresses(5_000);
  const cohort = (tag: string, percent: number) =>
    new Set(ips.filter((ip) => fn.bucketOf(tag, ip) < percent));
  const five = cohort("v1.1.0", 5);
  const quarter = cohort("v1.1.0", 25);
  for (const ip of five) expect(quarter.has(ip)).toBe(true);
  expect(quarter.size / ips.length).toBeGreaterThan(0.22);
  expect(quarter.size / ips.length).toBeLessThan(0.28);
  expect(cohort("v1.1.0", 100).size).toBe(ips.length);
  expect(cohort("v1.1.0", 0).size).toBe(0);
  // The next release's 5% is not the same people again.
  const next = cohort("v1.2.0", 5);
  const both = [...five].filter((ip) => next.has(ip)).length;
  expect(both / five.size).toBeLessThan(0.2);
});

test("an IPv6 viewer is placed by its /64, so its rotating addresses stay in one cohort", () => {
  const fn = at("v1.1.0", "5");
  expect(fn.viewerKey("198.51.100.7")).toBe("198.51.100.7");
  const key = fn.viewerKey("2001:db8:abcd:12:1:2:3:4");
  expect(key).toBe("2001:db8:abcd:12::/64");
  for (const ip of [
    "2001:0db8:abcd:0012:ffff:ffff:ffff:ffff",
    "2001:DB8:ABCD:12::1",
    "2001:db8:abcd:12::",
    "2001:db8:abcd:12:0:0:0:1",
  ]) {
    expect(fn.viewerKey(ip)).toBe(key);
    expect(fn.bucketOf("v1.1.0", ip)).toBe(
      fn.bucketOf("v1.1.0", "2001:db8:abcd:12:1:2:3:4"),
    );
  }
  expect(fn.viewerKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(fn.viewerKey("::1")).toBe("0:0:0:0::/64");
  expect(fn.viewerKey("2001:db8:abcd:13::1")).not.toBe(key);
  // Anything it cannot read is hashed as it came, never thrown on.
  expect(fn.viewerKey("2001:db8::1::2")).toBe("2001:db8::1::2");
  expect(fn.viewerKey("garbage:zz::1")).toBe("garbage:zz::1");
});

// The test path: the same function on a test cache behavior, /rollout-test/*, so both cohorts
// can be shown through the real distribution before it touches latest/.
test("the test path routes like latest/, to latest/ or to rollout/<tag>/", async () => {
  const all = await at("v1.0.2", "100").handler(
    request("/rollout-test/latest/latest.json"),
  );
  expect(all.uri).toBe("/rollout/v1.0.2/latest.json");
  const none = await at("v1.0.2", "0").handler(
    request("/rollout-test/latest/OpenBot-mac-x64.dmg"),
  );
  expect(none.uri).toBe("/latest/OpenBot-mac-x64.dmg");
  const other = await at("v1.0.2", "100").handler(
    request("/rollout-test/releases/v1.0.2/x"),
  );
  expect(other.uri).toBe("/rollout-test/releases/v1.0.2/x");
});
