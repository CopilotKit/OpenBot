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
 *
 * What the install should run is signed the same way. Every reply carries, among its commands, one
 * signed desired state (`SignedDesiredState`, kind `desired-state`): the version to move to with its
 * release manifest and chart digests, the maintenance window and whether upgrades are paused, all
 * under one signature, for one install, with an expiry and a counter that only goes up for that
 * install. The signature covers every field but the release manifest's text, which is bound by its
 * signed SHA-256 (`releaseManifestSha256`) instead, so what is signed stays a few hundred bytes
 * however long the manifest grows (`canonicalDesiredState`). The agent acts on it only when it
 * verifies, the manifest's bytes match the signed digest, it names the agent's own install, has not
 * expired, and its counter is not below the last one the agent accepted (`readDesiredState`). The
 * reply's own `desired`, `window` and `paused` fields are unsigned: they stay for agents that read
 * them, and an agent that reads the signed desired state ignores them.
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

/** Whether an install's agent can upgrade it: what the heartbeat and the install status report. */
export const UPGRADES = ["on", "not-set-up"] as const;
export type Upgrades = (typeof UPGRADES)[number];

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
  /**
   * Whether the agent can upgrade the install: `on`, or `not-set-up` when it is connected but its
   * upgrade machinery isn't (for example no backup target yet). Optional: older agents leave it out.
   */
  upgrades: z.enum(UPGRADES).optional(),
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

/** The kind a signed desired state carries among a reply's commands. Not a command kind: it is never
 * queued, run or answered with a result. */
export const DESIRED_STATE_KIND = "desired-state";
/** How long a signed desired state is good for after it is signed. A reply replayed later than this
 * is refused, so withholding newer ones freezes an install for an hour at most. */
export const DESIRED_STATE_TTL_SECONDS = 3600;

/**
 * What the install should run, signed by the service with the command key. One signature covers the
 * desired release (version, manifest, chart digests), the window and the pause together, so no part
 * of one can be paired with another's.
 */
export const SignedDesiredState = z.strictObject({
  kind: z.literal(DESIRED_STATE_KIND),
  /** The install it is for. An agent refuses one signed for any other install. */
  installId: z.uuid(),
  /**
   * Higher every time the service signs a new one for this install. An agent refuses one below the
   * last it accepted, and one equal to it unless it is that same signed desired state again.
   */
  counter: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  issuedAt: isoTime,
  expiresAt: isoTime,
  desired: DesiredState.nullable(),
  window: MaintenanceWindow,
  paused: z.boolean(),
  /** Base64 Ed25519 signature over `canonicalDesiredState(this)`: every field but the signature and
   * the release manifest's text, which `desired.releaseManifestSha256` binds. */
  signature: z.base64(),
});
export type SignedDesiredState = z.infer<typeof SignedDesiredState>;
export type UnsignedDesiredState = Omit<SignedDesiredState, "signature">;

export const HeartbeatReply = z.strictObject({
  /** Unsigned, for agents from before the signed desired state. Newer agents ignore it. */
  desired: DesiredState.nullable(),
  /** Unsigned, as `desired`. */
  window: MaintenanceWindow,
  /** Unsigned, as `desired`. */
  paused: z.boolean(),
  /** Signed commands, and the one signed desired state (an agent from before it ignores it, as it
   * ignores any kind it does not know). */
  commands: z.array(z.union([Command, SignedDesiredState])).max(32),
});
export type HeartbeatReply = z.infer<typeof HeartbeatReply>;

export const CommandResult = z.strictObject({
  commandId: Command.shape.id,
  ok: z.boolean(),
  reason: z.string().max(2048),
  finishedAt: isoTime,
});
export type CommandResult = z.infer<typeof CommandResult>;

/** The exact bytes a signature covers: RFC 8785 JSON of the object without its `signature`. */
export function canonicalSigned(value: object): string {
  const { signature: _signature, ...unsigned } = value as {
    signature?: unknown;
  };
  const result = canonicalize(unsigned);
  if (result === undefined) throw new Error("Value cannot be canonicalized");
  return result;
}

/** The exact bytes a command's signature covers: RFC 8785 JSON of the command without `signature`. */
export function canonicalCommand(command: UnsignedCommand | Command): string {
  return canonicalSigned(command);
}

