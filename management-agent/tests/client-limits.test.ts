/**
 * The management service is outside the agent's trust boundary. These tests make it answer with
 * bodies far larger than any real heartbeat reply or error message, and check that the agent stops
 * reading instead of buffering them into the pod's memory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { HEARTBEAT_PATH } from "../../shared/management-contract";
import { ManagementClient } from "../src/client";
import { makePki, type TestPki } from "./fake-management-service";

const installId = "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11";
let pki: TestPki;
let server: ReturnType<typeof Bun.serve>;
let url = "";
let mode: "huge-error" | "short-error" | "huge-reply" = "huge-error";

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

beforeAll(() => {
  pki = makePki(installId, ["127.0.0.1"]);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      cert: pki.server.cert,
      key: pki.server.key,
      ca: pki.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    fetch(request) {
      if (
        mode === "huge-reply" &&
        new URL(request.url).pathname === HEARTBEAT_PATH
      ) {
        return Response.json({
          desired: null,
          window: { weekday: 0, startUtc: "00:00", hours: 168 },
          paused: false,
          commands: [],
          padding: "x".repeat(2 * 1024 * 1024),
        });
      }
      return new Response(
        "x".repeat(mode === "short-error" ? 1000 : 2 * 1024 * 1024),
        { status: 500 },
      );
    },
  });
  url = `https://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(pki.directory, { recursive: true, force: true });
});

describe("management response limits", () => {
  test("an oversized error body is refused without being read", async () => {
    mode = "huge-error";
    const client = new ManagementClient(url, { ...pki.client, ca: pki.ca });
    await expect(client.heartbeat(heartbeat())).rejects.toThrow(
      /larger than 4096 bytes/,
    );
  });

  test("an oversized heartbeat reply is refused without being parsed", async () => {
    mode = "huge-reply";
    const client = new ManagementClient(url, { ...pki.client, ca: pki.ca });
    await expect(client.heartbeat(heartbeat())).rejects.toThrow(
      /larger than 1048576 bytes/,
    );
  });

  test("a short error still reports its first 300 characters", async () => {
    mode = "short-error";
    const client = new ManagementClient(url, { ...pki.client, ca: pki.ca });
    let message = "";
    try {
      await client.heartbeat(heartbeat());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("x".repeat(300));
    expect(message).not.toContain("x".repeat(301));
  });
});
