import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createConnectorCatalogService } from "../src/connectors";
import { testEnvironment } from "./support/environment";

const config = loadConfig(testEnvironment());

describe("admin connectors API", () => {
  test("accepts Google Drive service-account setup without returning the key", async () => {
    const received: unknown[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      undefined,
      undefined,
      {
        list: async () => [],
        configureGoogleDrive: async (input: unknown) => {
          received.push(input);
          return {
            id: "google-drive",
            type: "google_drive" as const,
            name: "Google Drive",
            roots: ["Policies"],
            configured: true,
          };
        },
      },
    );
    const serviceAccountJson = JSON.stringify({
      type: "service_account",
      private_key: "secret",
    });
    const response = await app.request(
      "http://openbot.local/api/admin/connectors/google-drive/setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceAccountJson,
          impersonationSubject: "admin@example.com",
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain("secret");
    expect(received).toEqual([
      {
        serviceAccountJson,
        impersonationSubject: "admin@example.com",
        actorUserId: "admin",
      },
    ]);
  });

  test("derives the available catalog from deployment knowledge sources", async () => {
    const service = createConnectorCatalogService([
      { type: "google-drive", roots: ["Policies"] },
      { type: "microsoft-onedrive", roots: ["Operations"] },
    ]);

    await expect(service.list()).resolves.toEqual([
      {
        id: "google-drive",
        type: "google_drive",
        name: "Google Drive",
        roots: ["Policies"],
        configured: false,
      },
      {
        id: "microsoft-onedrive",
        type: "onedrive",
        name: "Microsoft OneDrive",
        roots: ["Operations"],
        configured: false,
      },
    ]);
  });

  test("lists only deployment-seeded connector metadata", async () => {
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      undefined,
      undefined,
      {
        list: async () => [
          {
            id: "google-drive",
            type: "google_drive" as const,
            name: "Google Drive",
            roots: ["Policies", "Compliance"],
            configured: false,
          },
        ],
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/connectors",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectors: [
        {
          id: "google-drive",
          type: "google_drive",
          name: "Google Drive",
          roots: ["Policies", "Compliance"],
          configured: false,
        },
      ],
    });
  });
});