/**
 * The most bytes a signed message may have. The service signs with a key in AWS KMS, whose Ed25519
 * signing takes a raw message of at most 4096 bytes; a longer one is refused there. Pure Ed25519 is
 * kept (not Ed25519ph, KMS's path for longer messages) because the agent verifies with WebCrypto,
 * which has no Ed25519ph.
 * https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
 */
export const SIGNED_MESSAGE_MAX_BYTES = 4096;

/**
 * The exact bytes a desired state's signature covers: RFC 8785 JSON of it without its `signature`
 * and without `desired.releaseManifest`. The manifest's text is bound by `releaseManifestSha256`,
 * which is signed, and the agent refuses a manifest whose bytes don't hash to it; leaving the text
 * out keeps what is signed small however long the manifest grows.
 */
export function canonicalDesiredState(
  value: UnsignedDesiredState | SignedDesiredState,
): string {
  const { signature: _signature, ...unsigned } = value as SignedDesiredState;
  if (!unsigned.desired) return canonicalSigned(unsigned);
  const { releaseManifest: _manifest, ...desired } = unsigned.desired;
  return canonicalSigned({ ...unsigned, desired });
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

/** Whether `signatureBase64` is a valid Ed25519 signature by `publicKey` over `message`. */
async function verifySigned(
  signatureBase64: string,
  message: string,
  publicKey: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64(signatureBase64);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  return crypto.subtle.verify(
    { name: "Ed25519" },
    await verifyKey(publicKey),
    signature as BufferSource,
    new TextEncoder().encode(message) as BufferSource,
  );
}

/** The UTF-8 bytes of a message to sign, refused when longer than the signer takes. */
export function signedMessageBytes(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > SIGNED_MESSAGE_MAX_BYTES)
    throw new Error(
      `the message to sign is ${bytes.length} bytes, over the ${SIGNED_MESSAGE_MAX_BYTES} a signer takes`,
    );
  return bytes;
}

async function signed(message: string, privateKey: CryptoKey) {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      signedMessageBytes(message) as BufferSource,
    ),
  );
  return toBase64(signature);
}

/** Whether `command.signature` is a valid Ed25519 signature by `publicKey` over its canonical JSON. */
export function verifyCommandSignature(
  command: Command,
  publicKey: string,
): Promise<boolean> {
  return verifySigned(command.signature, canonicalCommand(command), publicKey);
}

/** Signs a command: what the management service does before it puts one in a reply. */
export async function signCommand(
  command: UnsignedCommand,
  privateKey: CryptoKey,
): Promise<Command> {
  return {
    ...command,
    signature: await signed(canonicalCommand(command), privateKey),
  };
}

/** Signs a desired state with the command key: what the service puts in every reply. */
export async function signDesiredState(
  desired: UnsignedDesiredState,
  privateKey: CryptoKey,
): Promise<SignedDesiredState> {
  return {
    ...desired,
    signature: await signed(canonicalDesiredState(desired), privateKey),
  };
}

/** The last signed desired state an agent accepted, as it keeps it across restarts. */
export interface AcceptedDesiredState {
  installId: string;
  counter: number;
  signature: string;
}

export type DesiredStateReading =
  | {
      ok: true;
      signed: SignedDesiredState;
      /** Its counter is above the last one accepted: keep it as the new last one. */
      newer: boolean;
    }
  | { ok: false; reason: string };

/**
 * The signed desired state in a reply's commands, as the agent may act on it. Refused, with why:
 * none in the reply, or more than one; malformed; a signature that does not verify with `publicKey`;
 * a release manifest whose bytes don't hash to the signed `releaseManifestSha256`; signed for another
 * install; expired; issued in the future; or a counter below the last one
 * accepted for this install (`last`), or equal to it without being that same signed desired state
 * (a replay). An equal counter with the same signature is the one already accepted, sent again.
 *
 * These are The Update Framework's checks for timestamp metadata, applied to one install:
 * a signature by a key the agent already holds, a version that never goes back (rollback), an
 * expiry (freeze), and everything signed together (mix-and-match).
 * https://theupdateframework.github.io/specification/latest/#update-timestamp
 */
