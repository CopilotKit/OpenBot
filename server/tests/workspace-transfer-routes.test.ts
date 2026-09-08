import { describe, expect, test } from "bun:test";
import type { WorkspaceFileTransferService } from "../src/agents/attachment-transfer-tool";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const attachmentId = "22222222-2222-4222-8222-222222222222";
const crossedTransferId = "11111111-1111-4111-8111-111111111111";

function appWith(service?: WorkspaceFileTransferService) {
  const config = loadConfig(
    testEnvironment({
      OPENBOT_SINGLE_USER: "true",
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      BETTER_AUTH_SECRET: undefined,
      BETTER_AUTH_URL: undefined,
    }),
  );
  const args: Parameters<typeof createApp> = [
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      get: async (_actor: unknown, botId: string) =>
        botId === "jefe-erp" ? ({ id: botId } as never) : null,
    } as unknown as AgentProfileStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  ];
  return createApp(...args);
}

describe("human-approved workspace transfer routes", () => {
  test("does not mount an acting endpoint when the feature is absent", async () => {
    const response = await appWith().request(
      "http://openbot.test/api/workspace-transfers/approve",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  test("uses the signed-in actor and an accessible Bot for approval", async () => {
    const calls: unknown[] = [];
    const service = {
      preview: async (input: unknown) => {
        calls.push(["preview", input]);
        return {
          attachmentId,
          filename: "invoice.pdf",
          mediaType: "application/pdf",
          sizeBytes: 42,
          sha256: "a".repeat(64),
          status: "READY" as const,
        };
      },
      approve: async (input: unknown) => {
        calls.push(["approve", input]);
        return {
          attachmentId,
          transferId: crossedTransferId,
          filename: "invoice.pdf",
          sizeBytes: 42,
          sha256: "a".repeat(64),
          status: "UPLOADED" as const,
        };
      },
    } as WorkspaceFileTransferService;
    const app = appWith(service);
    const body = {
      botId: "jefe-erp",
      attachmentId,
      transferId: crossedTransferId,
    };
    const trustedInput = { botId: "jefe-erp", attachmentId };

    expect(
      (
        await app.request(
          "http://openbot.test/api/workspace-transfers/preview",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          "http://openbot.test/api/workspace-transfers/approve",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        )
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      ["preview", trustedInput],
      ["approve", { ...trustedInput, actorId: "dev-local-user" }],
    ]);
  });

  test("refuses a Bot the signed-in person cannot access", async () => {
    const reached: unknown[] = [];
    const response = await appWith({
      preview: async (input) => {
        reached.push(input);
        throw new Error("unexpected");
      },
      approve: async (input) => {
        reached.push(input);
        throw new Error("unexpected");
      },
    }).request("http://openbot.test/api/workspace-transfers/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "recolector-documentos",
        attachmentId,
        transferId: crossedTransferId,
      }),
    });
    expect(response.status).toBe(403);
    expect(reached).toEqual([]);
  });
});
