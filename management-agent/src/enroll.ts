/**
 * Self-serve enrollment: an agent installed with only `enrollment.serverUrl` gets its own client
 * certificate, with no secret copied by hand.
 *
 *  1. It asks OpenBot's internal status port for the one-time enrollment token OpenBot collected
 *     when an admin connected the install, proving it is this agent with a projected service account
 *     token (audience `ENROLLMENT_TOKEN_AUDIENCE`) that OpenBot checks against the cluster's keys.
 *  2. It makes its own P-256 key, in memory, and sends CopilotKit's enrollment API only a certificate
 *     request with the token. The private key never leaves the cluster.
 *  3. It writes the certificate and key to its own Secret (the chart grants it that one Secret by
 *     name), then runs as an agent installed with a certificate does. On a restart it reads the
 *     Secret and never enrolls again.
 *
 * The token is kept in the same Secret between 1 and 2, so a restart in between, or the enrollment
 * API being down for a while, does not spend it: OpenBot hands it out once.
 *
 * Nothing secret is logged: not the projected token, the enrollment token, the key or the
 * certificate. Logs carry status codes and the problem title a service answered.
 */
// @peculiar/x509 resolves its ASN.1 types through tsyringe, which needs the Reflect metadata API.
import "reflect-metadata";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import * as x509 from "@peculiar/x509";
import {
  AGENT_ENROLLMENT_TOKEN_PATH,
  AgentEnrollmentToken,
  CertificateIssued,
  ENROLLMENT_CERTIFICATES_PATH,
  installCertificateSubject,
} from "../../shared/management-contract";
import type {
  Agent,
  Credentials,
  EnrollmentConfig,
  ReadyAgent,
} from "./config";
import { CommandFailed, type Kube } from "./kube";

type Log = (message: string, fields?: Record<string, unknown>) => void;

const EC = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** Keys of the agent's own Secret. */
export const SECRET_KEYS = {
  cert: "tls.crt",
  key: "tls.key",
  ca: "ca.crt",
  pendingToken: "enrollment-token",
  pendingInstall: "install-id",
} as const;

/** The agent's own Secret, read and written through the Kubernetes API. */
export interface SecretStore {
  /** The Secret's data as text, or null when there is no such Secret. */
  read(): Promise<Record<string, string> | null>;
  /** Sets exactly these keys as the agent's own (keys it set before and leaves out are removed). */
  write(data: Record<string, string>): Promise<void>;
}

export class KubeSecretStore implements SecretStore {
  constructor(
    private readonly kube: Kube,
    private readonly namespace: string,
    private readonly name: string,
  ) {}

  async read() {
    const secret = await this.kube.get<{ data?: Record<string, string> }>(
      this.namespace,
      "secrets",
      this.name,
    );
    if (!secret) return null;
    return Object.fromEntries(
      Object.entries(secret.data ?? {}).map(([key, value]) => [
        key,
        Buffer.from(value, "base64").toString("utf8"),
      ]),
    );
  }

  /**
   * Server-side apply, so the one request creates or updates the Secret by name: the chart grants
   * create, update and patch on this name alone. The data goes on stdin, never in an argument.
   */
  async write(data: Record<string, string>) {
    await this.kube.apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: this.name,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/name": "openbot-agent",
          "app.kubernetes.io/part-of": "openbot",
          "app.kubernetes.io/component": "credentials",
        },
      },
      type: "Opaque",
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    });
  }
}

function pem(label: string, der: ArrayBuffer) {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A fresh P-256 key and a certificate request for the install, made in this process. */
export async function keyAndRequest(installId: string) {
  const keys = (await crypto.subtle.generateKey(EC, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name: installCertificateSubject(installId),
    keys,
    signingAlgorithm: EC,
  });
  return {
    csrPem: request.toString("pem"),
    keyPem: pem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
  };
}

export class EnrollmentRefused extends Error {}

/**
 * The install id a certificate names, once it is checked to be an install certificate for `key`:
 * its CN is a UUID, its OU is `install`, and its public key is the key's.
 */
export function checkCredentials(cert: string, key: string): string {
  let certificate: x509.X509Certificate;
  try {
    certificate = new x509.X509Certificate(cert);
  } catch {
    throw new EnrollmentRefused("the certificate is not a PEM certificate");
  }
  const name = certificate.subjectName;
  const installId = name.getField("CN")[0] ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      installId,
    )
  )
    throw new EnrollmentRefused("the certificate's CN is not an install id");
  const ou = name.getField("OU");
  if (ou.length > 0 && !ou.includes("install"))
    throw new EnrollmentRefused("the certificate is not an install's");
  let ours: Buffer;
  try {
    ours = createPublicKey(createPrivateKey(key)).export({
      type: "spki",
      format: "der",
    });
  } catch {
    throw new EnrollmentRefused("the key is not a PEM private key");
  }
  if (!ours.equals(Buffer.from(certificate.publicKey.rawData)))
    throw new EnrollmentRefused("the certificate is not for this key");
  return installId.toLowerCase();
}

