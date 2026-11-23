// Staged rollout for downloads.copilotkit.ai: a CloudFront Function (cloudfront-js-2.0) on the
// viewer request of the distribution's default behavior (docs/releasing.md, "Staged rollout").
//
// It sends a share of the requests for latest/'s installers and update feed to rollout/<tag>/,
// where Downloads sync put a held-back stable release's signed files under the same names. Who
// gets it is a hash of the release tag and the viewer's address (its /64 for IPv6), so a viewer's
// feed and installer agree, a ramp from 5 to 25 keeps the first 5, and each release draws a new
// cohort. The tag and the percent live in the KeyValueStore associated with the function:
//   rollout-tag      a stable tag, such as v1.1.0
//   rollout-percent  a whole number from 0 to 100
// A missing or malformed value leaves every request on latest/. Everything else passes through.
//
// Changing either value takes effect in seconds, with no change to this code.
// scripts/downloads-rollout.test.ts runs this file as it is.
import cf from "cloudfront";

const kvs = cf.kvs();

// The fixed download names (scripts/release-download-names.sh) and the update feed.
const FILES = [
  "OpenBot-mac-arm64.dmg",
  "OpenBot-mac-x64.dmg",
  "OpenBot-windows-x64-setup.exe",
  "latest.json",
];
// latest/, and the test path a test cache behavior serves before latest/ is switched over.
const PREFIXES = ["/latest/", "/rollout-test/latest/"];
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const PERCENT = /^(100|[0-9]{1,2})$/;

// What identifies a viewer: an IPv4 address as it is, an IPv6 address by its /64, which a home or
// office network keeps while each device's own address changes. Anything else, as it came.
function viewerKey(ip) {
  if (ip.indexOf(":") === -1) return ip;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  // An embedded IPv4 address (::ffff:192.0.2.1) is the last two groups.
  const width =
    head.length +
    tail.length +
    (tail.length && tail[tail.length - 1].indexOf(".") !== -1 ? 1 : 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return ip;
  const groups = head.slice();
  for (let i = width; i < 8; i++) groups.push("0");
  const prefix = groups.concat(tail).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(prefix[i])) return ip;
    prefix[i] = parseInt(prefix[i], 16).toString(16);
  }
  return `${prefix.join(":")}::/64`;
}

// FNV-1a, 32 bits, of "<tag> <viewer>", from 0 to 99.
function bucketOf(tag, ip) {
  const text = `${tag} ${viewerKey(ip)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

// CloudFront calls it by this name.
// biome-ignore lint/correctness/noUnusedVariables: the function's entry point.
async function handler(event) {
  const request = event.request;
  let file = null;
  for (let i = 0; i < PREFIXES.length; i++) {
    const rest = request.uri.slice(PREFIXES[i].length);
    if (
      request.uri.slice(0, PREFIXES[i].length) === PREFIXES[i] &&
      FILES.indexOf(rest) !== -1
    ) {
      file = rest;
    }
  }
  if (file === null) return request;

  let tag = "";
  let percent = "";
  try {
    tag = await kvs.get("rollout-tag");
    percent = await kvs.get("rollout-percent");
  } catch (_e) {
    tag = "";
  }
  if (
    TAG.test(tag) &&
    PERCENT.test(percent) &&
    bucketOf(tag, event.viewer.ip) < Number(percent)
  ) {
    request.uri = `/rollout/${tag}/${file}`;
  } else {
    request.uri = `/latest/${file}`;
  }
  return request;
}
