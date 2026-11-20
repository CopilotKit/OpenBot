/**
 * The wire contract between the OpenBot management agent, which runs in a customer's cluster only
 * when its owner installs the `openbot-agent` chart, and CopilotKit's management service. Both
 * sides import these schemas, so what crosses the wire is defined once and readable here by the
 * customer's security team.
 *
 * Every call is started by the agent, over HTTPS with a client certificate per install:
 *
 *   POST /v1/heartbeat                      body Heartbeat      answer HeartbeatReply
 *   POST /v1/commands/{commandId}/result    body CommandResult  answer 204
 *
 * Every object is strict: a field this file does not name is refused (the service answers 400),
 * so nothing outside the list can ride along in a heartbeat.
 *
 * Commands are signed as well as delivered over mutual TLS. The service signs each one with
 * Ed25519 over the canonical JSON (RFC 8785) of the command without its `signature`; the agent
 * runs a command only when that signature verifies against the public key in its chart values,
 * the command has not expired, and its kind is one it knows (`readCommands`).
 */
import canonicalize from "canonicalize";
import { z } from "zod";

export const HEARTBEAT_PATH = "/v1/heartbeat";
export const commandResultPath = (commandId: string) =>
  `/v1/commands/${encodeURIComponent(commandId)}/result`;
/** How often the agent sends a heartbeat. It adds up to 10% jitter. */
export const HEARTBEAT_INTERVAL_SECONDS = 60;
/** The shortest maintenance window the service may send. */
export const SHORTEST_WINDOW_HOURS = 4;
/** How far a command's `issuedAt` may be ahead of the agent's clock and still be run. */
export const COMMAND_CLOCK_SKEW_SECONDS = 300;

const text = z.string().min(1).max(512);
const isoTime = z.iso.datetime({ offset: true });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const ociDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const CLOUDS = ["aws", "azure", "gcp", "other"] as const;
export type Cloud = (typeof CLOUDS)[number];

export const UPGRADE_STATES = [
  "idle",
  "waiting-window",
  "backing-up",
  "upgrading",
  "verifying",
  "recovery-required",
  "paused",
] as const;
export type UpgradeState = (typeof UPGRADE_STATES)[number];

export const COMMAND_KINDS = [
  "restart",
  "rollback",
  "support-bundle",
  "pause",
  "resume",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** What the agent says when a rollback is asked of a release whose policy needs a restore. */
export const ROLLBACK_REFUSED_REASON = "policy: restore-backup needs a person";

export const Heartbeat = z.strictObject({
  /** The install's id; the service holds it equal to the client certificate's CN. */
  installId: z.uuid(),
  agentVersion: text,
  cloud: z.enum(CLOUDS),
  openbot: z.strictObject({
    version: text,
    chartVersion: text,
    /** Workload or container name to its running image digest. */
    imageDigests: z.record(z.string().min(1).max(253), ociDigest),
  }),
  intelligence: z.strictObject({ chartVersion: text }),
  /** The last migration the server applied, as /release reports it. */
  lastAppliedMigration: text.nullable(),
  flux: z.strictObject({
    helmReleases: z
      .array(
        z.strictObject({
          name: text,
          ready: z.boolean(),
          reason: z.string().max(512),
          message: z.string().max(2048),
          lastAppliedRevision: z.string().max(512),
        }),
      )
      .max(16),
  }),
  pods: z
    .array(
      z.strictObject({
        workload: text,
        ready: z.number().int().min(0),
        desired: z.number().int().min(0),
      }),
    )
    .max(64),
  upgrade: z.strictObject({
    state: z.enum(UPGRADE_STATES),
    targetVersion: text.nullable(),
    /** One line on the current or last operation, never a log line. */
    journal: z.string().max(2048).nullable(),
  }),
  sentAt: isoTime,
});
export type Heartbeat = z.infer<typeof Heartbeat>;

const ChartRef = z.strictObject({
  /** Where Flux pulls the chart from, as `oci://registry/path/name` without a tag. */
  ref: z.string().regex(/^oci:\/\/[^\s@]+$/),
  /** The exact manifest digest Flux is pinned to. */
  digest: ociDigest,
});

export const DesiredState = z.strictObject({
  version: text,
  releaseManifestSha256: sha256Hex,
  /**
   * The release manifest (release-manifest.json) exactly as published. Its SHA-256 must equal
   * `releaseManifestSha256`; the agent reads the upgrade policy (upgrade paths, recovery, database
   * transition) from it.
   */
  releaseManifest: z
    .string()
    .min(2)
    .max(256 * 1024),
  charts: z.strictObject({ openbot: ChartRef, bundle: ChartRef }),
});
export type DesiredState = z.infer<typeof DesiredState>;

export const MaintenanceWindow = z.strictObject({
  /** 0 is Sunday. */
  weekday: z.number().int().min(0).max(6),
  startUtc: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  hours: z.number().min(SHORTEST_WINDOW_HOURS).max(168),
});
export type MaintenanceWindow = z.infer<typeof MaintenanceWindow>;

/** A JSON value, so a command's arguments canonicalize the same on both sides. */
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const Command = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  kind: z.enum(COMMAND_KINDS),
  args: z.record(z.string(), JsonValue),
  issuedAt: isoTime,
  expiresAt: isoTime,
  /** Base64 Ed25519 signature over `canonicalCommand(command)`. */
  signature: z.base64(),
});
export type Command = z.infer<typeof Command>;
export type UnsignedCommand = Omit<Command, "signature">;

