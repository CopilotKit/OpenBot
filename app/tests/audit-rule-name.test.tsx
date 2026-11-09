import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";
import { seedAuditPage } from "./seed-audit-page";

/**
 * A Blocked row says which rule stopped it by name, and keeps the rule's CEL to two lines.
 *
 * A rule written from a sentence is about a thousand characters of CEL, and the Decision cell printed
 * it whole: one Blocked row was 322px tall at 1280px wide and 427px at 1000px, a wall of CEL that
 * named nothing, while the admin had saved the rule as "Bots may not visit social media sites". The
 * row now carries `ruleName`, the cell says it, and the expression is clamped with a control to read
 * the rest. Rows written before `ruleName` existed show the clamped expression alone.
 */

const SITES = [
  "facebook.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "reddit.com",
  "snapchat.com",
  "pinterest.com",
  "threads.net",
  "bsky.app",
  "tumblr.com",
  "mastodon.social",
  "youtube.com",
];
/** The shape the plain-English translator writes: a clause per site, over a thousand characters. */
const SOCIAL = `intent == "navigate" && (${SITES.map(
  (site) =>
    `page.host == "${site}" || matches(page.host, "[.]${site.replace(".", "[.]")}$")`,
).join(" || ")})`;
const NAME = "Bots may not visit social media sites";

/*
 * happy-dom lays nothing out, so every box measures 0 and no clamp ever hides anything. A clamped
 * line here measures as the browser measured it in the real app: two lines tall, its content as
 * tall as the text needs at the Decision column's width.
 */
const LINE = 16;
const PER_LINE = 50;
let restore: (() => void) | undefined;
function measureLikeTheBrowser() {
  const proto = HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  const lines = (element: HTMLElement) =>
    Math.max(1, Math.ceil((element.textContent ?? "").length / PER_LINE));
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return lines(this) * LINE;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const clamped = this.classList.contains("line-clamp-2");
      return (
        Math.min(lines(this), clamped ? 2 : Number.POSITIVE_INFINITY) * LINE
      );
    },
  });
  restore = () => {
    if (scroll) Object.defineProperty(proto, "scrollHeight", scroll);
    else delete (proto as { scrollHeight?: number }).scrollHeight;
    if (client) Object.defineProperty(proto, "clientHeight", client);
    else delete (proto as { clientHeight?: number }).clientHeight;
  };
}

beforeAll(() => {
  GlobalRegistrator.register();
  measureLikeTheBrowser();
});

afterEach(() => cleanup());

afterAll(() => {
  restore?.();
  GlobalRegistrator.unregister();
});

function refusal(decision: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "event-1",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: "bot-a",
    payload: {
      action: "computer_navigate",
      bot: "bot-a",
      actor: "person@example.test",
      page: "https://www.facebook.com/",
      ref: null,
      decision: {
        allowed: false,
        mode: "enforce",
        source: "deny",
        carriedOut: false,
        ...decision,
      },
    },
    createdAt: new Date(0).toISOString(),
  };
}

async function renderAuditRow(row: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", { events: [row] });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: AuditRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return within(view.container.querySelector("tbody") as HTMLElement);
}

test("the social media rule is as long as one written from a sentence", () => {
  expect(SOCIAL.length).toBeGreaterThan(1_000);
});

test("a refusal by a named rule says the name, and clamps the rule to two lines", async () => {
  const row = await renderAuditRow(refusal({ rule: SOCIAL, ruleName: NAME }));

  expect(row.getByText("Blocked")).not.toBeNull();
  expect(row.getByText(`Stopped by: ${NAME}`)).not.toBeNull();

  const expression = row.getByText(SOCIAL);
  expect(expression.className).toContain("line-clamp-2");
  expect(expression.className).toContain("font-mono");
  expect(expression.className).toContain("text-muted-foreground");

  // The rest is a press away, and the press can be undone.
  const more = row.getByRole("button", { name: "Show full rule" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(more.getAttribute("aria-controls")).toBe(expression.id);
  await userEvent.click(more);
  expect(row.getByText(SOCIAL).className).not.toContain("line-clamp-2");
  const less = row.getByRole("button", { name: "Show less" });
  expect(less.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(less);
  expect(row.getByText(SOCIAL).className).toContain("line-clamp-2");
});

test("a row written before rules had names still renders, with the clamped rule alone", async () => {
  const row = await renderAuditRow(refusal({ rule: SOCIAL }));

  expect(row.getByText("Blocked")).not.toBeNull();
  expect(row.queryByText(/^Stopped by:/)).toBeNull();
  expect(row.getByText(SOCIAL).className).toContain("line-clamp-2");
  expect(row.getByRole("button", { name: "Show full rule" })).not.toBeNull();
});

test("a rule short enough to fit has nothing more to show", async () => {
  const rule = 'intent == "navigate" && page.host == "x.com"';
  const row = await renderAuditRow(refusal({ rule, ruleName: "Stay off X" }));

  expect(row.getByText("Stopped by: Stay off X")).not.toBeNull();
  expect(row.getByText(rule)).not.toBeNull();
  expect(row.queryByRole("button", { name: "Show full rule" })).toBeNull();
});

test("a trial-mode refusal went ahead, so the rule would have stopped it", async () => {
  const row = await renderAuditRow(
    refusal({
      rule: SOCIAL,
      ruleName: NAME,
      mode: "dry-run",
      carriedOut: true,
    }),
  );

  expect(row.getByText(`Would be stopped by: ${NAME}`)).not.toBeNull();
  expect(row.getByText("dry-run: recorded, not enforced")).not.toBeNull();
});