export async function readDesiredState(
  commands: unknown[],
  options: {
    publicKey: string;
    installId: string;
    last: AcceptedDesiredState | null;
    now?: Date;
  },
): Promise<DesiredStateReading> {
  const now = options.now ?? new Date();
  const found = commands.filter(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === DESIRED_STATE_KIND,
  );
  if (found.length === 0)
    return { ok: false, reason: "the reply carries no signed desired state" };
  if (found.length > 1)
    return {
      ok: false,
      reason: "the reply carries more than one signed desired state",
    };
  const parsed = SignedDesiredState.safeParse(found[0]);
  if (!parsed.success)
    return { ok: false, reason: "malformed signed desired state" };
  const signed = parsed.data;
  if (
    !(await verifySigned(
      signed.signature,
      canonicalDesiredState(signed),
      options.publicKey,
    ))
  )
    return { ok: false, reason: "signature does not verify" };
  // The signature covers the manifest's digest, not its text: text that doesn't hash to the signed
  // digest is refused here, before anything reads it.
  if (
    signed.desired &&
    (await releaseManifestDigest(signed.desired.releaseManifest)) !==
      signed.desired.releaseManifestSha256
  )
    return {
      ok: false,
      reason: "the release manifest does not match its signed digest",
    };
  if (signed.installId !== options.installId)
    return {
      ok: false,
      reason: `signed for another install (${signed.installId})`,
    };
  if (Date.parse(signed.expiresAt) <= now.getTime())
    return { ok: false, reason: `expired at ${signed.expiresAt}` };
  if (
    Date.parse(signed.issuedAt) >
    now.getTime() + COMMAND_CLOCK_SKEW_SECONDS * 1000
  )
    return { ok: false, reason: "issued in the future" };
  const last =
    options.last?.installId === options.installId ? options.last : null;
  if (last && signed.counter < last.counter)
    return {
      ok: false,
      reason: `replayed: counter ${signed.counter} is below ${last.counter}, the last one accepted`,
    };
  if (last && signed.counter === last.counter) {
    if (signed.signature !== last.signature)
      return {
        ok: false,
        reason: `replayed: counter ${signed.counter} was already accepted for another desired state`,
      };
    return { ok: true, signed, newer: false };
  }
  return { ok: true, signed, newer: true };
}

export type IgnoredCommand = { id: string | null; reason: string };

/**
 * The commands in a reply the agent may run: those that parse, are signed by `publicKey`, were not
 * issued in the future and have not expired. Every other one is returned with why it was ignored,
 * so one bad command never hides the rest. The signed desired state is left to `readDesiredState`.
 */
