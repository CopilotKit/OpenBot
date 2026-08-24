import type { HermesBridgeServerConfig } from "./server";
import type { HermesProfileRosterEntry } from "./bridge";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4310;
const DEFAULT_CLI = "hermes";
const DEFAULT_MAX_INPUT_CHARS = 8_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 1;

export type BridgeEnvironment = Record<string, string | undefined>;

export function loadHermesBridgeConfig(
  environment: BridgeEnvironment = process.env,
): HermesBridgeServerConfig {
  const authToken = required(environment, "OPENBOT_HERMES_BRIDGE_TOKEN");
  const roster = parseRoster(required(environment, "OPENBOT_HERMES_PROFILES"));
  const host = environment.OPENBOT_HERMES_BRIDGE_HOST?.trim() || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Hermes bridge must bind to loopback.");
  }

  return {
    authToken,
    cliPath: environment.OPENBOT_HERMES_CLI_PATH?.trim() || DEFAULT_CLI,
    roster,
    host,
    port: boundedInteger(environment.OPENBOT_HERMES_BRIDGE_PORT, DEFAULT_PORT, 1, 65_535),
    maxInputChars: boundedInteger(
      environment.OPENBOT_HERMES_MAX_INPUT_CHARS,
      DEFAULT_MAX_INPUT_CHARS,
      256,
      64_000,
    ),
    maxOutputChars: boundedInteger(
      environment.OPENBOT_HERMES_MAX_OUTPUT_CHARS,
      DEFAULT_MAX_OUTPUT_CHARS,
      256,
      64_000,
    ),
    timeoutMs: boundedInteger(
      environment.OPENBOT_HERMES_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      100,
      120_000,
    ),
    maxConcurrent: boundedInteger(
      environment.OPENBOT_HERMES_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT,
      1,
      4,
    ),
  };
}

function required(environment: BridgeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseRoster(raw: string): HermesProfileRosterEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OPENBOT_HERMES_PROFILES must be valid JSON.");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("OPENBOT_HERMES_PROFILES must be a non-empty JSON array.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`OPENBOT_HERMES_PROFILES entry ${index} is invalid.`);
    }
    const id = entry.id;
    const displayName = entry.displayName;
    if (typeof id !== "string" || typeof displayName !== "string") {
      throw new Error(`OPENBOT_HERMES_PROFILES entry ${index} needs id and displayName.`);
    }
    return { id: id.trim(), displayName: displayName.trim() };
  });
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error("Hermes bridge numeric configuration is invalid.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Hermes bridge numeric configuration is out of bounds.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
