import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HandoffRequest } from "../../shared/computer-control";
import { isPlainBotId } from "./bot-id";

export type StoredControl = {
  version: 1;
  holder: "bot" | "human";
  since: string;
  resumeSnapshotRequired: boolean;
  recoveryRequired: boolean;
  currentRequestId?: string;
  requests: HandoffRequest[];
  aliases: Record<string, string>;
};
export type ControlStore = {
  load(): StoredControl | undefined;
  save(state: StoredControl): void;
};
const statuses = new Set([
  "waiting",
  "taken",
  "completed",
  "cancelled",
  "expired",
  "interrupted",
]);
const sources = new Set(["model", "manual", "cloudflare", "visible-challenge"]);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

function validRequest(v: unknown): v is HandoffRequest {
  return (
    record(v) &&
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 200 &&
    typeof v.reason === "string" &&
    v.reason.length <= 500 &&
    typeof v.source === "string" &&
    sources.has(v.source) &&
    typeof v.status === "string" &&
    statuses.has(v.status) &&
    timestamp(v.createdAt) &&
    timestamp(v.updatedAt) &&
    (v.toolCallId === undefined ||
      (typeof v.toolCallId === "string" && v.toolCallId.length <= 200)) &&
    (v.expiresAt === undefined || timestamp(v.expiresAt)) &&
    (v.finishedAt === undefined || timestamp(v.finishedAt)) &&
    (v.interruption === undefined || typeof v.interruption === "string") &&
    (v.status !== "waiting" || timestamp(v.expiresAt)) &&
    (v.status === "waiting" || v.expiresAt === undefined) &&
    (v.status === "waiting" || v.status === "taken"
      ? v.finishedAt === undefined
      : timestamp(v.finishedAt))
  );
}

function validate(value: unknown): StoredControl {
  if (
    !record(value) ||
    value.version !== 1 ||
    !["bot", "human"].includes(String(value.holder)) ||
    !timestamp(value.since) ||
    typeof value.resumeSnapshotRequired !== "boolean" ||
    typeof value.recoveryRequired !== "boolean" ||
    !Array.isArray(value.requests) ||
    value.requests.length > 33 ||
    !value.requests.every(validRequest) ||
    !record(value.aliases) ||
    Object.keys(value.aliases).length > 256 ||
    (value.currentRequestId !== undefined &&
      typeof value.currentRequestId !== "string")
  )
    throw new Error("Corrupt computer control state.");
  const ids = new Set(value.requests.map((r) => r.id));
  if (
    ids.size !== value.requests.length ||
    (value.currentRequestId !== undefined &&
      !ids.has(value.currentRequestId)) ||
    Object.entries(value.aliases).some(
      ([key, id]) => key.length > 200 || typeof id !== "string" || !ids.has(id),
    )
  )
    throw new Error("Corrupt computer control request history.");
  const current = value.requests.find((r) => r.id === value.currentRequestId);
  if (
    (current?.status === "taken" && value.holder !== "human") ||
    (value.requests.length > 0 && !current) ||
    (value.holder === "human" &&
      current?.status !== "taken" &&
      current?.status !== "cancelled") ||
    value.requests.some(
      (r) =>
        (r.status === "waiting" || r.status === "taken") &&
        r.id !== value.currentRequestId,
    )
  )
    throw new Error("Corrupt computer control ownership.");
  return value as StoredControl;
}

/** Atomic replacement outside Chromium's profile. Never salvage corrupt data as success. */
export function createControlStore(
  profilesDirectory: string,
  botId: string,
): ControlStore {
  if (!isPlainBotId(botId)) throw new Error("That is not a usable bot id.");
  const directory = join(profilesDirectory, ".control");
  const path = join(directory, `${botId}.json`);
  return {
    load() {
      if (!existsSync(path)) return undefined;
      const contents = readFileSync(path, "utf8");
      if (contents.length > 256_000)
        throw new Error("Computer control state exceeds its size limit.");
      return validate(JSON.parse(contents));
    },
    save(state) {
      validate(state);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(state));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, path);
      } finally {
        // A write or rename that fails must not leave the copy behind; after a rename it is gone.
        rmSync(temporary, { force: true });
      }
    },
  };
}
