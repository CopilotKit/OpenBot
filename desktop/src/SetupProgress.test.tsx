import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";

const { INSTALL_BLURB, SetupProgress, plainInstallSteps } = await import(
  "./SetupProgress"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  setSystemTime();
});
afterAll(() => GlobalRegistrator.unregister());

type Downloads = {
  done?: number;
  total?: number;
  bytes: number;
  size?: number;
  bytesPerSecond?: number;
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

test("install progress is the bytes and the parts after them, and disappears after it", () => {
  const view = render(
    <SetupProgress
      steps={installing({ done: 0, total: 0, bytes: 0 })}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  // Running, it says how far along the install is.
  expect(row.getByText("Step 2 of 4")).toBeTruthy();
  expect(row.queryByRole("progressbar")).toBeNull();

  for (const [done, bytes, said] of [
    [0, 0, "0 B of 3.4 GB · 5 of 5 parts left"],
    [1, 1_200_000_000, "1.2 GB of 3.4 GB · 4 of 5 parts left"],
    [5, 3_400_000_000, "3.4 GB of 3.4 GB · 0 of 5 parts left"],
  ] as const) {
    view.rerender(
      <SetupProgress
        steps={installing({ done, total: 5, bytes, size: 3_400_000_000 })}
        showElapsed={false}
      />,
    );
    // The bytes are most of the bar, and the parts finishing the rest: one big image is most of
    // the wait.
    const bar = row.getByRole("progressbar", { name: "Download progress" });
    expect(Number(bar.getAttribute("value"))).toBeCloseTo(
      0.8 * (bytes / 3_400_000_000) + 0.2 * (done / 5),
      3,
    );
    expect(bar.getAttribute("max")).toBe("1");
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

// The rest of OpenBot downloads alongside step 2. Said as its own row at the same time, the Install
// step read "Step 2 of 4" and "Step 3 of 4" in progress at once on a live Windows run.
test("the rest of OpenBot is the Install list's third step, in progress only once the second is done", () => {
  const rest = { bytes: 400_000_000, size: 1_600_000_000 };
  const own = {
    step: "images",
    ok: true,
    detail: "Downloading local software.",
    downloads: { done: 1, total: 5, bytes: 1_200_000_000, size: 3_400_000_000 },
  };
  const said = (rows: ReturnType<typeof plainInstallSteps>) =>
    rows.map(
      (row) =>
        `${row.step} | ${row.running ? `Step ${row.position?.at} of 4` : row.ok ? "Complete" : "Failed"}`,
    );
  expect(
    said(plainInstallSteps([{ ...own, running: true }], true, null, rest)),
  ).toEqual(["Downloading OpenBot | Step 2 of 4"]);
  const done = plainInstallSteps(
    [{ ...own, running: false }],
    false,
    null,
    rest,
  );
  expect(said(done)).toEqual([
    "Downloading OpenBot | Complete",
    "Downloading the rest of OpenBot | Step 3 of 4",
  ]);
  expect(done[1]?.downloads).toEqual(rest);
  // A failed install says its failure: nothing after it is in progress.
  expect(
    said(
      plainInstallSteps(
        [{ ...own, running: false, ok: false }],
        false,
        null,
        rest,
      ),
    ),
  ).toEqual(["Downloading OpenBot | Failed"]);
});

// Reported on 1.0.0-rc.1: a full bar read "1.1 GB of 1.1 GB · 1 of 5 parts left" while the
// last image was still being unpacked, so a person took the step for done. On Windows F the same
// line sat under a full bar with no time so far and no time left, its last bytes uncounted, and
// looked stuck.
test("with every byte in and parts still unpacking, the bar is never full, keeps moving, and says which part", () => {
  const size = 1_100_000_000;
  const start = new Date("2026-11-10T03:05:00Z");
  setSystemTime(start);
  const at = (seconds: number) =>
    setSystemTime(new Date(start.getTime() + seconds * 1000));
  // As Windows F reported it: the last of the bytes not counted, and two of five parts left.
  const windowsF = { done: 3, total: 5, bytes: 1_099_000_000, size };
  const view = render(<SetupProgress steps={installing(windowsF)} />);
  const row = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  const value = () =>
    Number(
      row
        .getByRole("progressbar", { name: "Download progress" })
        .getAttribute("value"),
    );
  expect(row.getByText("1.1 GB downloaded")).toBeTruthy();
  expect(
    row.getByText(/^Unpacking OpenBot \(4 of 5\)\. Less than a minute left\.$/),
  ).toBeTruthy();
  expect(row.getByText(/elapsed/)).toBeTruthy();
  const first = value();
  expect(first).toBeLessThan(0.95);
  // The part unpacking now moves the bar as time passes, and never fills it.
  at(10);
  view.rerender(<SetupProgress steps={installing(windowsF)} />);
  const later = value();
  expect(later).toBeGreaterThan(first);
  expect(later).toBeLessThan(1);
  // A part finishes: on to the next, further along.
  at(14);
  view.rerender(<SetupProgress steps={installing({ ...windowsF, done: 4 })} />);
  expect(row.getByText(/^Unpacking OpenBot \(5 of 5\)\./)).toBeTruthy();
  expect(value()).toBeGreaterThan(later);
  expect(value()).toBeLessThan(1);
  // Well past when the last part should have finished, it says so instead of a time.
  at(90);
  view.rerender(<SetupProgress steps={installing({ ...windowsF, done: 4 })} />);
  expect(
    row.getByText(
      "Unpacking OpenBot (5 of 5). Taking longer than usual, still working.",
    ),
  ).toBeTruthy();
  expect(value()).toBeLessThan(1);

  // A report that counts its bytes short for a moment does not take it back to downloading: on
  // Windows F the row read "Downloading OpenBot. About 2 minutes left." for a few seconds between
  // "Unpacking OpenBot (3 of 5)" and "(5 of 5)".
  const unpacked = value();
  view.rerender(
    <SetupProgress
      steps={installing({
        done: 4,
        total: 5,
        bytes: 1_000_000_000,
        size,
        bytesPerSecond: 9_000_000,
      })}
    />,
  );
  expect(row.getByText(/^Unpacking OpenBot \(5 of 5\)\./)).toBeTruthy();
  expect(row.queryByText(/^Downloading OpenBot\./)).toBeNull();
  expect(row.queryByText(/minutes left/)).toBeNull();
  expect(value()).toBeGreaterThanOrEqual(unpacked);

  // A download whose bytes are still arriving: their share of the bar, and the parts left.
  cleanup();
  const arriving = render(
    <SetupProgress
      steps={installing({ done: 4, total: 5, bytes: 1_000_000_000, size })}
    />,
  );
  expect(
    Number(
      arriving
        .getByRole("progressbar", { name: "Download progress" })
        .getAttribute("value"),
    ),
  ).toBeCloseTo(0.8 * (1 / 1.1) + 0.2 * 0.8, 3);
  expect(
    arriving.getByText("1.0 GB of 1.1 GB · 1 of 5 parts left"),
  ).toBeTruthy();
});

/*
 * Windows F, at the start of a download: "About 164011 minutes left" for its first 538 bytes. No
 * time left until its speed is steady, 3 seconds and 5 MB in. Then, when the transfer ended with
 * some bytes never counted, "1.1 GB of 1.1 GB · 3 of 5 parts left" sat for ten seconds with no
 * time left and no word of unpacking. Nothing arriving any more and 90% in counts as all in.
 */
test("a download says no time left until its speed is steady, and unpacks once nothing more arrives", () => {
  const size = 1_100_000_000;
  const start = new Date("2026-11-10T04:37:00Z");
  setSystemTime(start);
  const at = (seconds: number) =>
    setSystemTime(new Date(start.getTime() + seconds * 1000));
  const first = { done: 0, total: 5, bytes: 538, size, bytesPerSecond: 1_076 };
  const view = render(<SetupProgress steps={installing(first)} />);
  const row = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  expect(row.queryByText(/minutes? left/)).toBeNull();
  // A second in, a burst: still not steady.
  at(1);
  view.rerender(
    <SetupProgress
      steps={installing({
        ...first,
        bytes: 40_000_000,
        bytesPerSecond: 80_000_000,
      })}
    />,
  );
  expect(row.queryByText(/left\.$/)).toBeNull();
  // Steady: a time from its speed.
  at(4);
  view.rerender(
    <SetupProgress
      steps={installing({
        ...first,
        bytes: 300_000_000,
        bytesPerSecond: 70_000_000,
      })}
    />,
  );
  expect(row.getByText(/^Less than a minute left\.$/)).toBeTruthy();
  // The transfer ends a little short of its total, two parts in: unpacking the third, with a time.
  at(20);
  view.rerender(
    <SetupProgress
      steps={installing({
        ...first,
        done: 2,
        bytes: 1_060_000_000,
        bytesPerSecond: 0,
      })}
    />,
  );
  expect(
    row.getByText(/^Unpacking OpenBot \(3 of 5\)\. Less than a minute left\.$/),
  ).toBeTruthy();
  expect(row.getByText("1.1 GB downloaded")).toBeTruthy();
});

test("a download whose size is not known yet says so, and its bar does not guess", () => {
  const view = render(
    <SetupProgress
      steps={installing({ done: 0, total: 5, bytes: 0 })}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  const said = "Total size not known yet · 5 of 5 parts left";
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
      "52.0 MB downloaded, total size not known yet · 4 of 5 parts left",
    ),
  ).toBeTruthy();
});

const UPDATING = "Updating OpenBot. Your Bots and data stay as they are.";

test("a row with bytes and no items says only the bytes", () => {
  const view = render(
    <SetupProgress
      steps={[
        {
          step: "Getting OpenBot ready",
          ok: true,
          running: true,
          detail: UPDATING,
          downloads: { bytes: 207_000_000, size: 315_000_000 },
        },
      ]}
      showElapsed={false}
    />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Getting OpenBot ready" }),
  );
  expect(row.getByText(UPDATING)).toBeTruthy();
  expect(row.getByText("207.0 MB of 315.0 MB")).toBeTruthy();
  const bar = row.getByRole("progressbar", { name: "Download progress" });
  expect(Number(bar.getAttribute("value"))).toBeCloseTo(207 / 315, 3);
  expect(bar.getAttribute("max")).toBe("1");
});

test("the install blurb names the parts of OpenBot it installs, in two sentences at most", () => {
  expect(INSTALL_BLURB).toContain(
    "This installs OpenBot on this computer: the app, its database, your Bots, and the computers they work on.",
  );
  expect(INSTALL_BLURB.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  // A person installing OpenBot knows its parts, not the product names behind them, and how long
  // the wait is.
  expect(INSTALL_BLURB).not.toMatch(
    /—|agent|Intelligence|back ?end|front ?end/i,
  );
  expect(INSTALL_BLURB).toContain("about 10 minutes");
});
