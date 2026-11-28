import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A table a Bot writes, downloaded or copied, keeps its links.
 *
 * Seen on 2026-11-24 (1.2.0-rc.4): asked for a table with clickable links, a Bot drew one; the
 * table's Download as Markdown saved `| Release | OpenBot release notes |`, the link's words with
 * no address, while exporting the whole reply kept `[OpenBot release notes](<https://…>)`. The
 * table's controls read the drawn table's text and nothing else, so every address in it was lost,
 * in the Markdown and the CSV, downloaded or copied.
 *
 * The reply is drawn by the real transcript; the file is what the table's own Download writes.
 */

const RELEASE =
  "https://github.com/CopilotKit/OpenBot/releases/tag/v1.2.0-rc.4";
const DOCS = "https://docs.example.com/guide_(beta)";
// Drawn as a document chip, whose "Doc" beside the name is not part of the link's words.
const PLAN = "https://docs.google.com/document/d/q3-plan";

const REPLY = [
  "Here you go.",
  "",
  "| Item | Link |",
  "|---|---|",
  `| Release | [OpenBot release notes](${RELEASE}) |`,
  `| Guide | See [the guide](<${DOCS}>) first |`,
  `| Plan | [Q3 plan](${PLAN}) |`,
  "| Plain | no link here |",
].join("\n");

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

/** Every file the page hands the browser to save, read back as text. */
let saved: Blob[] = [];
let copied: Record<string, Blob>[] = [];
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  saved = [];
  copied = [];
  URL.createObjectURL = (blob: Blob) => {
    saved.push(blob);
    return "blob:saved";
  };
  URL.revokeObjectURL = () => {};
  class ClipboardItemStub {
    constructor(readonly items: Record<string, Blob>) {}
  }
  Object.assign(globalThis, { ClipboardItem: ClipboardItemStub });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: ClipboardItemStub[]) => {
        for (const item of items) copied.push(item.items);
      },
      writeText: async () => {},
    },
  });
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function drawnReply() {
  const messages: Message[] = [
    { id: "u1", role: "user", content: "A table of links, please." },
    { id: "a1", role: "assistant", content: REPLY },
  ];
  const view = render(<ChatTranscript messages={messages} restoring={false} />);
  await waitFor(() => {
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(4);
  });
  // The links are drawn as links: the export must not change how the table looks.
  const link = await within(document.body).findByRole("link", {
    name: "OpenBot release notes",
  });
  expect(link.getAttribute("href")).toBe(RELEASE);
  return view;
}

async function download(format: "Markdown" | "CSV") {
  fireEvent.click(within(document.body).getByTitle("Download table"));
  fireEvent.click(
    await within(document.body).findByRole("button", { name: format }),
  );
  await waitFor(() => expect(saved).toHaveLength(1));
  return (saved[0] as Blob).text();
}

test("Download as Markdown keeps every link as [words](address)", async () => {
  await drawnReply();
  const markdown = await download("Markdown");
  expect(markdown).toBe(
    [
      "| Item | Link |",
      "| --- | --- |",
      `| Release | [OpenBot release notes](${RELEASE}) |`,
      `| Guide | See [the guide](<${DOCS}>) first |`,
      `| Plan | [Q3 plan](${PLAN}) |`,
      "| Plain | no link here |",
    ].join("\n"),
  );
});

test("Download as CSV keeps each link's address beside its words", async () => {
  await drawnReply();
  const csv = await download("CSV");
  expect(csv).toContain(`Release,OpenBot release notes (${RELEASE})`);
  expect(csv).toContain(`Guide,See the guide (${DOCS}) first`);
  expect(csv).toContain(`Plan,Q3 plan (${PLAN})`);
  expect(csv).toContain("Plain,no link here");
});

test("Copy as Markdown keeps the links too", async () => {
  await drawnReply();
  fireEvent.click(within(document.body).getByTitle("Copy table"));
  fireEvent.click(
    await within(document.body).findByRole("button", { name: "Markdown" }),
  );
  await waitFor(() => expect(copied).toHaveLength(1));
  const item = copied[0] as Record<string, Blob>;
  const text = await (item["text/plain"] as Blob).text();
  expect(text).toContain(`| Release | [OpenBot release notes](${RELEASE}) |`);
  // The rich copy is the table itself, links and all.
  const html = await (item["text/html"] as Blob).text();
  expect(html).toContain(`href="${RELEASE}"`);
});
