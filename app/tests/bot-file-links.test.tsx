import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { attachmentAddress } from "@/lib/channels/attachments";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { BotMarkdown, markdownComponents } from "@/lib/markdown";
import { settleReactWork } from "./settle-react-work";

/**
 * A link in a Bot's words to a file on its own computer never reads as a security block.
 *
 * FOUND IN THE WEB APP. Asked for a slide deck, a Bot made historical_mystery.pptx and sent it. The
 * file's card was in the conversation and its Download worked, but the words under it said
 * "Download the presentation [blocked]". The Bot had linked the file by where it sat on its computer,
 * which no browser can open, and the markdown renderer's safety step swaps a link it refuses for its
 * words and " [blocked]". To the person that read as a security error on a file that downloaded fine.
 *
 * Now a link that names a file the conversation was sent is that file, downloaded from the same
 * address the card's Download uses; any other link the chat can't open is its words, nothing more.
 * A dangerous link is still never a link.
 *
 * The conversation is drawn as the chat draws it: the transcript, the app's tools, the send and its
 * answer as the server stores them. The server is faked at the HTTP boundary only.
 */

const ATTACHMENT = "5d1c8a2e-0b7f-4c3e-9a51-6f2b9e4d7c10";
const SENT = JSON.stringify({
  ok: true,
  file: {
    attachmentId: ATTACHMENT,
    name: "historical_mystery.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 35_840,
    url: `/api/attachments/${ATTACHMENT}`,
  },
});

const server = setupServer(
  // The card asks whether its file is still there, at the conversation's attachment address.
  http.head(
    "*/api/v2/organizations/:organizationId/attachments/:id",
    () => new HttpResponse(null, { status: 200 }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A conversation where the Bot made the deck, sent it, and then said `reply`. */
function sentThenSaid(reply: string): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "Make me a short slide deck about a historical mystery.",
    },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_send",
          type: "function",
          function: {
            name: SEND_FILE_TOOL,
            arguments: JSON.stringify({ path: "historical_mystery.pptx" }),
          },
        },
      ],
    },
    { id: "r1", role: "tool", toolCallId: "call_send", content: SENT },
    { id: "a2", role: "assistant", content: reply },
  ];
}

function draw(messages: Message[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CopilotKitProvider>
        <ComputerTools />
        <ChatTranscript messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

function replyIn(view: ReturnType<typeof render>): HTMLElement {
  const row = view.container.querySelector<HTMLElement>(
    '[data-message-id="a2"]',
  );
  if (!row) throw new Error("no row for the reply");
  return row;
}

const DOWNLOAD = attachmentAddress(`/api/attachments/${ATTACHMENT}`);

test("a link to the sent file by its place on the Bot's computer downloads the file", async () => {
  // The forms a Bot writes for a file it made: its workspace path, the path under its computer's
  // folders, and the address some models give a file in their own sandbox.
  for (const href of [
    "historical_mystery.pptx",
    "./decks/historical_mystery.pptx",
    "/tmp/outputs/historical_mystery.pptx",
    "sandbox:/mnt/data/historical_mystery.pptx",
    "file:///home/bot/workspace/historical_mystery.pptx",
  ]) {
    const view = draw(
      sentThenSaid(
        `Here it is. [Download the presentation](${href}) to open it in PowerPoint.`,
      ),
    );
    await settleReactWork();
    const reply = replyIn(view);
    expect(reply.textContent).not.toContain("[blocked]");
    const link = [...reply.querySelectorAll("a")].find(
      (each) => each.textContent === "Download the presentation",
    );
    expect(link?.getAttribute("href"), href).toBe(DOWNLOAD);
    // Saved under its own name, as the card's Download saves it.
    expect(link?.getAttribute("download")).toBe("historical_mystery.pptx");
    cleanup();
  }
});

test("a link to a file the conversation was never sent is its words, with no marker", async () => {
  for (const href of [
    "notes/draft.pptx",
    "sandbox:/mnt/data/other.pptx",
    "file:///Users/bot/other.pptx",
  ]) {
    const view = draw(
      sentThenSaid(`I also kept [the first draft](${href}) on my computer.`),
    );
    await settleReactWork();
    const reply = replyIn(view);
    expect(reply.textContent).toContain(
      "I also kept the first draft on my computer.",
    );
    expect(reply.textContent).not.toContain("[blocked]");
    expect(reply.querySelector("a")).toBeNull();
    cleanup();
  }
});

test("a dangerous link is never a link, even when it names the sent file", async () => {
  for (const markdown of [
    "[Open it](javascript:alert(1))",
    "[Open it](javascript:alert('historical_mystery.pptx'))",
    "[Open it](vbscript:msgbox)",
    "[Open it](data:text/html;base64,PHNjcmlwdD4=)",
    '<a href="javascript:alert(1)">Open it</a>',
  ]) {
    const view = draw(sentThenSaid(markdown));
    await settleReactWork();
    const reply = replyIn(view);
    expect(reply.textContent).toContain("Open it");
    expect(reply.textContent).not.toContain("[blocked]");
    for (const anchor of reply.querySelectorAll("a"))
      expect(anchor.getAttribute("href") ?? "").not.toMatch(
        /^(javascript|vbscript|data|file):/i,
      );
    expect(reply.querySelector("a")).toBeNull();
    cleanup();
  }
});

test("in a group, where the files ride on the reply, the link is the file too", async () => {
  const view = render(
    <BotMarkdown
      components={markdownComponents}
      files={[
        {
          name: "historical_mystery.pptx",
          url: `/api/attachments/${ATTACHMENT}`,
        },
      ]}
    >
      {"[Download the presentation](historical_mystery.pptx)"}
    </BotMarkdown>,
  );
  await settleReactWork();
  const link = view.getByRole("link", { name: "Download the presentation" });
  expect(link.getAttribute("href")).toBe(DOWNLOAD);
  expect(link.getAttribute("download")).toBe("historical_mystery.pptx");
});

test("on any surface that draws a Bot's words, a link nothing can open is plain words", async () => {
  // No conversation around it, so no files to match: the words stay, nothing marks them.
  const view = render(
    <BotMarkdown components={markdownComponents}>
      {"See [the report](reports/august.pdf) and [this](https://example.com)."}
    </BotMarkdown>,
  );
  await settleReactWork();
  expect(view.container.textContent).toBe("See the report and this.");
  const links = view.container.querySelectorAll("a");
  expect(links.length).toBe(1);
  expect(links[0]?.getAttribute("href")).toBe("https://example.com/");
});
