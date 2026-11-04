import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";

const {
  INSTALL_BLURB,
  SetupProgress,
  downloadsSummary,
  formatDownloadBytes,
  plainInstallSteps,
} = await import("./SetupProgress");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const downloads = {
  done: 3,
  total: 9,
  bytes: 1_234_000_000,
  bytesPerSecond: 24_500_000,
  pulling: [
    { name: "OpenBot server", bytes: 412_300_000, size: 980_000_000 },
    { name: "agent-bot", bytes: 3_100_000 },
  ],
};

test("the summary says how much is downloaded, how fast, and how many images are done", () => {
  expect(downloadsSummary(downloads)).toBe(
    "1.2 GB downloaded · 24.5 MB/s · 3 of 9 images done",
  );
  // No speed until there is enough of a window to measure one.
  expect(
    downloadsSummary({ ...downloads, bytes: 0, bytesPerSecond: undefined }),
  ).toBe("3 of 9 images done");
  expect(formatDownloadBytes(512)).toBe("512 B");
});

test("the Installing OpenBot row lists the images downloading now", () => {
  const rows = plainInstallSteps(
    [
      { step: "engine", ok: true, detail: "Docker is answering." },
      {
        step: "images",
        ok: true,
        running: true,
        detail: "Downloading local software.",
        downloadBytes: downloads.bytes,
        downloads,
      },
    ],
    true,
  );
  const view = render(<SetupProgress steps={rows} />);
  const row = within(
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  expect(row.getByText("Downloading local software.")).toBeTruthy();
  expect(
    row.getByText("1.2 GB downloaded · 24.5 MB/s · 3 of 9 images done"),
  ).toBeTruthy();
  // The overall figure is in the summary, not repeated after the sentence.
  expect(row.queryByText(/Downloading local software\. 1\.2 GB/)).toBeNull();
  const pulling = within(row.getByRole("list", { name: "Downloading now" }));
  const server = within(
    pulling.getByRole("listitem", { name: "OpenBot server" }),
  );
  expect(server.getByText("412.3 MB of 980.0 MB")).toBeTruthy();
  const bot = within(pulling.getByRole("listitem", { name: "agent-bot" }));
  expect(bot.getByText("3.1 MB")).toBeTruthy();
});

test("an image with no bytes counted yet is listed by name alone", () => {
  const view = render(
    <SetupProgress
      steps={[
        {
          step: "Installing OpenBot",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads: {
            done: 0,
            total: 2,
            bytes: 0,
            pulling: [{ name: "pgvector", bytes: 0 }],
          },
        },
      ]}
    />,
  );
  // Some engines never count bytes for a pull, so "0 B" or "Starting" could sit there for minutes.
  expect(view.getByRole("listitem", { name: "pgvector" }).textContent).toBe(
    "pgvector",
  );
});

test("the download list goes away once the row is no longer running", () => {
  const view = render(
    <SetupProgress
      steps={[
        {
          step: "Installing OpenBot",
          ok: true,
          running: false,
          detail: "Local software is installed.",
          downloads,
        },
      ]}
    />,
  );
  expect(view.queryByRole("list", { name: "Downloading now" })).toBeNull();
  expect(view.queryByText(/images done/)).toBeNull();
});

test("the install blurb says the full platform is installed, in two sentences at most", () => {
  expect(INSTALL_BLURB).toContain("full OpenBot platform");
  expect(INSTALL_BLURB).toContain("Intelligence");
  expect(INSTALL_BLURB.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  expect(INSTALL_BLURB).not.toMatch(/—|agent/);
});
