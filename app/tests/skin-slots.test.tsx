import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import {
  DictationButton,
  DictationSurface,
} from "@/components/channels/composer/dictation-controls";
import { ConversationView } from "@/components/channels/conversation-view";
import { DetailPanel } from "@/components/layout/detail-panel";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { settleReactWork } from "./settle-react-work";

/*
 * Skins dress OpenBot's own elements through `data-slot` hooks, never through Tailwind classes or
 * copy, so restyling the composer or a header cannot silently undress every skin. These hold each
 * hook to the element it names, drawn by the real component or route. A hook that moves to another
 * element, or goes, fails here.
 *
 * The names are app-level and none is one of the names `components/ui` gives its primitives, which
 * the last test checks.
 */

class WideObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  // Room for a pane beside the page, so DetailPanel draws its pane rather than a sheet.
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, 1280, 800),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalObserver = globalThis.ResizeObserver;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.ResizeObserver = WideObserver;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.ResizeObserver = originalObserver;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function slot(root: ParentNode, name: string): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  if (found.length === 0) throw new Error(`No [data-slot="${name}"]`);
  return found[0] as HTMLElement;
}

test("the composer's form, input, attach and send carry their hooks, in both layouts", () => {
  for (const compact of [true, false]) {
    const view = render(
      <Composer channelId="c-1" compact={compact} onSubmit={() => {}} />,
    );
    const composer = slot(view.container, "composer");
    expect(composer.tagName).toBe("FORM");

    const input = slot(composer, "composer-input");
    // The hook is ours, around prompt-area's editor: the editor is inside it and nothing else is.
    expect(
      input.querySelector('[role="textbox"][aria-label="Message"]'),
    ).not.toBeNull();
    expect(input.querySelector("button")).toBeNull();

    const attach = slot(composer, "composer-attach");
    expect(attach.tagName).toBe("BUTTON");
    expect(attach.getAttribute("aria-label")).toBe("Attach a file");

    const send = slot(composer, "composer-send");
    expect(send.tagName).toBe("BUTTON");
    expect(send.getAttribute("type")).toBe("submit");
    expect(send.getAttribute("aria-label")).toBe("Send message");
    cleanup();
  }
});

test("the composer's stop button carries its hook while a Bot is working", () => {
  const view = render(
    <Composer
      channelId="c-1"
      compact
      onStop={() => {}}
      onSubmit={() => {}}
      pending
    />,
  );
  const stop = slot(slot(view.container, "composer"), "composer-stop");
  expect(stop.tagName).toBe("BUTTON");
  expect(stop.getAttribute("aria-label")).toBe("Stop the Bot");
  expect(
    view.container.querySelector('[data-slot="composer-send"]'),
  ).toBeNull();
});

test("a conversation's composer sits in the composer column", () => {
  const view = render(
    <ConversationView channelId="c-1" messages={[]} onSubmit={() => {}} />,
  );
  const column = slot(view.container, "composer-column");
  expect(column.querySelector('form[data-slot="composer"]')).not.toBeNull();
  // The column holds the composer, not the transcript.
  expect(column.querySelector('[data-slot="message-scroller"]')).toBeNull();
});

test("the detail pane, its header and its title carry their hooks", () => {
  const view = render(
    <DetailPanel
      detail={<p>Browser preview</p>}
      onClose={() => {}}
      open
      title="Computer"
    >
      <p>Chat</p>
    </DetailPanel>,
  );
  const pane = slot(view.container, "detail-pane");
  expect(pane.textContent).toContain("Browser preview");
  expect(pane.textContent).not.toContain("Chat");
  const header = slot(pane, "detail-pane-header");
  expect(header.parentElement).toBe(pane);
  const title = slot(header, "detail-pane-title");
  expect(title.textContent).toBe("Computer");
  expect(header.querySelector('[aria-label="Close details"]')).not.toBeNull();
});

test("a page's header and title carry their hooks", async () => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <PageShell description="How it works for you." title="Preferences">
          <p>Rows</p>
        </PageShell>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
  const header = await waitFor(() => slot(view.container, "page-header"));
  expect(header.tagName).toBe("HEADER");
  const title = slot(header, "page-title");
  expect(title.tagName).toBe("H1");
  expect(title.textContent).toBe("Preferences");
  expect(header.textContent).toContain("How it works for you.");
});

/*
 * The conversation routes as the app registers them, under ids that match the file routes', so
 * each route's own `Route.useParams()` and `Route.useSearch()` resolve here as they do in the app.
 * Every request fails, which is enough: the header draws before anything has loaded.
 */
function conversationRoutes(path: string) {
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const route = (path: string, file: AnyRoute) =>
    createRoute({
      path,
      getParentRoute: () => app,
      component: file.options.component,
      validateSearch: file.options.validateSearch,
    });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        app.addChildren([
          route("channel/new", ChannelNewRoute as AnyRoute),
          route("channel/$channelId", ChannelRoute as AnyRoute),
          route("group/$channelId", GroupRoute as AnyRoute),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test.each([
  ["a conversation with one Bot", "/channel/c-1", "Channel"],
  ["a group conversation", "/group/g-1", "Group"],
  ["a new conversation", "/channel/new", "To:"],
])("%s has its conversation header", async (_name, path, heading) => {
  const view = conversationRoutes(path);
  const header = await waitFor(() =>
    slot(view.container, "conversation-header"),
  );
  // One bar, across the top of the conversation, naming it.
  expect(
    view.container.querySelectorAll('[data-slot="conversation-header"]'),
  ).toHaveLength(1);
  expect(header.textContent).toContain(heading);
});

test("no app-level hook reuses a name the ui primitives give themselves", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/components/ui/", import.meta.url);
  const primitives = new Set<string>();
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const match of source.matchAll(/data-slot="([\w-]+)"/g)) {
      primitives.add(match[1] as string);
    }
  }
  expect(primitives.size).toBeGreaterThan(50);
  const hooks = [
    "composer",
    "composer-input",
    "composer-attach",
    "composer-send",
    "composer-stop",
    "composer-dictate",
    "composer-dictate-cancel",
    "composer-dictate-stop",
    "composer-column",
    "conversation-header",
    "detail-pane",
    "detail-pane-header",
    "detail-pane-title",
    "page-header",
    "page-title",
  ];
  expect(hooks.filter((hook) => primitives.has(hook))).toEqual([]);
});

test("the dictation buttons carry their hooks while idle and while recording", () => {
  const session = {
    start: () => undefined,
    stop: () => undefined,
    cancel: () => undefined,
    retry: () => undefined,
  };
  const idle = render(
    <DictationButton
      dictation={
        { available: true, supported: true, busy: false, session } as never
      }
      disabled={false}
    />,
  );
  expect(
    idle.container.querySelector('[data-slot="composer-dictate"]'),
  ).not.toBeNull();
  cleanup();
  const recording = render(
    <DictationSurface
      canSend
      dictation={
        {
          available: true,
          supported: true,
          busy: true,
          state: { phase: "recording", seconds: 3, canRetry: false },
          session,
        } as never
      }
    >
      <span />
    </DictationSurface>,
  );
  expect(
    recording.container.querySelector('[data-slot="composer-dictate-cancel"]'),
  ).not.toBeNull();
  expect(
    recording.container.querySelector('[data-slot="composer-dictate-stop"]'),
  ).not.toBeNull();
});
