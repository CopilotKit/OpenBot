/**
 * Self-serve enrollment over real HTTP and TLS: the agent collects the enrollment token from a
 * stand-in of OpenBot's internal status port with a signed service account token, sends a request
 * for its own key to a stand-in of CopilotKit's enrollment API, keeps the certificate and key, and
 * the certificate then carries a heartbeat over mutual TLS to the fake management service. The
 * Secret is an in-memory store here; enroll-kind.test.ts runs the same flow on a real cluster.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { ENROLLMENT_TOKEN_AUDIENCE } from "../../shared/management-contract";
import { ManagementClient } from "../src/client";
import type { EnrollmentConfig } from "../src/config";
import { Enrollment, type SecretStore } from "../src/enroll";
import { FakeEnrollmentService, FakeOpenBotInternal } from "./fake-enrollment";
import {
  commonName,
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

const installId = "3d8e2a51-6b0f-4c7e-9a12-5f4b3c2d1e0a";
const ISSUER = "https://kubernetes.default.svc.cluster.local";
let pki: TestPki;
let fleet: FakeManagementService;
let enroll: FakeEnrollmentService;
let openbot: FakeOpenBotInternal;
let signingKey: CryptoKey;
let jwks: JSONWebKeySet;
let directory = "";
let fleetUrl = "";
let enrollUrl = "";
let serverUrl = "";

class MemorySecret implements SecretStore {
  data: Record<string, string> | null = null;
  writes = 0;
  /** Which writes (1-based) fail, as an API server that is briefly away. */
  failing = new Set<number>();
  async read() {
    return this.data ? { ...this.data } : null;
  }
  async write(data: Record<string, string>) {
    this.writes++;
    if (this.failing.has(this.writes)) throw new Error("apiserver unavailable");
    this.data = { ...data };
  }
}

/** Another OpenBot server with its own one-time token, over the same cluster keys. */
function internalWith(installId: string) {
  const internal = new FakeOpenBotInternal({ jwks, issuer: ISSUER });
  const url = `http://127.0.0.1:${internal.start()}`;
  internal.token = enroll.grant(installId);
  return { internal, url, token: internal.token };
}

async function serviceAccountToken(subject: string, audience: string) {
  return new SignJWT({ "kubernetes.io": { namespace: "openbot-system" } })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey);
}

async function tokenFile(
  subject = "system:serviceaccount:openbot-system:openbot-agent",
  audience = ENROLLMENT_TOKEN_AUDIENCE,
) {
  const file = join(directory, `token-${crypto.randomUUID()}`);
  writeFileSync(file, await serviceAccountToken(subject, audience));
  return file;
}

function config(file: string): EnrollmentConfig {
  return {
    serverUrl,
    url: enrollUrl,
    credentialsSecret: "openbot-agent-credentials",
    tokenFile: file,
    trustCa: pki.ca,
  };
}

