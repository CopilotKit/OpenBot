import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";

const { INSTALL_BLURB, SetupProgress, plainInstallSteps } = await import(
  "./SetupProgress"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

type Downloads = {
  done?: number;
  total?: number;
  bytes: number;
  size?: number;
};

function installing(downloads: Downloads, running = true) {
  return plainInstallSteps(
    [
      {
        step: "images",
        ok: true,
        running,
        detail: "Downloading local software.",
        downloads,
      },
    ],
    running,
  );
}

test("install progress is the bytes downloaded out of the whole download, and disappears after it", () => {
  const view = render(
    <SetupProgress
      steps={installing({ done: 0, total: 0, bytes: 0 })}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  expect(row.getByText("In progress")).toBeTruthy();
  expect(row.queryByRole("progressbar")).toBeNull();

  for (const [done, bytes, said] of [
    [0, 0, "0 B of 3.4 GB · 5 of 5 items remaining"],
    [1, 1_200_000_000, "1.2 GB of 3.4 GB · 4 of 5 items remaining"],
    [5, 3_400_000_000, "3.4 GB of 3.4 GB · 0 of 5 items remaining"],
  ] as const) {
    view.rerender(
      <SetupProgress
        steps={installing({ done, total: 5, bytes, size: 3_400_000_000 })}
        showElapsed={false}
      />,
    );
    // The bar is the bytes, not the items: one big image is most of the wait.
    const bar = row.getByRole("progressbar", { name: "Download progress" });
    expect(bar.getAttribute("value")).toBe(String(bytes));
    expect(bar.getAttribute("max")).toBe("3400000000");
    expect(bar.getAttribute("aria-valuetext")).toBe(said);
    expect(row.getByText(said).getAttribute("aria-hidden")).toBe("true");
    expect(
      row.queryByText(/elapsed|Downloading local software|agent-bot/),
    ).toBeNull();
  }

  view.rerender(
    <SetupProgress
      steps={installing(
        { done: 5, total: 5, bytes: 3_400_000_000, size: 3_400_000_000 },
        false,
      )}
      showElapsed={false}
    />,
  );
  expect(row.getByText("Complete")).toBeTruthy();
  expect(row.queryByRole("progressbar")).toBeNull();
});

// Reported on 1.0.0-rc.1: a full bar read "1.1 GB of 1.1 GB · 1 of 5 items remaining" while the
// last image was still being unpacked, so a person took the step for done.
test("with every byte in and an item still unpacking, the bar is not full and says it is unpacking", () => {
  const size = 1_100_000_000;
  const view = render(
    <SetupProgress
      steps={installing({ done: 4, total: 5, bytes: size, size })}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  const said = "1.1 GB downloaded · Unpacking the last item";
  let bar = row.getByRole("progressbar", { name: "Download progress" });
  // No value: the indeterminate bar, not a full one.
  expect(bar.hasAttribute("value")).toBe(false);
  expect(bar.getAttribute("aria-valuetext")).toBe(said);
  expect(row.getByText(said)).toBeTruthy();
  expect(row.queryByText(/remaining/)).toBeNull();

  view.rerender(
    <SetupProgress
      steps={installing({ done: 2, total: 5, bytes: size, size })}
      showElapsed={false}
    />,
  );
  bar = row.getByRole("progressbar", { name: "Download progress" });
  expect(bar.hasAttribute("value")).toBe(false);
  expect(
    row.getByText("1.1 GB downloaded · Unpacking the last 3 items"),
  ).toBeTruthy();

  // Bytes still arriving: the bar shows its fraction, as before.
  view.rerender(
    <SetupProgress
      steps={installing({ done: 4, total: 5, bytes: 1_000_000_000, size })}
      showElapsed={false}
    />,
  );
  bar = row.getByRole("progressbar", { name: "Download progress" });
  expect(bar.getAttribute("value")).toBe("1000000000");
  expect(
    row.getByText("1.0 GB of 1.1 GB · 1 of 5 items remaining"),
  ).toBeTruthy();
});

test("a download whose size is not known yet says so, and its bar does not guess", () => {
  const view = render(
    <SetupProgress
      steps={installing({ done: 0, total: 5, bytes: 0 })}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  const said = "Total size not known yet · 5 of 5 items remaining";
  let bar = row.getByRole("progressbar", { name: "Download progress" });
  // No value: an indeterminate bar, which claims no fraction.
  expect(bar.hasAttribute("value")).toBe(false);
  expect(bar.getAttribute("aria-valuetext")).toBe(said);
  expect(row.getByText(said)).toBeTruthy();

  view.rerender(
    <SetupProgress
      steps={installing({ done: 1, total: 5, bytes: 52_000_000 })}
      showElapsed={false}
    />,
  );
  bar = row.getByRole("progressbar", { name: "Download progress" });
  expect(bar.hasAttribute("value")).toBe(false);
  expect(
    row.getByText(
      "52.0 MB downloaded, total size not known yet · 4 of 5 items remaining",
    ),
  ).toBeTruthy();
});

test("a row with bytes and no items says only the bytes", () => {
  const view = render(
    <SetupProgress
      steps={[
        {
          step: "Waiting for the backend",
          ok: true,
          running: true,
          detail: "Updating the backend to 0.16.0-rc.9. Its data stays.",
          downloads: { bytes: 207_000_000, size: 315_000_000 },
        },
      ]}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Waiting for the backend" }),
  );
  expect(
    row.getByText("Updating the backend to 0.16.0-rc.9. Its data stays."),
  ).toBeTruthy();
  expect(row.getByText("207.0 MB of 315.0 MB")).toBeTruthy();
  const bar = row.getByRole("progressbar", { name: "Download progress" });
  expect(bar.getAttribute("value")).toBe("207000000");
  expect(bar.getAttribute("max")).toBe("315000000");
});

test("the install blurb names the parts of OpenBot it installs, in two sentences at most", () => {
  expect(INSTALL_BLURB).toContain(
    "This installs OpenBot on this computer: the front end, the backend, the database, your Bots, and the computers they work on.",
  );
  expect(INSTALL_BLURB.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  // A person installing OpenBot knows its parts, not the product names behind them.
  expect(INSTALL_BLURB).not.toMatch(/—|agent|Intelligence/);
});
