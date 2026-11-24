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
import userEvent from "@testing-library/user-event";

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

/**
 * Behind the AI step on Windows G, a setup not started on a C: too short was a red "Setup stopped"
 * card with the troubleshooting logs. The background row says it as paused, in the account step's
 * words, with Try again, and with no time running on.
 */
test("the background row says a setup paused for room calmly, with Try again", async () => {
  const { installingBehind } = await import("./SetupProgress");
  const said =
    "This computer has 13.9 GB of free space on drive C:, and OpenBot needs 40 GB. Free up some space, then Try again.";
  let looked = 0;
  const row = installingBehind({
    steps: [],
    installing: false,
    installed: true,
    since: Date.now() - 200_000,
    backEnd: {
      at: "setup",
      running: true,
      stopped: false,
      ready: false,
      detail: null,
      download: null,
      since: Date.now() - 60_000,
      held: said,
      tryAgain: () => {
        looked += 1;
      },
    },
  });
  expect(row?.paused).toBe(true);
  const view = render(
    <SetupProgress steps={row ? [row] : []} label="Background install" />,
  );
  const item = within(
    view.getByRole("listitem", {
      name: "Preparing OpenBot",
    }),
  );
  expect(item.getByText("Step 3 of 4 · Paused")).toBeTruthy();
  expect(item.getByText(said)).toBeTruthy();
  expect(item.queryByText(/elapsed/)).toBeNull();
  expect(view.container.querySelector(".step-spinner")).toBeNull();
  await userEvent.click(item.getByRole("button", { name: "Try again" }));
  expect(looked).toBe(1);
});

/*
 * At most one spinner on the screen: a quiet list (the background install in the sidebar, the
 * Start's rows under its journey) marks its running row without one, since something else on the
 * screen is the wait. Everything else a row says is as it was.
 */
test("a quiet list marks its running row without a spinner, and says the rest as before", () => {
  const steps = [
    {
      step: "install",
      ok: true,
      running: true,
      detail: "Setting up OpenBot on this computer.",
      position: { at: 3, of: 4 },
      startedAt: Date.now() - 5_000,
    },
  ];
  const loud = render(<SetupProgress steps={steps} label="Loud" />);
  const spun = loud.getByRole("list", { name: "Loud" });
  expect(spun.querySelector(".step-spinner")).not.toBeNull();
  expect(spun.querySelector(".step-current")).toBeNull();
  const said = spun.querySelector(".step-status")?.textContent;
  cleanup();

  const quiet = render(<SetupProgress steps={steps} label="Quiet" quiet />);
  const marked = quiet.getByRole("list", { name: "Quiet" });
  expect(marked.querySelector(".step-spinner")).toBeNull();
  expect(marked.querySelector(".step-current")).not.toBeNull();
  // Marked as the one it is on, not as done or failed.
  expect(marked.querySelector(".mark")?.className).toBe("mark active");
  expect(marked.querySelector(".step-status")?.textContent).toBe(said);
  expect(marked.textContent).toContain("Step 3 of 4");
  expect(marked.textContent).toContain("Setting up OpenBot on this computer.");
});

test("a quiet list still shows a finished row's tick and a waiting row's mark", () => {
  const view = render(
    <SetupProgress
      quiet
      steps={[
        { step: "prepare", ok: true, running: false, detail: "" },
        { step: "install", ok: true, running: true, waiting: true, detail: "" },
      ]}
    />,
  );
  expect(view.container.querySelector(".step-spinner")).toBeNull();
  expect(view.container.querySelector(".step-current")).toBeNull();
  expect(view.container.querySelector(".mark.good")?.textContent).toBe("✓");
  expect(view.container.querySelector(".step-waiting")).not.toBeNull();
});

