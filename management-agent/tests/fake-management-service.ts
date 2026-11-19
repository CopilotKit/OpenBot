/**
 * A small but real management service for tests: HTTPS with a test CA, a client certificate
 * required and checked, the contract's strict schemas on every body, and Ed25519-signed commands.
 * It answers exactly as the contract says the real one does, so the agent under test cannot tell.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Command,
  CommandResult,
  type DesiredState,
  HEARTBEAT_PATH,
  Heartbeat,
  type HeartbeatReply,
  type MaintenanceWindow,
  signCommand,
  toBase64,
  type UnsignedCommand,
} from "../../shared/management-contract";

export interface TestPki {
  directory: string;
  ca: string;
  server: { cert: string; key: string };
  client: { cert: string; key: string };
  /** A client certificate from another CA, which the service must refuse. */
  stranger: { cert: string; key: string };
}

function openssl(args: string[], cwd: string) {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function issue(
  cwd: string,
  name: string,
  subject: string,
  ca: string,
  extensions: string,
) {
  writeFileSync(join(cwd, `${name}.ext`), extensions);
  openssl(
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-subj",
      subject,
      "-out",
      `${name}.csr`,
    ],
    cwd,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${ca}.crt`,
      "-CAkey",
      `${ca}.key`,
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.crt`,
    ],
    cwd,
  );
}

function authority(cwd: string, name: string) {
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-subj",
      `/CN=${name}`,
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-out",
      `${name}.crt`,
    ],
    cwd,
  );
}

/** A CA, a server certificate for `hosts` (DNS names or IPs) and a client certificate whose CN is
 * the install id, as the management service issues at onboarding. */
export function makePki(installId: string, hosts: string[]): TestPki {
  const directory = mkdtempSync(join(tmpdir(), "openbot-management-pki-"));
  authority(directory, "test-ca");
  authority(directory, "stranger-ca");
  const names = hosts
    .map((host) => (/^[\d.]+$|:/.test(host) ? `IP:${host}` : `DNS:${host}`))
    .join(",");
  issue(
    directory,
    "server",
    "/CN=management",
    "test-ca",
    `subjectAltName=${names}\nextendedKeyUsage=serverAuth\n`,
  );
  issue(
    directory,
    "client",
    `/CN=${installId}`,
    "test-ca",
    "extendedKeyUsage=clientAuth\n",
  );
  issue(
    directory,
    "stranger",
    `/CN=${installId}`,
    "stranger-ca",
    "extendedKeyUsage=clientAuth\n",
  );
  const read = (name: string) => readFileSync(join(directory, name), "utf8");
  return {
    directory,
    ca: read("test-ca.crt"),
    server: { cert: read("server.crt"), key: read("server.key") },
    client: { cert: read("client.crt"), key: read("client.key") },
    stranger: { cert: read("stranger.crt"), key: read("stranger.key") },
  };
}

export class FakeManagementService {
  readonly heartbeats: Heartbeat[] = [];
  readonly results: CommandResult[] = [];
  readonly refused: string[] = [];
  desired: DesiredState | null = null;
  window: MaintenanceWindow = { weekday: 0, startUtc: "00:00", hours: 168 };
  paused = false;
  private pending: Command[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  publicKey = "";
  private privateKey: CryptoKey | null = null;

  constructor(
    private readonly pki: TestPki,
    private readonly installId: string,
  ) {}

  async start(port = 0, hostname = "127.0.0.1") {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    this.privateKey = pair.privateKey;
    this.publicKey = toBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
    const service = this;
    this.server = Bun.serve({
      port,
      hostname,
      tls: {
        cert: this.pki.server.cert,
        key: this.pki.server.key,
        ca: this.pki.ca,
        requestCert: true,
        rejectUnauthorized: true,
      },
      async fetch(request) {
        return service.handle(request);
      },
    });
    return this.server.port;
  }

  stop() {
    this.server?.stop(true);
  }

  /** Queues a command, signed with the service's key. */
  async command(
    command: Omit<UnsignedCommand, "issuedAt" | "expiresAt"> &
      Partial<UnsignedCommand>,
  ) {
    if (!this.privateKey) throw new Error("start the service first");
    const now = Date.now();
    const signed = await signCommand(
      {
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 15 * 60_000).toISOString(),
        ...command,
      },
      this.privateKey,
    );
    this.pending.push(signed);
    return signed;
  }

  /** Bun has verified the client certificate chains to the test CA before a request gets here. */
  private async handle(request: Request) {
    const url = new URL(request.url);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("not JSON", { status: 400 });
    }
    if (request.method === "POST" && url.pathname === HEARTBEAT_PATH) {
      const parsed = Heartbeat.safeParse(body);
      if (!parsed.success || parsed.data.installId !== this.installId) {
        this.refused.push(
          parsed.success ? "wrong install" : parsed.error.message,
        );
        return new Response("refused", { status: 400 });
      }
      this.heartbeats.push(parsed.data);
      const reply: HeartbeatReply = {
        desired: this.desired,
        window: this.window,
        paused: this.paused,
        commands: this.pending.splice(0),
      };
      return Response.json(reply);
    }
    const result = url.pathname.match(/^\/v1\/commands\/([^/]+)\/result$/);
    if (request.method === "POST" && result) {
      const parsed = CommandResult.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.commandId !== decodeURIComponent(result[1] ?? "")
      ) {
        this.refused.push("bad result");
        return new Response("refused", { status: 400 });
      }
      this.results.push(parsed.data);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }
}

/** The CN of a PEM certificate, for checks that a client certificate names its install. */
export function commonName(pem: string) {
  return new X509Certificate(pem).subject.match(/CN=([^\n,]+)/)?.[1] ?? null;
}
