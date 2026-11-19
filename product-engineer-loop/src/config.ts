import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export type Config = {
  cursorApiKey: string;
  linearApiKey: string;
  repos: { url: string; startingRef?: string }[];
  model: string;
  startingRef: string | undefined;
  runsDir: string;
  root: string;
};

export function loadConfig(overrides?: { repos?: string[] }): Config {
  // Empty PE_STARTING_REF → omit startingRef and let Cursor use the repo default.
  const rawRef = process.env.PE_STARTING_REF?.trim();
  const startingRef = rawRef && rawRef.length > 0 ? rawRef : undefined;
  const fromEnv = (process.env.PE_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = overrides?.repos?.length ? overrides.repos : fromEnv;
  if (urls.length === 0) {
    throw new Error(
      "PE_REPOS must list at least one GitHub repo URL (comma-separated), or pass --repo.",
    );
  }

  return {
    cursorApiKey: required("CURSOR_API_KEY"),
    linearApiKey: required("LINEAR_API_KEY"),
    repos: urls.map((url) => (startingRef ? { url, startingRef } : { url })),
    model: optional("PE_MODEL", "composer-2.5"),
    startingRef,
    runsDir: optional("PE_RUNS_DIR", join(root, ".runs")),
    root,
  };
}
