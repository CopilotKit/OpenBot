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
