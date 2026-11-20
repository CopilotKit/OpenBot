import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { IconBolt, IconMessages } from "@tabler/icons-react";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SectionPanel } from "@/components/layout/section-panel";
import { Strip, StripItem } from "@/components/layout/strip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/*
 * The strip's icons name their section to a screen reader as they do in their tooltip, and say
 * which one is open: a link as the current page, a button as pressed.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function inSidebar(children: ReactNode) {
  return render(<SidebarProvider>{children}</SidebarProvider>);
}

test("an open section's link is the current page, and a closed one's is not", () => {
  const view = inSidebar(
    <Strip>
      <StripItem
        active
        icon={IconBolt}
        label="Bots"
        render={<a href="/bots" />}
      />
      <StripItem icon={IconBolt} label="Agents" render={<a href="/agents" />} />
    </Strip>,
  );
  const bots = view.getByRole("link", { name: "Bots" });
  const agents = view.getByRole("link", { name: "Agents" });
  expect(bots.getAttribute("aria-current")).toBe("page");
  expect(agents.getAttribute("aria-current")).toBeNull();
});

test("a section that is a button says whether it is open", () => {
  const view = inSidebar(
    <Strip>
      <StripItem active icon={IconMessages} label="Conversations" />
      <StripItem icon={IconBolt} label="Other" />
    </Strip>,
  );
  expect(
    view
      .getByRole("button", { name: "Conversations" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    view.getByRole("button", { name: "Other" }).getAttribute("aria-pressed"),
  ).toBe("false");
});

test("what goes at an item's end is drawn inside it", () => {
  const view = inSidebar(
    <Strip>
      <StripItem
        end={<span role="img" aria-label="1 thing needs you" />}
        icon={IconBolt}
        label="Bots"
        render={<a href="/bots" />}
      />
    </Strip>,
  );
  const badge = view.getByRole("img", { name: "1 thing needs you" });
  expect(badge.closest("a")?.getAttribute("href")).toBe("/bots");
});

test("the strip is a navigation landmark, with its footer at the bottom", () => {
  const view = inSidebar(
    <Strip footer={<button type="button">Account</button>}>
      <StripItem icon={IconBolt} label="Bots" render={<a href="/bots" />} />
    </Strip>,
  );
  const nav = view.getByRole("navigation", { name: "Sections" });
  expect(within(nav).getByRole("link", { name: "Bots" })).toBeTruthy();
  const strip = view.container.querySelector('[data-slot="strip"]');
  expect(strip?.contains(view.getByRole("button", { name: "Account" }))).toBe(
    true,
  );
});

test("a section's panel has its title as a heading, with its actions beside it", () => {
  const view = inSidebar(
    <SectionPanel
      actions={<button type="button">New conversation</button>}
      title="Conversations"
    >
      <p>rows</p>
    </SectionPanel>,
  );
  expect(
    view.getByRole("heading", { level: 2, name: "Conversations" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "New conversation" })).toBeTruthy();
  expect(view.getByText("rows")).toBeTruthy();
});
