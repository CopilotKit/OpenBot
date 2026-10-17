import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BuildVariant } from "../src/manifest";

type VerifyOptions = { variant: BuildVariant; rootVersion: string };

const MODULE_SYNTAX = /^\s*(import|export)\s/m;
const REMOTE_URL = /^(https?:|\/\/)/i;
const TAG = /<(script|link)\b[^>]*>/gi;

function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(dir, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return found;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "i",
  ).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function loadsRemoteCode(html: string): boolean {
  for (const [tag, name] of html.matchAll(TAG)) {
    const url = attribute(
      tag,
      name.toLowerCase() === "script" ? "src" : "href",
    );
    if (url !== undefined && REMOTE_URL.test(url.trim())) return true;
  }
  return false;
}

function namedFiles(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") names.push(value);
  };
  const addValues = (value: unknown) => {
    if (value && typeof value === "object") Object.values(value).forEach(add);
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  add(record(manifest.background).service_worker);
  add(record(manifest.action).default_popup);
  addValues(record(manifest.action).default_icon);
  add(manifest.options_page);
  add(record(manifest.options_ui).page);
  addValues(manifest.icons);
  add(record(manifest.storage).managed_schema);
  return names;
}

/** Returns the problems with a built extension directory; empty means good. */
export function verifyDist(dir: string, options: VerifyOptions): string[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return ["manifest.json is missing or is not valid JSON"];
  }

  const problems: string[] = [];
  const required = new Set([
    ...namedFiles(manifest),
    "content.js",
    "page-network.js",
    "offscreen.html",
  ]);
  for (const name of required) {
    if (!existsSync(join(dir, name))) problems.push(`missing ${name}`);
  }

  for (const name of ["content.js", "page-network.js"]) {
    const path = join(dir, name);
    if (existsSync(path) && MODULE_SYNTAX.test(readFileSync(path, "utf8"))) {
      problems.push(`${name} must be a classic script`);
    }
  }

  const all = listFiles(dir);
  for (const name of all.filter((file) => file.endsWith(".html"))) {
    if (loadsRemoteCode(readFileSync(join(dir, name), "utf8"))) {
      problems.push(`${name} loads remote code`);
    }
  }

  if (manifest.version !== options.rootVersion) {
    problems.push(
      `manifest version ${String(manifest.version)} is not the release version ${options.rootVersion}`,
    );
  }

  if (options.variant === "release") {
    for (const name of all) {
      if (name.endsWith(".map")) {
        problems.push(`source map ${name} in a release build`);
      } else if (readFileSync(join(dir, name)).includes("RECORDER_E2E")) {
        problems.push(`${name} contains an e2e-only hook (RECORDER_E2E)`);
      }
    }
  }
  return problems;
}
