import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PageCard, PageRows } from "@/components/layout/page-parts";
import { Card } from "@/components/ui/card";
import { ItemMedia } from "@/components/ui/item";
import { settleReactWork } from "./settle-react-work";

/*
 * Cards and rows in the web app's look (docs/app-guidelines.md, "The look"): a card is flat with a
 * hairline border in both themes, and a row's icon sits on a small tile.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const classesOf = (element: Element | null) =>
  (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

test("a Card is a flat hairline card", () => {
  const view = render(<Card className="p-3">Research Bot</Card>);
  const card = view.container.querySelector("[data-slot=card]");
  const classes = classesOf(card);
  expect(classes).toEqual(
    expect.arrayContaining([
      "rounded-lg",
      "border",
      "border-border",
      "bg-card",
      "p-3",
    ]),
  );
  expect(classes.filter((name) => name.startsWith("shadow"))).toEqual([]);
  expect(classes.filter((name) => name.startsWith("dark:"))).toEqual([]);
});

test("a row's icon sits on a tile", () => {
  const view = render(
    <ItemMedia variant="icon">
      <svg />
    </ItemMedia>,
  );
  const classes = classesOf(
    view.container.querySelector("[data-slot=item-media]"),
  );
  // A 32px tile behind a 16px glyph: Guido asked for the tiles back on 2026-11-24.
  expect(classes).toEqual(
    expect.arrayContaining([
      "size-8",
      "rounded-md",
      "bg-background",
      "ring-1",
      "ring-border",
      "text-muted-foreground",
    ]),
  );
});

test("rows and cards keep their border in dark", () => {
  const view = render(
    <>
      <PageRows>
        <div>A row</div>
      </PageRows>
      <PageCard>A form</PageCard>
    </>,
  );
  const [rows, card] = [...view.container.children];
  for (const element of [rows, card]) {
    const classes = classesOf(element);
    expect(classes).toContain("border-border");
    expect(classes.filter((name) => name.startsWith("dark:"))).toEqual([]);
  }
});
