import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";

const { INSTALL_BLURB, SetupProgress, plainInstallSteps } = await import(
  "./SetupProgress"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

test("item progress advances as pulls finish and disappears after the download", () => {
  function steps(done: number, total: number, running = true) {
    return plainInstallSteps(
      [
        {
          step: "images",
          ok: true,
          running,
          detail: "Downloading local software.",
          downloads: { done, total },
        },
      ],
      running,
    );
  }

  const view = render(
    <SetupProgress steps={steps(0, 0)} showElapsed={false} />,
  );
  const row = within(
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  expect(row.getByText("In progress")).toBeTruthy();
  expect(row.queryByRole("progressbar")).toBeNull();

  for (const done of [0, 2, 7, 8]) {
    view.rerender(<SetupProgress steps={steps(done, 8)} showElapsed={false} />);
    const bar = row.getByRole("progressbar", {
      name: "Item download progress",
    });
    expect(bar.getAttribute("value")).toBe(String(done));
    expect(bar.getAttribute("max")).toBe("8");
    const remaining = `${8 - done} of 8 items remaining`;
    expect(bar.getAttribute("aria-valuetext")).toBe(remaining);
    expect(row.getByText(remaining).getAttribute("aria-hidden")).toBe("true");
    expect(
      row.queryByText(
        /elapsed|Downloading local software|OpenBot server|agent-bot/,
      ),
    ).toBeNull();
  }

  view.rerender(
    <SetupProgress steps={steps(8, 8, false)} showElapsed={false} />,
  );
  expect(row.getByText("Complete")).toBeTruthy();
  expect(row.queryByRole("progressbar")).toBeNull();
});

test("the install blurb says the full platform is installed, in two sentences at most", () => {
  expect(INSTALL_BLURB).toContain("full OpenBot platform");
  expect(INSTALL_BLURB).toContain(
    "the app, the server, your Bots, and the computers they work on.",
  );
  expect(INSTALL_BLURB.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  expect(INSTALL_BLURB).not.toMatch(/—|agent/);
});