export async function readCommands(
  commands: unknown[],
  publicKey: string,
  now: Date = new Date(),
): Promise<{ accepted: Command[]; ignored: IgnoredCommand[] }> {
  const accepted: Command[] = [];
  const ignored: IgnoredCommand[] = [];
  for (const value of commands) {
    // The signed desired state rides among the commands; `readDesiredState` reads it.
    if (
      value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === DESIRED_STATE_KIND
    )
      continue;
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

/*
 * Self-serve enrollment. An admin connects a self-hosted team install from OpenBot's admin screen,
 * with no secret copied by hand: OpenBot starts an enrollment with its licence (the OAuth device
 * authorization grant, RFC 8628), the admin approves it on CopilotKit's enrollment page signed in
 * with their CopilotKit organization, and OpenBot collects a one-time enrollment token. The agent
 * then takes that token from OpenBot's internal status port, proving who it is with a projected
 * service account token, makes its own key, and trades the token and a certificate request for the
 * install's client certificate. The private key never leaves the agent's cluster.
 *
 * Enrollment calls go to their own host, without client certificates (the fleet host refuses any
 * TLS handshake without one), and errors other than the token poll's are application/problem+json
 * (RFC 9457):
 *
 *   POST /enroll/v1/requests                         EnrollmentStart           -> 201 EnrollmentStarted
 *   POST /enroll/v1/requests/{requestId}/token       (no body)                 -> 200 EnrollmentGranted | 400 EnrollmentPending
 *   POST /enroll/v1/approvals                        EnrollmentApproval        -> 200 EnrollmentPreview   (Clerk session JWT)
 *   POST /enroll/v1/approvals/{userCode}/confirm     (no body)                 -> 204                    (Clerk session JWT)
 *   POST /enroll/v1/certificates                     CertificateRequest        -> 201 CertificateIssued
 *   GET  /enroll/v1/installs/{installId}/status      (Bearer enrollment or status token) -> InstallStatus
 *
 * And on OpenBot's internal status port, for the agent alone:
 *
 *   GET /management/enrollment-token   Bearer <projected token, audience ENROLLMENT_TOKEN_AUDIENCE>
 *                                      -> 200 AgentEnrollmentToken once, then 410
 */

/** Where CopilotKit's enrollment API and page answer. */
export const ENROLLMENT_URL = "https://enroll.bot.copilotkit.ai";
export const ENROLLMENT_REQUESTS_PATH = "/enroll/v1/requests";
export const enrollmentTokenPath = (requestId: string) =>
  `/enroll/v1/requests/${encodeURIComponent(requestId)}/token`;
export const ENROLLMENT_APPROVALS_PATH = "/enroll/v1/approvals";
export const enrollmentConfirmPath = (userCode: string) =>
  `/enroll/v1/approvals/${encodeURIComponent(userCode)}/confirm`;
export const ENROLLMENT_CERTIFICATES_PATH = "/enroll/v1/certificates";
export const installStatusPath = (installId: string) =>
  `/enroll/v1/installs/${encodeURIComponent(installId)}/status`;
/** The page an admin approves on. */
export const ENROLLMENT_VERIFICATION_PATH = "/connect";

/** On OpenBot's internal status port: where the agent collects the enrollment token. */
export const AGENT_ENROLLMENT_TOKEN_PATH = "/management/enrollment-token";
/** The audience of the projected service account token the agent proves itself with. */
export const ENROLLMENT_TOKEN_AUDIENCE = "openbot-management-enrollment";
/** The only service account OpenBot hands the enrollment token to, as `namespace:name`. */
export const AGENT_SERVICE_ACCOUNT = "openbot-system:openbot-agent";

/** The subject an install's client certificate carries, and so the subject of the agent's request. */
export function installCertificateSubject(installId: string) {
  return `CN=${installId}, OU=install, O=CopilotKit`;
}

/** RFC 8628's user code: eight characters a person can read out, as XXXX-XXXX. */
export const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const userCode = z.string().regex(USER_CODE_PATTERN);
/** An opaque bearer secret (enrollment or status token): URL-safe characters only. */
const bearerSecret = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const pem = (label: string) =>
  z
    .string()
    .max(64 * 1024)
    .regex(
      new RegExp(
        `^\\s*-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ${label}-----\\s*$`,
      ),
    );
/** One or more PEM certificates, one after another. */
const certificates = z
  .string()
  .max(64 * 1024)
  .regex(
    /^\s*(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/,
  );

/**
 * How an enrollment is approved. `approval`: an admin approves the code on the enrollment page (the
 * admin screen's Connect). `licence`: the licence approves it at once, when it is a valid team licence
 * and its organization isn't blocked, so a team install connects by default with no step.
 */
export const ENROLLMENT_MODES = ["approval", "licence"] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

/**
 * The `code` an enrollment refusal (EnrollmentProblem) carries, for the server to report:
 * invalid-licence (401), not-team (403: not a team licence, or a demo licence), blocked (403: CopilotKit
 * turned managed updates off for the organization), not-entitled (403: the same, on the approval page),
 * already-enrolled (409, with `installId`: a live install already exists for this licence's organization
 * and server address).
 */
export const ENROLLMENT_REFUSAL_CODES = [
  "invalid-licence",
  "not-team",
  "blocked",
  "not-entitled",
  "already-enrolled",
] as const;
export type EnrollmentRefusalCode = (typeof ENROLLMENT_REFUSAL_CODES)[number];

/** 1. OpenBot starts an enrollment with its CopilotKit licence. */
export const EnrollmentStart = z.strictObject({
  /** The install's CopilotKit licence token, verified offline by the service. */
  licenseToken: z
    .string()
    .min(1)
    .max(16 * 1024),
  /** What the admin calls this install, shown on the approval page. */
  installName: z.string().trim().min(1).max(128),
  /** OpenBot's own address, shown on the approval page so the admin knows what they approve. */
  serverUrl: httpUrl,
  /** Who approves it; `approval` when left out. */
  mode: z.enum(ENROLLMENT_MODES).optional(),
  /**
   * This install's own id: a UUID the server makes once, keeps in its database and sends on every
   * start, the same value across restarts and upgrades. The service allows one live install per
   * organization and instanceId, so two installs under one licence never collide even when they
   * share an address (the chart's default in-cluster one). Left out by older servers: then the
   * service keys on the organization and serverUrl.
   */
  instanceId: z.uuid().optional(),
});
export type EnrollmentStart = z.infer<typeof EnrollmentStart>;

export const EnrollmentStarted = z.strictObject({
  requestId: z.uuid(),
  userCode,
  verificationUri: httpUrl,
  verificationUriComplete: httpUrl,
  /** Seconds between token polls. */
  interval: z.number().int().min(1).max(60),
  /** Seconds until the request expires unapproved. */
  expiresIn: z.number().int().min(1),
});
export type EnrollmentStarted = z.infer<typeof EnrollmentStarted>;

/** 2. The token poll's answers, with RFC 8628 section 3.5 semantics. */
export const ENROLLMENT_PENDING_ERRORS = [
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
] as const;
export const EnrollmentPending = z.strictObject({
  error: z.enum(ENROLLMENT_PENDING_ERRORS),
  error_description: z.string().max(512).optional(),
});
export type EnrollmentPending = z.infer<typeof EnrollmentPending>;

/** Answered once; the request is then spent. */
export const EnrollmentGranted = z.strictObject({
  installId: z.uuid(),
  /** One use, for the agent's certificate request. */
  enrollmentToken: bearerSecret,
  /** For OpenBot's screen to read the install's status after the enrollment token is spent. */
  statusToken: bearerSecret,
  /** Seconds the enrollment token is good for. */
  expiresIn: z.number().int().min(1),
});
export type EnrollmentGranted = z.infer<typeof EnrollmentGranted>;

/** 3. The admin approves on the page (or a future CopilotKit cloud screen) by the code. */
export const EnrollmentApproval = z.strictObject({ userCode });
export type EnrollmentApproval = z.infer<typeof EnrollmentApproval>;

export const EnrollmentPreview = z.strictObject({
  installName: EnrollmentStart.shape.installName,
  serverUrl: httpUrl,
});
export type EnrollmentPreview = z.infer<typeof EnrollmentPreview>;

/**
 * 4. The agent trades the enrollment token and a PKCS#10 request for its certificate. The request's
 * key is the agent's own, and its subject is `installCertificateSubject(installId)`; the service
 * refuses any other subject. One use per token.
 */
export const CertificateRequest = z.strictObject({
  enrollmentToken: bearerSecret,
  csrPem: pem("CERTIFICATE REQUEST"),
});
export type CertificateRequest = z.infer<typeof CertificateRequest>;

export const CertificateIssued = z.strictObject({
  installId: z.uuid(),
  /** The install's client certificate alone, PEM. */
  certificatePem: pem("CERTIFICATE"),
  /** The CA chain that issued it, PEM. Not what the agent trusts for the service's own certificate. */
  caChainPem: certificates,
});
export type CertificateIssued = z.infer<typeof CertificateIssued>;

/** 5. What OpenBot's screen shows once the admin has run the helm command. */
export const InstallStatus = z.strictObject({
  enrolled: z.boolean(),
  agentConnected: z.boolean(),
  lastHeartbeatAt: isoTime.nullable(),
  agentVersion: text.nullable(),
  /**
   * The install's current maintenance window (the service's default unless an operator set one).
   * The service always sends it; optional so a server reads a service from before it was added.
   */
  window: MaintenanceWindow.optional(),
  /** The last heartbeat's `upgrades`, when the agent sends it. */
  upgrades: z.enum(UPGRADES).optional(),
});
export type InstallStatus = z.infer<typeof InstallStatus>;

/** OpenBot's internal status port to the agent: the token OpenBot collected, once. */
export const AgentEnrollmentToken = z.strictObject({
  installId: z.uuid(),
  enrollmentToken: bearerSecret,
});
export type AgentEnrollmentToken = z.infer<typeof AgentEnrollmentToken>;

/** An enrollment error body (RFC 9457). Members beyond these are allowed, as the RFC allows. */
export const EnrollmentProblem = z.looseObject({
  type: z.string().max(2048),
  title: z.string().max(512),
  status: z.number().int().min(400).max(599),
  detail: z.string().max(2048).optional(),
});
export type EnrollmentProblem = z.infer<typeof EnrollmentProblem>;
