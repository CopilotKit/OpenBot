/**
 * The agent's connection to the management service over real mutual TLS: a test CA issues the
 * server's certificate and the install's client certificate, and the service refuses any client
 * without a certificate from that CA.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ManagementClient } from "../src/client";
import {
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

const installId = "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11";
let pki: TestPki;
let service: FakeManagementService;
let url = "";

const heartbeat = () => ({
  installId,
  agentVersion: "0.1.0",
  cloud: "other" as const,
  openbot: { version: "v1.1.0", chartVersion: "0.1.0", imageDigests: {} },
  intelligence: { chartVersion: "none" },
  lastAppliedMigration: null,
  flux: { helmReleases: [] },
  pods: [],
  upgrade: { state: "idle" as const, targetVersion: null, journal: null },
  sentAt: new Date().toISOString(),
});

beforeAll(async () => {
  pki = makePki(installId, ["127.0.0.1"]);
  service = new FakeManagementService(pki, installId);
  url = `https://127.0.0.1:${await service.start()}`;
});
afterAll(() => {
  service.stop();
  rmSync(pki.directory, { recursive: true, force: true });
});

describe("management client", () => {
  test("sends a heartbeat with the install's certificate and reads the reply and its signed commands", async () => {
    await service.command({ id: "c1", kind: "pause", args: {} });
    const client = new ManagementClient(url, { ...pki.client, ca: pki.ca });
    const reply = await client.heartbeat(heartbeat());
    expect(service.heartbeats).toHaveLength(1);
    expect(reply.commands).toHaveLength(1);
    await client.result({
      commandId: "c1",
      ok: true,
      reason: "paused",
      finishedAt: new Date().toISOString(),
    });
    expect(service.results.map((result) => result.commandId)).toEqual(["c1"]);
  });

  test("a certificate from another CA, or none, never reaches the service", async () => {
    const stranger = new ManagementClient(url, { ...pki.stranger, ca: pki.ca });
    await expect(stranger.heartbeat(heartbeat())).rejects.toThrow();
    const anonymous = new ManagementClient(url, {
      cert: "",
      key: "",
      ca: pki.ca,
    });
    await expect(anonymous.heartbeat(heartbeat())).rejects.toThrow();
    expect(service.heartbeats).toHaveLength(1);
  });

  test("a server the agent's CA did not issue is refused", async () => {
    const client = new ManagementClient(url, {
      ...pki.client,
      ca: pki.stranger.cert,
    });
    await expect(client.heartbeat(heartbeat())).rejects.toThrow();
  });
});
