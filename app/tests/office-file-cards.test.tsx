import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ACCEPTED_FILE_TYPES } from "@openbot/shared/attachments";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FILE_TYPE_ICONS } from "@/components/channels/file-icon";
import { SentFileCard } from "@/components/channels/sent-file-card";
import { attachmentUrl } from "@/lib/channels/attachments";
import { kindLabel } from "@/lib/computers/sent-file";
import { attachmentPath } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Word, Excel or PowerPoint file a Bot sends reads as what it is on its card: its own icon and the
 * kind named in the one list of files OpenBot takes, with its size and a Download for the file.
 *
 * The card asks whether the file is still there (a HEAD to its address), so `fetch` is answered here
 * with "still there", as in transcript-attachments.test.tsx.
 */
let probes: string[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    probes.push(String(input));
    return Promise.resolve().then(() => new Response(null, { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  probes = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const OFFICE = [
  {
    name: "Q3 budget.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 14_336,
    label: "Excel workbook · 14 KB",
    icon: "tabler-icon-file-type-xls",
  },
  {
    name: "launch memo.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 48_128,
    label: "Word document · 47 KB",
    icon: "tabler-icon-file-type-docx",
  },
  {
    name: "board deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 3_250_586,
    label: "PowerPoint presentation · 3.1 MB",
    icon: "tabler-icon-file-type-ppt",
  },
] as const;

for (const file of OFFICE) {
  test(`a Bot's ${file.name} reads as its kind, with its icon and a download`, async () => {
    const attachmentId = `att-${file.icon}`;
    const { container, getByRole, getByText } = render(
      <SentFileCard
        file={{
          attachmentId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          url: attachmentUrl(attachmentId),
        }}
      />,
    );
    await waitFor(() => expect(probes).toHaveLength(1));

    expect(getByRole("figure", { name: `File from the Bot: ${file.name}` }));
    expect(getByText(file.label)).toBeTruthy();
    expect(container.querySelector(`svg.${file.icon}`)).not.toBeNull();
    const download = getByRole("button", { name: `Download ${file.name}` });
    expect(download.getAttribute("href")).toBe(attachmentPath(attachmentId));
    expect(download.getAttribute("download")).toBe(file.name);
    // An Office file is never drawn in the page: no picture, only the card.
    expect(container.querySelector("img")).toBeNull();
  });
}

test("every kind of file OpenBot takes has a name of its own and an icon of its own", () => {
  for (const type of ACCEPTED_FILE_TYPES) {
    expect(FILE_TYPE_ICONS[type.mimeType]).toBeDefined();
    if (type.kind === "document")
      expect(kindLabel(type.mimeType, `file.${type.extensions[0]}`)).toBe(
        type.name,
      );
  }
});
