import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "@/components/gallery/decisions";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("ignores a model-supplied transfer id and lets the server reserve the verified file", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    const transfer = {
      attachmentId: "22222222-2222-4222-8222-222222222222",
      ...(path.endsWith("/approve")
        ? { transferId: "11111111-1111-4111-8111-111111111111" }
        : {}),
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: 42,
      sha256: "a".repeat(64),
      status: path.endsWith("/approve") ? "UPLOADED" : "READY",
    };
    return new Response(JSON.stringify({ transfer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const answers: unknown[] = [];
  try {
    const view = render(
      <ApprovalCard
        agentId="jefe-erp"
        args={
          {
            title: "Cargar y ejecutar OCR",
            summary: "Sube el documento verificado.",
            approveLabel: "Cargar y ejecutar OCR",
            rejectLabel: "No cargar",
            workspaceTransfer: {
              attachmentId: "22222222-2222-4222-8222-222222222222",
              transferId: "crossed-model-reservation",
            },
          } as never
        }
        respond={async (answer) => {
          answers.push(answer);
        }}
        result={undefined}
        status="executing"
      />,
    );

    expect(await view.findByText("invoice.pdf")).toBeTruthy();
    const approve = view.getByRole("button", {
      name: "Cargar y ejecutar OCR",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);

    await userEvent.click(approve);
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(requests).toEqual([
      {
        path: "/api/workspace-transfers/preview",
        body: {
          botId: "jefe-erp",
          attachmentId: "22222222-2222-4222-8222-222222222222",
        },
      },
      {
        path: "/api/workspace-transfers/approve",
        body: {
          botId: "jefe-erp",
          attachmentId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
