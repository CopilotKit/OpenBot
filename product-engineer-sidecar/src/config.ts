import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  for (const path of [join(root, ".env"), join(root, "..", ".env")]) {
    if (!existsSync(path)) continue;
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
}

loadDotEnv();

function optional(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value && value.length > 0) return value;
  return fallback;
}

export type ProductEngineerConfig = {
  cursorApiKey: string;
  linearApiKey: string;
  repos: string[];
  model: string;
  startingRef: string | undefined;
};

export type SidecarConfig = {
  port: number;
  /** When set, every request must send Authorization: Bearer <token>. */
  token: string | undefined;
  runsDir: string;
  productEngineer: ProductEngineerConfig;
};

/**
 * Load sidecar settings. Returns null when CURSOR_API_KEY / LINEAR_API_KEY / PE_REPOS
 * are incomplete so the process can exit with a clear message.
 */
export function loadSidecarConfig(): SidecarConfig | null {
  const cursorApiKey = optional("CURSOR_API_KEY");
  const linearApiKey = optional("LINEAR_API_KEY");
  const reposRaw = optional("PE_REPOS");
  if (!cursorApiKey || !linearApiKey || !reposRaw) return null;

  const repos = reposRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (repos.length === 0) return null;

  const rawRef = optional("PE_STARTING_REF");
  const portRaw = optional("PE_PORT", "3020") ?? "3020";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PE_PORT must be an integer port, got ${portRaw}`);
  }

  return {
    port,
    token: optional("PE_SIDECAR_TOKEN"),
    runsDir: optional("PE_RUNS_DIR", join(root, ".runs")) ?? join(root, ".runs"),
    productEngineer: {
      cursorApiKey,
      linearApiKey,
      repos,
      model: optional("PE_MODEL", "composer-2.5") ?? "composer-2.5",
      startingRef: rawRef && rawRef.length > 0 ? rawRef : undefined,
    },
  };
}
