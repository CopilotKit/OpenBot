import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { GroupChat } from "@/components/channels/group-chat";
import { attachmentAddress } from "@/lib/channels/attachments";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { answerGroupRead } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A file a Bot sends from its computer in a conversation with several Bots.
 *
 * The server stores it as an attachment of the group, so every member can open it, but a group
 * keeps only each Bot's words of a turn: the reply read "Created and sent team-budget.csv" with no
 * card, and its name in the words was the only way to the file. The reply now carries the files
 * (`files` on the message, the API's Attachment), and the group draws each as the card a
 * conversation with one Bot draws.
 *
 * The file is the real run's (test-20261117-71): its stored attachment and the words the Bot wrote
 * about it. The group's reads and the attachment address are answered at the HTTP boundary as the
 * server answers them; everything above is the real GroupChat.
 */

const CHANNEL = "group-1";
const PA = "personal-assistant";
const BUDGET = "budget-buddy";
const ATTACHMENT = "bffdecae-4a19-48ea-b363-d1842fa33791";
const WORDS = `Created and sent [team-budget.csv](/api/attachments/${ATTACHMENT}) with three made-up budget lines.`;

let reads = 0;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (url.pathname === ME_PATH)
      return meResponse({
        user: { id: "alex", role: "user", email: "alex@example.test" },
      });
    const bots = answerBotsList(url, init, {
      visible: [
        { id: PA, name: "Personal Assistant", avatarSeed: "personal" },
        { id: BUDGET, name: "Budget Buddy", avatarSeed: BUDGET },
      ],
    });
    if (bots) return bots;
    // The card asks whether its file is still there, at the conversation's attachment address.
    if (url.pathname.endsWith(`/attachments/${ATTACHMENT}`))
      return new Response(null, { status: 200 });
    if (url.pathname.endsWith("/messages")) reads += 1;
    const read = answerGroupRead(url, init, CHANNEL, {
      bots: [
        { id: PA, name: "Personal Assistant" },
        { id: BUDGET, name: "Budget Buddy" },
      ],
      // Priya asked; Alex, reading here, is the other person in the group.
      people: [
        {
          userId: "priya",
          email: "priya@example.test",
          name: "Priya",
          creator: true,
        },
        {
          userId: "alex",
          email: "alex@example.test",
          name: "Alex",
          creator: false,
        },
      ],
      messages: [
        {
          id: "m-1",
          ownerUserId: "priya",
          agentId: null,
          text: "@Personal Assistant write a small CSV named team-budget.csv with three made-up budget lines and send it here.",
          status: "completed",
          createdAt: "2026-11-17T20:57:20.000Z",
        },
        {
          id: `m-1:${PA}`,
          ownerUserId: "priya",
          agentId: PA,
          text: WORDS,
          status: "completed",
          createdAt: "2026-11-17T20:57:40.000Z",
          files: [
            {
              id: ATTACHMENT,
              name: "team-budget.csv",
              mimeType: "text/csv",
              sizeBytes: 84,
            },
          ],
        },
      ],
    });
    if (read) return read;
    const approvals = approvalInboxResponse(url.pathname, {
      enabled: true,
      requests: [],
      rules: [],
      teamRules: [],
      questions: [],
    });
    if (approvals) return approvals;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function conversation() {
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupChat channelId={CHANNEL} />
    </QueryClientProvider>,
  );
}

const CARD = 'figure[aria-label="File from the Bot: team-budget.csv"]';

test("another person in the group sees the file the Bot sent as its card under the Bot's words, now and on reload", async () => {
  // A reload reads the transcript again from the server and draws it from scratch.
  for (let pass = 0; pass < 2; pass += 1) {
    const before = reads;
    const view = conversation();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() =>
      expect(view.container.querySelector(CARD)).not.toBeNull(),
    );
    const card = view.container.querySelector(CARD) as HTMLElement;
    expect(card.textContent).toContain("CSV · 84 bytes");
    const download = within(card).getByRole("button", {
      name: "Download team-budget.csv",
    });
    expect(download.getAttribute("href")).toBe(
      attachmentAddress(`/api/attachments/${ATTACHMENT}`),
    );
    // Inside the Bot's own reply, after its words.
    const reply = view.container.querySelector(
      `[data-speaker="${PA}"]`,
    ) as HTMLElement;
    expect(reply.contains(card)).toBe(true);
    const words = within(reply).getByRole("link", { name: "team-budget.csv" });
    expect(
      words.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    cleanup();
    queryClient.clear();
  }
});

test("the file's name in the group Bot's words downloads it from the conversation's address", async () => {
  const view = conversation();
  const link = await view.findByRole("link", { name: "team-budget.csv" });
  expect(link.getAttribute("href")).toBe(
    attachmentAddress(`/api/attachments/${ATTACHMENT}`),
  );
  expect(link.hasAttribute("download")).toBe(true);
  expect(link.getAttribute("target")).toBeNull();
});