function enrollment(file: string, secret: SecretStore, logs: string[]) {
  return new Enrollment(config(file), secret, {
    log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })),
    sleep: async () => {},
    retryMs: 0,
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "openbot-enroll-"));
  pki = makePki(installId, ["127.0.0.1"]);
  fleet = new FakeManagementService(pki, installId);
  fleetUrl = `https://127.0.0.1:${await fleet.start()}`;
  enroll = new FakeEnrollmentService(pki);
  enrollUrl = `https://127.0.0.1:${enroll.start()}`;
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey as CryptoKey;
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }],
  };
  openbot = new FakeOpenBotInternal({ jwks, issuer: ISSUER });
  serverUrl = `http://127.0.0.1:${openbot.start()}`;
});
afterAll(() => {
  fleet.stop();
  enroll.stop();
  openbot.stop();
  rmSync(pki.directory, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
});

describe("self-serve enrollment", () => {
  test("waits for an approval, enrolls with its own key, heartbeats, and on a restart reuses the Secret", async () => {
    const secret = new MemorySecret();
    const logs: string[] = [];
    const file = await tokenFile();

    // Before the admin's approval: OpenBot has no token for the agent yet.
    const before = await enrollment(file, secret, logs).step();
    expect(before.kind).toBe("wait");
    expect(secret.data).toBeNull();

    openbot.token = enroll.grant(installId);
    const { credentials, installId: enrolled } = await enrollment(
      file,
      secret,
      logs,
    ).run();
    expect(enrolled).toBe(installId);
    expect(commonName(credentials.cert)).toBe(installId);
    expect(secret.data?.["tls.crt"]).toBe(credentials.cert);
    expect(secret.data?.["tls.key"]).toBe(credentials.key);
    expect(secret.data?.["enrollment-token"]).toBeUndefined();
    expect(secret.data?.["install-id"]).toBeUndefined();
    expect(secret.data?.["ca.crt"]).toBe(pki.ca);

    // The service saw a request and a token, never a key.
    const sent = JSON.stringify(enroll.requests);
    expect(sent).toContain("BEGIN CERTIFICATE REQUEST");
    expect(sent).not.toContain("PRIVATE KEY");
    expect(sent).not.toContain(credentials.key.split("\n")[1] ?? "-");

    // The certificate works where it matters: a heartbeat over mutual TLS.
    const client = new ManagementClient(fleetUrl, credentials);
    await client.heartbeat({
      installId: enrolled,
      agentVersion: "0.1.0",
      cloud: "other",
      openbot: { version: "v1.1.0", chartVersion: "0.1.0", imageDigests: {} },
      intelligence: { chartVersion: "none" },
      lastAppliedMigration: null,
      flux: { helmReleases: [] },
      pods: [],
      upgrade: { state: "idle", targetVersion: null, journal: null },
      sentAt: new Date().toISOString(),
    });
    expect(fleet.heartbeats.at(-1)?.installId).toBe(installId);

    // A restart: the Secret is read; OpenBot, asked once, has handed the token out already (410),
    // and the enrollment service is not asked at all.
    const asked = openbot.answers.length;
    const issued = enroll.issued.length;
    const again = await enrollment(file, secret, logs).run();
    expect(again.credentials.cert).toBe(credentials.cert);
    expect(again.installId).toBe(installId);
    expect(openbot.answers.slice(asked).map((answer) => answer.status)).toEqual(
      [410],
    );
    expect(enroll.issued.length).toBe(issued);

    // Nothing secret reached a log line.
    const logged = logs.join("\n");
    expect(logged).not.toContain(openbot.token.enrollmentToken);
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("BEGIN CERTIFICATE");
    expect(logged).not.toContain(
      (await Bun.file(file).text()).split(".")[1] ?? "-",
    );
  });

  test("a token collected while the enrollment API is down is kept, and used once it is back", async () => {
    const id = crypto.randomUUID();
    const { internal, url, token } = internalWith(id);
    try {
      const secret = new MemorySecret();
      const file = await tokenFile();
      const logs: string[] = [];
      const make = () =>
        new Enrollment({ ...config(file), serverUrl: url }, secret, {
          log: (message, fields) =>
            logs.push(JSON.stringify({ message, ...fields })),
          sleep: async () => {},
          retryMs: 0,
        });
      enroll.down = true;
      expect((await make().step()).kind).toBe("wait");
      expect(secret.data?.["enrollment-token"]).toBe(token.enrollmentToken);
      // A restart: OpenBot would now answer 410, so the kept token is what enrolls.
      enroll.down = false;
      const done = await make().run();
      expect(done.installId).toBe(id);
      expect(internal.answers.map((answer) => answer.status)).toEqual([200]);
      expect(logs.join("\n")).not.toContain(token.enrollmentToken);
    } finally {
      enroll.down = false;
      internal.stop();
    }
  });

  test("the key is kept in memory and written once the Kubernetes API takes it", async () => {
    const id = crypto.randomUUID();
    const { internal, url } = internalWith(id);
    try {
      const secret = new MemorySecret();
      // Write 1 keeps the pending token; writes 2 to 4 of the certificate fail.
      secret.failing = new Set([2, 3, 4]);
      const result = await new Enrollment(
        { ...config(await tokenFile()), serverUrl: url },
        secret,
        { log: () => {}, sleep: async () => {}, retryMs: 0 },
      ).step();
      expect(result.kind).toBe("ready");
      expect(secret.writes).toBe(5);
      expect(secret.data?.["tls.key"]).toContain("PRIVATE KEY");
      expect(
        enroll.issued.filter((entry) => entry.installId === id),
      ).toHaveLength(1);
    } finally {
      internal.stop();
    }
  });

  test("a token already spent is forgotten, and OpenBot's 410 says to connect again", async () => {
    const spent = enroll.grant(crypto.randomUUID());
    const secret = new MemorySecret();
    // Kept from an earlier attempt whose answer never arrived, but the service used it.
    secret.data = {
      "enrollment-token": spent.enrollmentToken,
      "install-id": spent.installId,
    };
    enroll.spend(spent.enrollmentToken);
    const logs: string[] = [];
    const step = await enrollment(await tokenFile(), secret, logs).step();
    expect(step).toMatchObject({
      kind: "wait",
      reason: "CopilotKit's enrollment service refused the enrollment token",
      fields: { status: 409 },
    });
    expect(secret.data).toEqual({});
    // The first test's token is long handed out: OpenBot answers 410.
    const next = await enrollment(await tokenFile(), secret, logs).step();
    expect(next).toMatchObject({ kind: "wait", fields: { status: 410 } });
  });

  test("another service account, or another audience, is refused the token", async () => {
    const { internal, url } = internalWith(crypto.randomUUID());
    try {
      const attempt = async (file: string) =>
        new Enrollment(
          { ...config(file), serverUrl: url },
          new MemorySecret(),
          { log: () => {}, sleep: async () => {}, retryMs: 0 },
        ).step();
      expect(
        await attempt(
          await tokenFile("system:serviceaccount:openbot:openbot-server"),
        ),
      ).toMatchObject({ kind: "wait", fields: { status: 403 } });
      expect(
        await attempt(
          await tokenFile(
            "system:serviceaccount:openbot-system:openbot-agent",
            "https://kubernetes.default.svc",
          ),
        ),
      ).toMatchObject({ kind: "wait", fields: { status: 401 } });
      // The refusals spent nothing: the agent still gets it.
      expect((await attempt(await tokenFile())).kind).toBe("ready");
    } finally {
      internal.stop();
    }
  });

  /** A Secret holding install `id`'s certificate and key, enrolled through its own OpenBot. */
  async function enrolledSecret(id: string) {
    const first = internalWith(id);
    const secret = new MemorySecret();
    const done = await new Enrollment(
      { ...config(await tokenFile()), serverUrl: first.url },
      secret,
      { log: () => {}, sleep: async () => {}, retryMs: 0 },
    ).run();
    expect(done.installId).toBe(id);
    return { secret, first, cert: done.credentials.cert };
  }

  test("connecting again after an uninstall: a Secret left with the old install's certificate is replaced by the new install's", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const { secret, first, cert: certA } = await enrolledSecret(a);
    // `helm uninstall` left the Secret; the admin connected again, so OpenBot holds B's token.
    const second = internalWith(b);
    try {
      const logs: string[] = [];
      const make = async () =>
        new Enrollment(
          { ...config(await tokenFile()), serverUrl: second.url },
          secret,
          {
            log: (message, fields) =>
              logs.push(JSON.stringify({ message, ...fields })),
            sleep: async () => {},
            retryMs: 0,
          },
        );
      const done = await (await make()).run();
      expect(done.installId).toBe(b);
      expect(commonName(done.credentials.cert)).toBe(b);
      expect(secret.data?.["tls.crt"]).toBe(done.credentials.cert);
      expect(secret.data?.["tls.crt"]).not.toBe(certA);
      expect(secret.data?.["tls.key"]).toBe(done.credentials.key);
      expect(secret.data?.["enrollment-token"]).toBeUndefined();
      expect(secret.data?.["install-id"]).toBeUndefined();
      expect(
        enroll.issued.filter((entry) => entry.installId === b),
      ).toHaveLength(1);
      // A restart after that: OpenBot answers 410, the agent stays B and enrolls nothing.
      const again = await (await make()).run();
      expect(again.installId).toBe(b);
      expect(again.credentials.cert).toBe(done.credentials.cert);
      expect(second.internal.answers.map((answer) => answer.status)).toEqual([
        200, 410,
      ]);
      const logged = logs.join("\n");
      expect(logged).not.toContain(second.token.enrollmentToken);
      expect(logged).not.toContain("PRIVATE KEY");
      expect(logged).not.toContain("BEGIN CERTIFICATE");
    } finally {
      first.internal.stop();
      second.internal.stop();
    }
  });

  test("a start with credentials keeps them when OpenBot answers 410, has no token, refuses or does not answer", async () => {
    const a = crypto.randomUUID();
    const { secret, first, cert: certA } = await enrolledSecret(a);
    const empty = new FakeOpenBotInternal({ jwks, issuer: ISSUER });
    const emptyUrl = `http://127.0.0.1:${empty.start()}`;
    const gone = new FakeOpenBotInternal({ jwks, issuer: ISSUER });
    const goneUrl = `http://127.0.0.1:${gone.start()}`;
    gone.stop();
    try {
      const start = async (serverUrl: string, file?: string) =>
        new Enrollment(
          { ...config(file ?? (await tokenFile())), serverUrl },
          secret,
          { log: () => {}, sleep: async () => {}, retryMs: 0 },
        ).run();
      const writes = secret.writes;
      const issued = enroll.issued.length;
      // 410: A's token was collected already.
      expect((await start(first.url)).installId).toBe(a);
      expect(first.internal.answers.at(-1)?.status).toBe(410);
      // 404: nothing to hand out.
      expect((await start(emptyUrl)).installId).toBe(a);
      expect(empty.answers.at(-1)?.status).toBe(404);
      // 403: another service account is refused.
      const refused = await start(
        emptyUrl,
        await tokenFile("system:serviceaccount:openbot:openbot-server"),
      );
      expect(refused.installId).toBe(a);
      expect(empty.answers.at(-1)?.status).toBe(403);
      // Not answering: OpenBot is down.
      const down = await start(goneUrl);
      expect(down.installId).toBe(a);
      expect(down.credentials.cert).toBe(certA);
      expect(secret.data?.["tls.crt"]).toBe(certA);
      expect(secret.writes).toBe(writes);
      expect(enroll.issued.length).toBe(issued);
    } finally {
      first.internal.stop();
      empty.stop();
    }
  });

  test("while running: Disconnect then Connect keeps the new install's token, and the agent's next start enrolls for it", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const { secret, first, cert: certA } = await enrolledSecret(a);
    try {
      const make = async (serverUrl: string, logs: string[] = []) =>
        new Enrollment({ ...config(await tokenFile()), serverUrl }, secret, {
          log: (message, fields) =>
            logs.push(JSON.stringify({ message, ...fields })),
          sleep: async () => {},
          retryMs: 0,
        });
      // Nothing new (OpenBot answers 410 for A's token): the running agent changes nothing.
      expect(await (await make(first.url)).newInstallWaiting(a)).toBe(false);
      expect(secret.data?.["tls.crt"]).toBe(certA);
      // The admin disconnected (A's certificate revoked) and connected again: OpenBot holds B's.
      const second = internalWith(b);
      try {
        const logs: string[] = [];
        expect(await (await make(second.url, logs)).newInstallWaiting(a)).toBe(
          true,
        );
        // Kept before the agent starts again, since OpenBot hands it out once.
        expect(secret.data?.["enrollment-token"]).toBe(
          second.token.enrollmentToken,
        );
        expect(secret.data?.["install-id"]).toBe(b);
        expect(logs.join("\n")).not.toContain(second.token.enrollmentToken);
        // The next start enrolls for B with the kept token, and never asks OpenBot again.
        const done = await (await make(second.url)).run();
        expect(done.installId).toBe(b);
        expect(commonName(done.credentials.cert)).toBe(b);
        expect(second.internal.answers.map((answer) => answer.status)).toEqual([
          200,
        ]);
      } finally {
        second.internal.stop();
      }
    } finally {
      first.internal.stop();
    }
  });

  test("a certificate for another key is refused and never written", async () => {
    const id = crypto.randomUUID();
    const { internal, url } = internalWith(id);
    // A service that answers with a certificate for the right install but another key.
    const other = makePki(id, ["127.0.0.1"]);
    const rogue = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: pki.server.cert, key: pki.server.key },
      fetch: () =>
        Response.json(
          {
            installId: id,
            certificatePem: other.client.cert,
            caChainPem: pki.ca,
          },
          { status: 201 },
        ),
    });
    try {
      const secret = new MemorySecret();
      const step = await new Enrollment(
        {
          ...config(await tokenFile()),
          serverUrl: url,
          url: `https://127.0.0.1:${rogue.port}`,
        },
        secret,
        { log: () => {}, sleep: async () => {}, retryMs: 0 },
      )
        .step()
        .catch((error: Error) => error);
      expect((step as Error).message).toBe(
        "the certificate is not for this key",
      );
      expect(secret.data?.["tls.crt"]).toBeUndefined();
      expect(secret.data?.["tls.key"]).toBeUndefined();
    } finally {
      rmSync(other.directory, { recursive: true, force: true });
      rogue.stop(true);
      internal.stop();
    }
  });
});

describe("reading the agent's own Secret", () => {
  test("an API server refusal is not an absent Secret: a Role not created yet never sends the agent enrolling again", async () => {
    const { Kube, CommandFailed } = await import("../src/kube");
    const { KubeSecretStore } = await import("../src/enroll");
    const answer = (stderr: string) =>
      new KubeSecretStore(
        new Kube(async (command) => {
          throw new CommandFailed([...command], 1, stderr);
        }),
        "openbot-system",
        "openbot-agent-credentials",
      );
    // What kubectl prints while the RoleBinding exists and its Role does not, yet.
    const forbidden = answer(
      'Error from server (Forbidden): secrets "openbot-agent-credentials" is forbidden: User "system:serviceaccount:openbot-system:openbot-agent" cannot get resource "secrets" in API group "" in the namespace "openbot-system": RBAC: role.rbac.authorization.k8s.io "openbot-agent" not found',
    );
    expect(
      await forbidden.read().catch((error: Error) => error),
    ).toBeInstanceOf(CommandFailed);
    const absent = answer(
      'Error from server (NotFound): secrets "openbot-agent-credentials" not found',
    );
    expect(await absent.read()).toBeNull();
  });
});