for (const state of ["running", "waiting", "paused", "failed"] as const) {
  test(`focus leads with the ${state} row and preserves its status and actions`, async () => {
    let retried = 0;
    const steps = [
      { step: "Prepared", ok: true, detail: "" },
      {
        step: "Current operation",
        ok: state !== "failed",
        running: state !== "failed",
        waiting: state === "waiting",
        paused: state === "paused",
        detail: "Directions for this operation.",
        onTryAgain: () => {
          retried += 1;
        },
      },
      { step: "Earlier milestone", ok: true, detail: "" },
      {
        step: "Another failure",
        ok: false,
        detail: "Keep this failure visible.",
      },
      { step: "Next operation", ok: true, pending: true, detail: "" },
    ];
    const view = render(<SetupProgress steps={steps} showElapsed={false} />);
    const original = view.getByRole("listitem", { name: "Current operation" });
    const names = () =>
      view
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label"));
    expect(names()).toEqual(steps.map((step) => step.step));
    view.rerender(
      <SetupProgress steps={steps} showElapsed={false} presentation="focus" />,
    );
    expect(names()).toEqual([
      "Current operation",
      "Prepared",
      "Earlier milestone",
      "Another failure",
      "Next operation",
    ]);
    expect(view.getByRole("listitem", { name: "Current operation" })).toBe(
      original,
    );
    const list = view.getByRole("list", { name: "Setup progress" });
    expect(list.classList.contains("setup-progress-focus")).toBe(true);
    expect(list.getAttribute("aria-live")).toBe("polite");
    const current = within(original);
    expect(
      current.getByText(
        state === "running"
          ? "In progress"
          : state === "waiting"
            ? "Waiting for you"
            : state === "paused"
              ? "Paused"
              : "Failed",
      ),
    ).toBeTruthy();
    expect(current.getByText("Directions for this operation.")).toBeTruthy();
    expect(view.getByText("Keep this failure visible.")).toBeTruthy();
    expect(list.querySelectorAll(".step-spinner").length).toBe(
      state === "running" ? 1 : 0,
    );
    if (state === "paused") {
      await userEvent.click(current.getByRole("button", { name: "Try again" }));
      expect(retried).toBe(1);
    }
    view.rerender(
      <SetupProgress steps={steps} showElapsed={false} presentation="list" />,
    );
    expect(names()).toEqual(steps.map((step) => step.step));
    expect(list.className).toBe("steps");
  });
}

test("milestones preserves all supplied rows and their order with quiet running marks", () => {
  const steps = [
    { step: "Prepared", ok: true, detail: "" },
    {
      step: "Current operation",
      ok: true,
      running: true,
      detail: "Still working.",
    },
  ];
  const view = render(
    <SetupProgress
      steps={steps}
      presentation="milestones"
      quiet
      showElapsed={false}
    />,
  );
  const list = view.getByRole("list", { name: "Setup progress" });
  expect(list.className).toBe("steps setup-milestones");
  expect(
    view.getAllByRole("listitem").map((row) => row.getAttribute("aria-label")),
  ).toEqual(steps.map((step) => step.step));
  expect(list.querySelector(".step-spinner")).toBeNull();
  expect(list.querySelector(".step-current")).not.toBeNull();
});

test("focus keeps other running rows visible with only the leading spinner", () => {
  const view = render(
    <SetupProgress
      presentation="focus"
      showElapsed={false}
      steps={[
        { step: "Optional update", ok: false, note: "Not updated", detail: "" },
        { step: "Prepared", ok: true, detail: "" },
        { step: "Current operation", ok: true, running: true, detail: "" },
        {
          step: "Parallel operation",
          ok: true,
          running: true,
          detail: "Still downloading.",
        },
      ]}
    />,
  );
  expect(view.getAllByRole("listitem")[0]?.getAttribute("aria-label")).toBe(
    "Current operation",
  );
  expect(view.container.querySelectorAll(".step-spinner").length).toBe(1);
  expect(
    within(
      view.getByRole("listitem", { name: "Parallel operation" }),
    ).getByText("In progress"),
  ).toBeTruthy();
  expect(view.getByText("Still downloading.")).toBeTruthy();
});

for (const downloads of [
  { bytes: 52_000_000, done: 1, total: 5 },
  { bytes: 52_000_000, size: 100_000_000, done: 1, total: 5 },
  { bytes: 100_000_000, size: 100_000_000, done: 3, total: 5 },
]) {
  test(`focus preserves download measurements with ${downloads.size ?? "unknown"} total bytes and ${downloads.done} parts done`, () => {
    setSystemTime(new Date("2026-11-10T03:05:00Z"));
    const steps = [
      { step: "Prepared", ok: true, detail: "" },
      ...installing(downloads),
    ];
    const view = render(<SetupProgress steps={steps} showElapsed={false} />);
    const bar = view.getByRole("progressbar");
    const value = bar.getAttribute("value");
    const summary = bar.getAttribute("aria-valuetext");
    const said = view.getByRole("listitem", {
      name: "Downloading OpenBot",
    }).textContent;
    view.rerender(
      <SetupProgress steps={steps} showElapsed={false} presentation="focus" />,
    );
    expect(view.getByRole("progressbar")).toBe(bar);
    expect(bar.getAttribute("value")).toBe(value);
    expect(bar.getAttribute("aria-valuetext")).toBe(summary);
    expect(view.getAllByRole("listitem")[0]?.textContent).toBe(said);
  });
}
