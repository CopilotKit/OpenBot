import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { AGENT_ORB_CSS } from "../../shared/agent-orb";

const { Lockup } = await import("./Sections");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

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
