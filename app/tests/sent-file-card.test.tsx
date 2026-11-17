import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { attachmentAddress } from "@/lib/channels/attachments";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { approvalInboxResponse } from "./approvals-api";

/**
 * A file a Bot sent from its computer, as the conversation draws it, live and after a reload.
 *
 * The server stores the file as an attachment of the conversation and answers `computer_send_file`
 * with it: `{ ok: true, file: { attachmentId, name, mimeType, sizeBytes, url } }`. That answer is
 * what the stored thread keeps, so a reopened conversation draws the card from it alone. These draw
 * the renderer the app registers for the tool, which is what the conversation calls, with answers in
 * exactly that shape, against a server that answers the attachment's address as the real one does:
 * 200 while the file is there, 404 once it is gone or for somebody who is not in the conversation.
 */

type Registered = Parameters<typeof ReactCoreV2.useFrontendTool>[0];
const registered: Registered[] = [];
const useCopilotKitSpy = spyOn(ReactCoreV2, "useCopilotKit").mockImplementation(
  () => ({ copilotkit: { stopAgent: () => undefined } }) as never,
);
const useFrontendToolSpy = spyOn(
  ReactCoreV2,
  "useFrontendTool",
).mockImplementation((tool) => {
  if (!registered.some((entry) => entry.name === tool.name))
    registered.push(tool as unknown as Registered);
});

const THERE = "7f1c2a9e-0b5d-4c41-9a37-2f8e6d4b1c01";
const PICTURE = "a3d94b10-6e2f-4f8a-b0c7-91e5d2c84f22";
const GONE = "c0ffee00-1234-4abc-8def-001122334455";
const probed: string[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  // An origin, so a relative `src` resolves and a picture is not reported broken before it draws.
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const path = String(input);
    {
      const approvals = approvalInboxResponse(path, { requests: [] });
      if (approvals) return approvals;
    }
    if (path.includes("/attachments/")) {
      probed.push(`${init?.method ?? "GET"} ${path}`);
      return path.includes(GONE)
        ? Response.json({ code: "NOT_FOUND" }, { status: 404 })
        : new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = originalFetch;
  useCopilotKitSpy.mockRestore();
  useFrontendToolSpy.mockRestore();
  GlobalRegistrator.unregister();
});

function withQueries(ui: ReactElement) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queries}>{ui}</QueryClientProvider>,
  );
}

/** One `computer_send_file` call, drawn by the renderer the app registered for it. */
function drawSend(path: string, answer: unknown) {
  if (!registered.some((entry) => entry.name === SEND_FILE_TOOL)) {
    withQueries(<ComputerTools />);
    cleanup();
  }
  const tool = registered.find((entry) => entry.name === SEND_FILE_TOOL);
  if (!tool?.render) throw new Error("computer_send_file draws nothing.");
  const draw = tool.render as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement;
  return withQueries(
    draw({
      name: SEND_FILE_TOOL,
      toolCallId: `send-${path}`,
      args: { path },
      status: "complete",
      result: JSON.stringify(answer),
    }),
  );
}

const sent = (file: {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}) => ({
  ok: true,
  file: { ...file, url: `/api/attachments/${file.attachmentId}` },
});

test("a CSV the Bot sent is a card with its name, kind, size and a download of the stored file", async () => {
  const view = drawSend(
    "reports/revenue.csv",
    sent({
      attachmentId: THERE,
      name: "revenue.csv",
      mimeType: "text/csv",
      sizeBytes: 31_744,
    }),
  );

  const card = within(
    await view.findByRole("figure", { name: "File from the Bot: revenue.csv" }),
  );
  expect(card.getByText("revenue.csv")).toBeTruthy();
  expect(card.getByText("CSV · 31 KB")).toBeTruthy();
  // A link drawn as the app's own outline button, so it is announced as one.
  const download = card.getByRole("button", { name: "Download revenue.csv" });
  const address = attachmentAddress(`/api/attachments/${THERE}`);
  expect(download.getAttribute("href")).toBe(address);
  expect(download.getAttribute("download")).toBe("revenue.csv");
  // Not a picture, so nothing opens in the page.
  expect(view.container.querySelector("img")).toBeNull();
  // A document is asked whether it is still there, at the conversation's own address.
  await waitFor(() => expect(probed).toContain(`HEAD ${address}`));
});

test("a picture the Bot sent shows itself in the card and opens full size", async () => {
  const view = drawSend(
    "charts/q3.png",
    sent({
      attachmentId: PICTURE,
      name: "q3.png",
      mimeType: "image/png",
      sizeBytes: 2_411_724,
    }),
  );

  const card = within(
    await view.findByRole("figure", { name: "File from the Bot: q3.png" }),
  );
  expect(card.getByText("PNG image · 2.3 MB")).toBeTruthy();
  expect(card.getByRole("button", { name: "Open q3.png" })).toBeTruthy();
  expect(card.getByRole("img", { name: "q3.png" }).getAttribute("src")).toBe(
    attachmentAddress(`/api/attachments/${PICTURE}`),
  );
});

test("a sent file that is gone says so in its own name instead of offering a download", async () => {
  const view = drawSend(
    "notes.md",
    sent({
      attachmentId: GONE,
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 820,
    }),
  );

  const note = await view.findByRole("note");
  expect(note.textContent).toContain("notes.md");
  expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
});

test("a file that could not be sent is one line with the reason, and no card", async () => {
  const reason =
    "budget.xlsx can't be sent. Bots can send images (PNG, JPEG, GIF, WebP), PDFs, and text, Markdown, CSV or JSON files.";
  const view = drawSend("budget.xlsx", { ok: false, refused: true, reason });

  expect(await view.findByText("Blocked: Send a file")).toBeTruthy();
  // The sentence names the file, so the line does not say the name twice.
  expect(view.getByText(reason)).toBeTruthy();
  expect(view.queryByRole("figure")).toBeNull();
  expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
});
