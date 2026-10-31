import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { BotOrb } from "@/components/agents/bot-orb";
import { settleReactWork } from "./settle-react-work";

/*
 * A Bot's orb, in its own palette. At avatar sizes a still orb is drawn with CSS alone, because a
 * sidebar of twenty animated orbs is expensive; larger or busy orbs are the live `AgentOrb`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("the orb is announced by the Bot's name", () => {
  const view = render(<BotOrb name="Expense Review" seed="expense-review" />);
  expect(view.getByRole("img").getAttribute("aria-label")).toBe(
    "Expense Review",
  );
});

test("a small, idle orb is drawn still", () => {
  const view = render(<BotOrb name="Knowledge" seed="knowledge" size={24} />);
  expect(view.getByRole("img").dataset.variant).toBe("static");
});

test("a large orb is the live one", () => {
  const view = render(<BotOrb name="Knowledge" seed="knowledge" size={96} />);
  expect(view.getByRole("img").dataset.variant).toBe("live");
});

test("a working orb is live at any size", () => {
  const view = render(
    <BotOrb name="Knowledge" seed="knowledge" size={24} state="working" />,
  );
  expect(view.getByRole("img").dataset.variant).toBe("live");
});

test("two Bots with different seeds get different colors", () => {
  const style = (seed: string) => {
    const view = render(<BotOrb name={seed} seed={seed} size={24} />);
    const orb = view.getByRole("img");
    const value = orb.getAttribute("style") ?? "";
    view.unmount();
    return value;
  };
  // These two seeds land on different palettes.
  expect(style("knowledge")).not.toBe(style("risk-analyst"));
});