export const HeartbeatReply = z.strictObject({
  desired: DesiredState.nullable(),
  window: MaintenanceWindow,
  paused: z.boolean(),
  commands: z.array(Command).max(32),
});
export type HeartbeatReply = z.infer<typeof HeartbeatReply>;

export const CommandResult = z.strictObject({
  commandId: Command.shape.id,
  ok: z.boolean(),
  reason: z.string().max(2048),
  finishedAt: isoTime,
});
export type CommandResult = z.infer<typeof CommandResult>;

/** The exact bytes a command's signature covers: RFC 8785 JSON of the command without `signature`. */
export function canonicalCommand(command: UnsignedCommand | Command): string {
  const { signature: _signature, ...unsigned } = command as Command;
  const result = canonicalize(unsigned);
  if (result === undefined) throw new Error("Command cannot be canonicalized");
  return result;
}

/** Ed25519 public keys and signatures travel as base64: a key is its raw 32 bytes. */
export function fromBase64(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  return bytes;
}
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function verifyKey(publicKey: string) {
  const raw = fromBase64(publicKey);
  if (raw.length !== 32)
    throw new Error("Command public key must be 32 raw bytes in base64");
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/** Whether `command.signature` is a valid Ed25519 signature by `publicKey` over its canonical JSON. */
export async function verifyCommandSignature(
  command: Command,
  publicKey: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64(command.signature);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  return crypto.subtle.verify(
    { name: "Ed25519" },
    await verifyKey(publicKey),
    signature as BufferSource,
    new TextEncoder().encode(canonicalCommand(command)) as BufferSource,
  );
}

/** Signs a command: what the management service does before it puts one in a reply. */
export async function signCommand(
  command: UnsignedCommand,
  privateKey: CryptoKey,
): Promise<Command> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(canonicalCommand(command)) as BufferSource,
    ),
  );
  return { ...command, signature: toBase64(signature) };
}

export type IgnoredCommand = { id: string | null; reason: string };

/**
 * The commands in a reply the agent may run: those that parse, are signed by `publicKey`, were not
 * issued in the future and have not expired. Every other one is returned with why it was ignored,
 * so one bad command never hides the rest.
 */
export async function readCommands(
  commands: unknown[],
  publicKey: string,
  now: Date = new Date(),
): Promise<{ accepted: Command[]; ignored: IgnoredCommand[] }> {
  const accepted: Command[] = [];
  const ignored: IgnoredCommand[] = [];
  for (const value of commands) {
    const id =
      value && typeof value === "object" && "id" in value
        ? String((value as { id: unknown }).id)
        : null;
    const parsed = Command.safeParse(value);
    if (!parsed.success) {
      const unknownKind =
        value &&
        typeof value === "object" &&
        "kind" in value &&
        !COMMAND_KINDS.includes((value as { kind: CommandKind }).kind);
      ignored.push({
        id,
        reason: unknownKind ? "unknown command kind" : "malformed command",
      });
      continue;
    }
    const command = parsed.data;
    if (!(await verifyCommandSignature(command, publicKey))) {
      ignored.push({ id, reason: "signature does not verify" });
      continue;
    }
    if (Date.parse(command.expiresAt) <= now.getTime()) {
      ignored.push({ id, reason: "expired" });
      continue;
    }
    if (
      Date.parse(command.issuedAt) >
      now.getTime() + COMMAND_CLOCK_SKEW_SECONDS * 1000
    ) {
      ignored.push({ id, reason: "issued in the future" });
      continue;
    }
    accepted.push(command);
  }
  return { accepted, ignored };
}

/**
 * A reply as the agent reads it: everything but the commands strictly, then each command on its
 * own through `readCommands`, so an unknown kind the service learns later is ignored rather than
 * failing the whole reply.
 */
export const HeartbeatReplyWire = HeartbeatReply.extend({
  commands: z.array(z.unknown()).max(32),
});

/** SHA-256 of the release manifest's exact bytes, as `releaseManifestSha256` names it. */
export async function releaseManifestDigest(manifest: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(manifest) as BufferSource,
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
