import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { BotOrb } from "@/components/agents/bot-orb";
import { ORB_IMAGES } from "@/components/agents/orb-images";
import { ORB_PALETTES, orbPalette } from "@/lib/orb-palette";
import { settleReactWork } from "./settle-react-work";

/*
 * A Bot's orb: the designers' picture for its palette (Figma's "Orbs"), the same picture at every
 * size, breathing while its Bot works.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const picture = (orb: HTMLElement) =>
  /url\("?([^")]+)"?\)/.exec(orb.style.backgroundImage)?.[1];

test("the orb is announced by the Bot's name", () => {
  const view = render(<BotOrb name="Expense Review" seed="expense-review" />);
  expect(view.getByRole("img").getAttribute("aria-label")).toBe(
    "Expense Review",
  );
});

test("there is one picture for each of the eight palettes", () => {
  expect(ORB_IMAGES).toHaveLength(ORB_PALETTES.length);
  expect(new Set(ORB_IMAGES).size).toBe(ORB_PALETTES.length);
});

test("a Bot's orb is its palette's picture, the same at every size", () => {
  const drawn = [24, 40, 72].map((size) => {
    const view = render(
      <BotOrb name="Knowledge" seed="knowledge" size={size} />,
    );
    const orb = view.getByRole("img");
    const at = { variant: orb.dataset.variant, picture: picture(orb) };
    view.unmount();
    return at;
  });
  const expected = ORB_IMAGES[ORB_PALETTES.indexOf(orbPalette("knowledge"))];
  expect(drawn).toEqual(
    [24, 40, 72].map(() => ({ variant: "image", picture: expected })),
  );
});

test("a working Bot's orb is marked so it breathes, and is still its picture", () => {
  const view = render(
    <BotOrb name="Knowledge" seed="knowledge" size={24} state="working" />,
  );
  const orb = view.getByRole("img");
  expect(orb.dataset.state).toBe("working");
  expect(picture(orb)).toBe(
    ORB_IMAGES[ORB_PALETTES.indexOf(orbPalette("knowledge"))],
  );
});

test("two Bots with different seeds get different pictures", () => {
  const of = (seed: string) => {
    const view = render(<BotOrb name={seed} seed={seed} size={24} />);
    const value = picture(view.getByRole("img"));
    view.unmount();
    return value;
  };
  // These two seeds land on different palettes.
  expect(of("knowledge")).not.toBe(of("risk-analyst"));
});
