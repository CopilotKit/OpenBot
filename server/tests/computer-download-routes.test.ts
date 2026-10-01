import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  ActionRefusedError,
  ComputerUnavailableError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

function asActor(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", member);
    await next();
  };
}

function appFor(
  gateway: ComputerGateway,
  canUseBot: (
    actor: AuthenticatedActor,
    botId: string,
  ) => Promise<boolean> = async () => true,
) {
  return createComputerRoutes(gateway, {} as PolicyStore, asActor(), canUseBot);
}

function gatewayThatReturns(name: string, bytes: Uint8Array) {
  const calls: Array<{
    botId: string;
    actorId: string;
    path: string;
  }> = [];
  const gateway = {
    downloadFile: async (
      botId: string,
      actor: { id: string },
      input: { path: string },
    ) => {
      calls.push({ botId, actorId: actor.id, path: input.path });
      return {
        body: bytes,
        bytes: bytes.byteLength,
        name,
      };
    },
  } as unknown as ComputerGateway;
  return { gateway, calls };
}

describe("the public computer file download route", () => {
  test("returns raw bytes under safe attachment headers", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const { gateway, calls } = gatewayThatReturns("report.pdf", bytes);
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=%20reports%2Freport.pdf%20",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls).toEqual([
      { botId: "bot-17", actorId: "user-1", path: "reports/report.pdf" },
    ]);
  });

  test("cannot add response headers through the filename", async () => {
    const { gateway } = gatewayThatReturns(
      "evil\r\nX-Injected: yes.txt",
      Uint8Array.from([1]),
    );
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=evil.txt",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(response.headers.get("x-injected")).toBeNull();
  });

  test("refuses a missing path before asking the gateway", async () => {
    const { gateway, calls } = gatewayThatReturns("x", Uint8Array.from([1]));
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A file path is required.",
    });
    expect(calls).toHaveLength(0);
  });

  test("applies Bot ownership before asking the gateway", async () => {
    const { gateway, calls } = gatewayThatReturns("x", Uint8Array.from([1]));
    const response = await appFor(gateway, async () => false).request(
      "http://openbot.test/somebody-elses-bot/files/download?path=x",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "There is no such Bot.",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    [
      "a policy refusal",
      new ActionRefusedError("Blocked by policy.", "file.extension == 'env'"),
      403,
    ],
    ["a workspace refusal", new WorkspaceRefusedError("Outside."), 403],
    ["a bad path", new WorkspaceRequestError("A path is required."), 400],
    ["a missing file", new WorkspaceNotFoundError("No such file."), 404],
    ["an oversized file", new WorkspaceTooLargeError("Too large."), 413],
    [
      "an unavailable computer",
      new ComputerUnavailableError("The computer is not running."),
      503,
    ],
    ["an unexpected failure", new Error("Boom."), 500],
  ])("maps %s to %i", async (_name, error, status) => {
    const gateway = {
      downloadFile: async () => {
        throw error;
      },
    } as unknown as ComputerGateway;
    const response = await appFor(gateway).request(
      "http://openbot.test/bot-17/files/download?path=x",
    );

    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: error.message });
    if (error instanceof ActionRefusedError) {
      expect(body).toMatchObject({ rule: error.rule });
    }
  });
});
