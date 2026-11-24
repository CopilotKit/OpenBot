import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import { AGENT_ORB_CSS } from "../../shared/agent-orb";

const { Lockup, Sections, SetupRail } = await import("./Sections");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

/*
 * Every section by name, down the sidebar: the one the window is on is the current step, the ones
 * before it are done, and the ones after it are neither.
 */
test("the sections mark the current one as the step, and tick the ones before it", () => {
  const view = render(<Sections at="AI" />);
  const list = view.getByRole("list", { name: "Setup" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Account",
    "Install",
    "AI",
    "Start",
  ]);
  expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([
    null,
    null,
    "step",
    null,
  ]);
  expect(rows.map((row) => row.className)).toEqual([
    "done",
    "done",
    "current",
    "",
  ]);
  // The mark beside each name is decoration: the name and aria-current say it.
  for (const row of rows)
    expect(
      row.querySelector(".section-mark")?.getAttribute("aria-hidden"),
    ).toBe("true");
});

test("on the first section nothing is done yet", () => {
  const view = render(<Sections at="Account" />);
  const rows = view.getAllByRole("listitem");
  expect(rows[0]?.getAttribute("aria-current")).toBe("step");
  expect(rows.filter((row) => row.classList.contains("done"))).toHaveLength(0);
  expect(rows.filter((row) => row.classList.contains("current"))).toHaveLength(
    1,
  );
});

/*
 * "Set up OpenBot" heads the window only on the first screen, which has no heading of its own.
 * A step with its own heading says it as a line, so each screen has one h1.
 */
test("the sidebar says Set up OpenBot as the heading on the first screen only", () => {
  const first = render(<SetupRail heading label="Where OpenBot runs" />);
  const aside = first.getByRole("complementary", {
    name: "Where OpenBot runs",
  });
  expect(
    within(aside).getByRole("heading", { level: 1, name: "Set up OpenBot" }),
  ).toBeTruthy();
  cleanup();

  const step = render(
    <SetupRail>
      <Sections at="Install" />
    </SetupRail>,
  );
  const rail = step.getByRole("complementary", { name: "Setup" });
  expect(within(rail).queryByRole("heading")).toBeNull();
  expect(rail.querySelector("p.rail-title")?.textContent).toBe(
    "Set up OpenBot",
  );
  // Its rows follow the name and the line: the sections down the side.
  expect(within(rail).getByRole("list", { name: "Setup" })).toBeTruthy();
});

test("the sidebar leads with OpenBot's name, by CopilotKit only where asked", () => {
  const plain = render(<SetupRail />);
  expect(plain.container.querySelector(".lockup")?.textContent).toBe(
    "OpenBot™",
  );
  cleanup();
  const account = render(<SetupRail byCopilotKit />);
  expect(account.container.querySelector(".lockup")?.textContent).toBe(
    "OpenBot™by CopilotKit",
  );
});

/*
 * The foot holds what runs behind the step. With nothing behind, there is no foot: an empty one
 * drew its rule over nothing.
 */
test("the sidebar's foot holds what runs behind the step, and is absent with nothing there", () => {
  const without = render(
    <SetupRail>
      <Sections at="Account" />
    </SetupRail>,
  );
  expect(without.container.querySelector(".rail-foot")).toBeNull();
  cleanup();

  const withFoot = render(
    <SetupRail foot={<p>Installing OpenBot in the background.</p>}>
      <Sections at="Account" />
    </SetupRail>,
  );
  const rail = withFoot.getByRole("complementary", { name: "Setup" });
  const foot = rail.querySelector(".rail-foot");
  expect(foot?.textContent).toBe("Installing OpenBot in the background.");
  // Last in the sidebar, under the sections.
  expect(rail.lastElementChild).toBe(foot);
});

/*
 * The setup window's mark is the app's AgentOrb disc, drawn from `shared/agent-orb` at AgentOrb's
 * own values for its size: at 32px a 5% mask over the dots and a 1.44 contrast, at 22px no mask and
 * a 1.1 contrast, as AgentOrb sets them under 30px.
 */
test("the lockup's mark is the app's orb, at its own values for 32 and 22px", () => {
  for (const [size, mask, contrast] of [
    [32, "5%", "1.44"],
    [22, "0%", "1.1"],
  ] as const) {
    const { container } = render(<Lockup size={size} />);
    const box = container.querySelector(".orb") as HTMLElement;
    expect(box.style.width).toBe(`${size}px`);
    const disc = box.querySelector(".agent-orb") as HTMLElement;
    expect(disc.style.getPropertyValue("--mask-radius")).toBe(mask);
    expect(disc.style.getPropertyValue("--contrast-amount")).toBe(contrast);
    expect(disc.querySelector(".agent-orb-sheen")).not.toBeNull();
    expect(disc.querySelector(".agent-orb-rim")).not.toBeNull();
    cleanup();
  }
});

test("the orb's stylesheet goes to the head once, not into the lockup's text", () => {
  const { container } = render(
    <>
      <Lockup />
      <Lockup byCopilotKit size={22} />
    </>,
  );
  const sheets = [...document.head.querySelectorAll("style")].filter(
    (style) => style.textContent === AGENT_ORB_CSS,
  );
  expect(sheets).toHaveLength(1);
  expect(container.querySelector("style")).toBeNull();
  expect(container.querySelectorAll(".lockup")[1]?.textContent).toBe(
    "OpenBot™by CopilotKit",
  );
});
