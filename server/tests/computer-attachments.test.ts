import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createComputerAttachmentBroker,
  type HandoffAttachment,
} from "../src/computer/attachments";
import type { ComputerProvider } from "../src/computer/provider";

const pdf = Buffer.from("%PDF-1.4\n%%EOF\n", "ascii");
const sha256 = createHash("sha256").update(pdf).digest("hex");

function provider(): ComputerProvider {
  return {
    name: "test",
    isolation: "per-bot",
    locate: async (botId) => `https://${botId}.computer.test`,
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
    list: async () => [],
  };
}

function exported(body = pdf, filename = "invoice.pdf"): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(body.length),
      "x-openbot-attachment-filename": encodeURIComponent(filename),
      "x-openbot-attachment-sha256": createHash("sha256")
        .update(body)
        .digest("hex"),
    },
  });
}

describe("copying attachments between Bot computers", () => {
  test("copies bytes through two separately located computers", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const broker = createComputerAttachmentBroker({
      provider: provider(),
      token: "computer-token",
      id: () => "11111111-1111-4111-8111-111111111111",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (
          url === "https://collector.computer.test/files/attachments/export"
        ) {
          return exported();
        }
        if (url === "https://erp.computer.test/files/attachments/import") {
          expect(
            Buffer.from(await new Response(init.body).arrayBuffer()),
          ).toEqual(pdf);
          return Response.json({
            handoffId: "a".repeat(64),
            attachmentId: "11111111-1111-4111-8111-111111111111",
            filename: "invoice.pdf",
            mediaType: "application/pdf",
            sizeBytes: pdf.length,
            sha256,
            path: `inbox/${"a".repeat(64)}/11111111-1111-4111-8111-111111111111/invoice.pdf`,
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });

    const copied = await broker.copy({
      handoffId: "a".repeat(64),
      fromBotId: "collector",
      toBotId: "erp",
      paths: ["downloads/invoice.pdf"],
    });

    expect(copied).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        filename: "invoice.pdf",
        mediaType: "application/pdf",
        sizeBytes: pdf.length,
        sha256,
        path: `inbox/${"a".repeat(64)}/11111111-1111-4111-8111-111111111111/invoice.pdf`,
      },
    ] satisfies HandoffAttachment[]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://collector.computer.test/files/attachments/export",
      "https://erp.computer.test/files/attachments/import",
    ]);
    const firstRequest = requests[0];
    if (!firstRequest) throw new Error("The export request was not made");
    expect(
      (firstRequest.init.headers as Record<string, string>)[
        "x-openbot-computer-token"
      ],
    ).toBe("computer-token");
  });

  test("rolls back earlier target files when a later export fails", async () => {
    const imported: HandoffAttachment[] = [];
    let exportCount = 0;
    const broker = createComputerAttachmentBroker({
      provider: provider(),
      id: () =>
        exportCount === 0
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/export")) {
          exportCount += 1;
          return exportCount === 1
            ? exported()
            : Response.json({ error: "bad source" }, { status: 400 });
        }
        if (url.endsWith("/import")) {
          const attachment: HandoffAttachment = {
            id: "11111111-1111-4111-8111-111111111111",
            filename: "invoice.pdf",
            mediaType: "application/pdf",
            sizeBytes: pdf.length,
            sha256,
            path: `inbox/${"b".repeat(64)}/11111111-1111-4111-8111-111111111111/invoice.pdf`,
          };
          imported.push(attachment);
          return Response.json({
            ...attachment,
            handoffId: "b".repeat(64),
            attachmentId: attachment.id,
          });
        }
        if (url.endsWith("/delete")) {
          const removed = JSON.parse(String(init.body)) as HandoffAttachment;
          imported.splice(
            imported.findIndex((item) => item.id === removed.id),
            1,
          );
          return Response.json({ deleted: true });
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });

    await expect(
      broker.copy({
        handoffId: "b".repeat(64),
        fromBotId: "collector",
        toBotId: "erp",
        paths: ["downloads/one.pdf", "downloads/two.pdf"],
      }),
    ).rejects.toThrow();
    expect(imported).toEqual([]);
  });
});