async function problem(response: Response) {
  // A problem's title and detail only; never a body that could hold a token.
  try {
    const body = (await response.json()) as {
      title?: unknown;
      detail?: unknown;
    };
    return [body.title, body.detail]
      .filter((part) => typeof part === "string")
      .join(": ")
      .slice(0, 300);
  } catch {
    return "";
  }
}

export interface EnrollOptions {
  log: Log;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** How long to wait between attempts that found nothing to do yet. */
  retryMs?: number;
  timeoutMs?: number;
}

type Step =
  | { kind: "ready"; credentials: Credentials; installId: string }
  | { kind: "wait"; reason: string; fields?: Record<string, unknown> };

export class Enrollment {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  /** Logged once per distinct reason, so a long wait is one line, not one a minute. */
  private lastReason: string | null = null;

  constructor(
    private readonly config: EnrollmentConfig,
    private readonly secret: SecretStore,
    private readonly options: EnrollOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.retryMs = options.retryMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private tls() {
    return this.config.trustCa ? { tls: { ca: this.config.trustCa } } : {};
  }

  /** The service's own certificate is checked against `trustCa` when set, else a `ca.crt` the
   * Secret holds (as an agent installed with a certificate reads it), else the public authorities. */
  private credentials(cert: string, key: string, ca?: string): Credentials {
    const trusted = this.config.trustCa ?? ca;
    return { cert, key, ...(trusted ? { ca: trusted } : {}) };
  }

  /** Until the agent has a certificate: from its Secret, or by enrolling. */
  async run(): Promise<{ credentials: Credentials; installId: string }> {
    for (;;) {
      this.options.signal?.throwIfAborted();
      let step: Step;
      try {
        step = await this.step();
      } catch (error) {
        step = {
          kind: "wait",
          reason:
            error instanceof CommandFailed
              ? `the Kubernetes API refused: ${error.message}`
              : `enrollment failed: ${(error as Error).message}`,
        };
      }
      if (step.kind === "ready") return step;
      if (step.reason !== this.lastReason)
        this.options.log(`waiting to enroll: ${step.reason}`, step.fields);
      this.lastReason = step.reason;
      await this.sleep(this.retryMs);
    }
  }

  /** One attempt, from whatever the Secret holds now. */
  async step(): Promise<Step> {
    const data = (await this.secret.read()) ?? {};
    const cert = data[SECRET_KEYS.cert];
    const key = data[SECRET_KEYS.key];
    if (cert && key) {
      const installId = checkCredentials(cert, key);
      return {
        kind: "ready",
        credentials: this.credentials(cert, key, data[SECRET_KEYS.ca]),
        installId,
      };
    }
    let pending = this.pending(data);
    if (!pending) {
      const collected = await this.collect();
      if (collected.kind === "wait") return collected;
      pending = collected.token;
      // Kept before it is spent, so a restart from here does not lose it.
      await this.secret.write({
        [SECRET_KEYS.pendingToken]: pending.enrollmentToken,
        [SECRET_KEYS.pendingInstall]: pending.installId,
      });
    }
    return this.exchange(pending);
  }

  private pending(data: Record<string, string>) {
    const parsed = AgentEnrollmentToken.safeParse({
      installId: data[SECRET_KEYS.pendingInstall],
      enrollmentToken: data[SECRET_KEYS.pendingToken],
    });
    return parsed.success ? parsed.data : null;
  }

  /** Step 1: the token from OpenBot's internal status port. */
  private async collect(): Promise<
    | { kind: "token"; token: AgentEnrollmentToken }
    | Extract<Step, { kind: "wait" }>
  > {
    let proof: string;
    try {
      proof = readFileSync(this.config.tokenFile, "utf8").trim();
    } catch {
      return {
        kind: "wait",
        reason: "no projected service account token is mounted",
      };
    }
    const url = new URL(AGENT_ENROLLMENT_TOKEN_PATH, this.config.serverUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${proof}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      return {
        kind: "wait",
        reason: "OpenBot's internal status port does not answer",
        fields: { url: url.origin, error: (error as Error).name },
      };
    }
    if (response.status === 200) {
      const parsed = AgentEnrollmentToken.safeParse(await response.json());
      if (parsed.success) return { kind: "token", token: parsed.data };
      return {
        kind: "wait",
        reason: "OpenBot answered something that is not an enrollment token",
      };
    }
    const detail = await problem(response);
    const fields = { status: response.status, ...(detail ? { detail } : {}) };
    if (response.status === 410)
      return {
        kind: "wait",
        reason:
          "OpenBot has already handed this enrollment's token out. Start a new connection in OpenBot's admin screen (CopilotKit management)",
        fields,
      };
    if (response.status === 401 || response.status === 403)
      return {
        kind: "wait",
        reason:
          "OpenBot refused this agent's service account. The agent must run as openbot-agent in openbot-system",
        fields,
      };
    return {
      kind: "wait",
      reason:
        "OpenBot has no enrollment token yet. Connect the install in OpenBot's admin screen (CopilotKit management)",
      fields,
    };
  }

  /** Steps 2 and 3: a certificate for the agent's own key, then the Secret. */
  private async exchange(pending: AgentEnrollmentToken): Promise<Step> {
    const { csrPem, keyPem } = await keyAndRequest(pending.installId);
    const url = new URL(ENROLLMENT_CERTIFICATES_PATH, this.config.url);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentToken: pending.enrollmentToken,
          csrPem,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
        ...this.tls(),
      });
    } catch (error) {
      return {
        kind: "wait",
        reason: "CopilotKit's enrollment service does not answer",
        fields: { url: url.origin, error: (error as Error).name },
      };
    }
    if (response.status !== 201) {
      const detail = await problem(response);
      const fields = { status: response.status, ...(detail ? { detail } : {}) };
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        // Spent, expired or refused: this token will never work. Forget it and ask OpenBot again.
        await this.secret.write({});
        return {
          kind: "wait",
          reason:
            "CopilotKit's enrollment service refused the enrollment token",
          fields,
        };
      }
      return {
        kind: "wait",
        reason:
          "CopilotKit's enrollment service could not issue a certificate yet",
        fields,
      };
    }
    const issued = CertificateIssued.safeParse(await response.json());
    if (!issued.success)
      return {
        kind: "wait",
        reason:
          "CopilotKit's enrollment service answered something that is not a certificate",
      };
    const installId = checkCredentials(issued.data.certificatePem, keyPem);
    if (
      installId !== pending.installId.toLowerCase() ||
      issued.data.installId.toLowerCase() !== installId
    )
      throw new EnrollmentRefused(
        "the certificate names another install than the enrollment token",
      );
    // The key exists only in memory until this write succeeds; keep trying with the same one.
    const data: Record<string, string> = {
      [SECRET_KEYS.cert]: issued.data.certificatePem,
      [SECRET_KEYS.key]: keyPem,
      ...(this.config.trustCa ? { [SECRET_KEYS.ca]: this.config.trustCa } : {}),
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.secret.write(data);
        break;
      } catch (error) {
        this.options.signal?.throwIfAborted();
        if (attempt === 1 || attempt % 20 === 0)
          this.options.log(
            "could not write the certificate Secret yet; retrying",
            {
              error:
                error instanceof CommandFailed
                  ? error.message
                  : (error as Error).name,
            },
          );
        await this.sleep(Math.min(30_000, 1000 * attempt));
      }
    }
    this.options.log("enrolled: certificate written to the agent's Secret", {
      installId,
    });
    return {
      kind: "ready",
      credentials: this.credentials(issued.data.certificatePem, keyPem),
      installId,
    };
  }
}

/** The agent as it runs: its install id and credentials from its Secret, enrolling first if need be. */
export async function enrolledAgent(
  agent: Agent,
  kube: Kube,
  options: EnrollOptions,
): Promise<ReadyAgent> {
  const { enrollment } = agent.config;
  if (!enrollment) {
    if (!agent.credentials || !agent.config.installId)
      throw new Error(
        "an agent without enrollment needs an install id and a certificate",
      );
    return agent as ReadyAgent;
  }
  const { credentials, installId } = await new Enrollment(
    enrollment,
    new KubeSecretStore(
      kube,
      agent.config.agentNamespace,
      enrollment.credentialsSecret,
    ),
    options,
  ).run();
  return {
    ...agent,
    config: { ...agent.config, installId },
    credentials,
  };
}
