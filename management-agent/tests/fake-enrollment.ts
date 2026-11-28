/**
 * Small but real stand-ins for the two services an enrolling agent talks to, answering exactly as
 * the contract (shared/management-contract.ts) says the real ones do:
 *
 * - CopilotKit's enrollment API, `POST /enroll/v1/certificates`: HTTPS with no client certificate,
 *   strict schemas, one use per enrollment token, the request's signature and subject checked, and
 *   a certificate issued for the request's own key by the test CA the fake management service
 *   trusts, so the agent's next call (a heartbeat over mutual TLS) proves the certificate works.
 * - OpenBot's internal status port, `GET /management/enrollment-token`: the token handed out once,
 *   then 410, and only to a bearer of a service account token for the agent's service account with
 *   the enrollment audience, verified against a JWKS (the cluster's own keys on a real cluster).
 */
import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import {
  AGENT_ENROLLMENT_TOKEN_PATH,
  AGENT_SERVICE_ACCOUNT,
  type AgentEnrollmentToken,
  CertificateRequest,
  ENROLLMENT_CERTIFICATES_PATH,
  ENROLLMENT_TOKEN_AUDIENCE,
  installCertificateSubject,
} from "../../shared/management-contract";
import type { TestPki } from "./fake-management-service";

const problem = (status: number, title: string) =>
  Response.json(
    { type: "about:blank", title, status },
    { status, headers: { "content-type": "application/problem+json" } },
  );

export class FakeEnrollmentService {
  /** Every body the service was sent, as received. */
  readonly requests: unknown[] = [];
  readonly issued: { installId: string; certificatePem: string }[] = [];
  /** Answer 503 to everything while true, as a service that is down. */
  down = false;
  private readonly tokens = new Map<
    string,
    { installId: string; used: boolean }
  >();
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly pki: TestPki) {}

  /** What the service hands OpenBot when an admin approves: a new install and its one-time token. */
  grant(installId: string = randomUUID()): AgentEnrollmentToken {
    const enrollmentToken = `et_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    this.tokens.set(enrollmentToken, { installId, used: false });
    return { installId, enrollmentToken };
  }

  /** Marks a token used, as when an earlier request's answer was lost on the way back. */
  spend(enrollmentToken: string) {
    const grant = this.tokens.get(enrollmentToken);
    if (grant) grant.used = true;
  }

  start(port = 0, hostname = "127.0.0.1") {
    this.server = Bun.serve({
      port,
      hostname,
      tls: { cert: this.pki.server.cert, key: this.pki.server.key },
      fetch: (request) => this.handle(request),
    });
    return this.server.port as number;
  }

  stop() {
    this.server?.stop(true);
  }

  private async handle(request: Request) {
    if (this.down) return problem(503, "Unavailable");
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== ENROLLMENT_CERTIFICATES_PATH
    )
      return problem(404, "Not found");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return problem(400, "Not JSON");
    }
    this.requests.push(body);
    const parsed = CertificateRequest.safeParse(body);
    if (!parsed.success) return problem(400, "Invalid request");
    const grant = this.tokens.get(parsed.data.enrollmentToken);
    if (!grant) return problem(401, "Unknown enrollment token");
    if (grant.used) return problem(409, "Enrollment token already used");
    const csr = new x509.Pkcs10CertificateRequest(parsed.data.csrPem);
    if (!(await csr.verify())) return problem(400, "Request not signed");
    const expected = new x509.Name(installCertificateSubject(grant.installId));
    if (csr.subjectName.toString() !== expected.toString())
      return problem(400, "Request names another subject");
    grant.used = true;
    const certificatePem = this.sign(parsed.data.csrPem);
    this.issued.push({ installId: grant.installId, certificatePem });
    return Response.json(
      { installId: grant.installId, certificatePem, caChainPem: this.pki.ca },
      { status: 201 },
    );
  }

  /** Signs the request as is, with the test CA: its key stays the agent's. */
  private sign(csrPem: string) {
    const name = `enrolled-${randomUUID()}`;
    const cwd = this.pki.directory;
    writeFileSync(join(cwd, `${name}.csr`), csrPem);
    writeFileSync(join(cwd, `${name}.ext`), "extendedKeyUsage=clientAuth\n");
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        "test-ca.crt",
        "-CAkey",
        "test-ca.key",
        "-CAcreateserial",
        "-days",
        "2",
        "-extfile",
        `${name}.ext`,
        "-out",
        `${name}.crt`,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    return readFileSync(join(cwd, `${name}.crt`), "utf8");
  }
}

export interface ServiceAccountKeys {
  /** The keys service account tokens are signed with. */
  jwks: JSONWebKeySet | URL;
  issuer: string;
  /** Extra headers for a remote JWKS (a cluster's API server wants a bearer). */
  headers?: Record<string, string>;
}

export class FakeOpenBotInternal {
  /** The token OpenBot collected when the admin's approval came through; null before. */
  token: AgentEnrollmentToken | null = null;
  private handedOut = false;
  readonly answers: { status: number; subject: string | null }[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly keys;

  constructor(private readonly accounts: ServiceAccountKeys) {
    this.keys =
      accounts.jwks instanceof URL
        ? createRemoteJWKSet(accounts.jwks, { headers: accounts.headers })
        : createLocalJWKSet(accounts.jwks);
  }

  start(port = 0, hostname = "127.0.0.1") {
    this.server = Bun.serve({
      port,
      hostname,
      fetch: (request) => this.handle(request),
    });
    return this.server.port as number;
  }

  stop() {
    this.server?.stop(true);
  }

  private async handle(request: Request) {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.pathname !== AGENT_ENROLLMENT_TOKEN_PATH
    )
      return problem(404, "Not found");
    const bearer = request.headers
      .get("authorization")
      ?.match(/^Bearer (.+)$/)?.[1];
    let subject: string | null = null;
    try {
      if (!bearer) throw new Error("no bearer");
      const { payload } = await jwtVerify(bearer, this.keys, {
        audience: ENROLLMENT_TOKEN_AUDIENCE,
        issuer: this.accounts.issuer,
      });
      subject = payload.sub ?? null;
    } catch {
      this.answers.push({ status: 401, subject });
      return problem(401, "Service account token not valid");
    }
    const [namespace, name] = AGENT_SERVICE_ACCOUNT.split(":");
    if (subject !== `system:serviceaccount:${namespace}:${name}`) {
      this.answers.push({ status: 403, subject });
      return problem(403, "Only the management agent's service account");
    }
    if (this.handedOut) {
      this.answers.push({ status: 410, subject });
      return problem(410, "Enrollment token already collected");
    }
    if (!this.token) {
      this.answers.push({ status: 404, subject });
      return problem(404, "No enrollment waiting for the agent");
    }
    this.handedOut = true;
    this.answers.push({ status: 200, subject });
    return Response.json(this.token);
  }
}
