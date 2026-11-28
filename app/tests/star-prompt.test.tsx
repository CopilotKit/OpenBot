import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotChatMessageView,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { NOTIFY_PROMPT_KEY } from "@/components/notifications/notify-prompt";
import { StarPrompt } from "@/components/star-prompt/star-prompt";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { closeDesktop, launchDesktop } from "./desktop-notifications.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The ask to star OpenBot on GitHub (David's rules):
 *
 * 1. Only in the personal edition, never a team's or a company's OpenBot.
 * 2. Once per person: either answer is saved to their account, so no device asks again.
 * 3. Only after three days of use and a win (a copied answer, a routine's run, a long task), right
 *    after the win, and never right after an error.
 *
 * The server decides when it is due (`noticesDue` on the person's preferences). This file drives the
 * app through its real components and its real requests against a server that keeps the rule's
 * inputs the way the real one does: days with a message sent, the last win or error, and the
 * notices the person dismissed.
 */

const STAR = "star-on-github";
const ASK =
  "Enjoying OpenBot? Star it on GitHub so that we can keep making it better.";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

/** What the server knows about the one person. */
type Server = {
  daysActive: number;
  last: "win" | "error" | undefined;
  dismissed: string[];
  personal: boolean;
};

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;
let requests: { path: string; method: string; body: unknown }[];
let server: Server;

/** The server's own answer for the person's preferences, worked out the way the real one does. */
function served(): UserPreferences {
  const due =
    server.personal &&
    !server.dismissed.includes(STAR) &&
    server.daysActive >= 3 &&
    server.last === "win";
  return {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    dismissedNotices: [...server.dismissed],
    noticesDue: due ? [STAR] : [],
    narration: null,
    skin: "openbot",
    proactive: "on",
  };
}

beforeAll(() => {
  // Star on GitHub is a real link: pressing it must not open github.com from a test.
  GlobalRegistrator.register({
    url: "http://localhost:3010",
    settings: {
      navigation: {
        disableChildPageNavigation: true,
        disableMainFrameNavigation: true,
      },
    },
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(async () => {
  const { forgetStarPrompt } = await import(
    "@/components/star-prompt/star-prompt"
  );
  forgetStarPrompt?.();
  window.localStorage.clear();
  requests = [];
  server = { daysActive: 3, last: undefined, dismissed: [], personal: true };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ path, method, body });
      if (path.endsWith("/nudge-events"))
        return new Response(null, { status: 204 });
      if (path.endsWith("/product-events")) {
        // The server records a copied answer as a win.
        if ((body as { kind?: string }).kind === "result_copied")
          server.last = "win";
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/people/me/preferences")) {
        if (method === "PATCH") {
          const sent = (body as { dismissedNotices?: string[] })
            .dismissedNotices;
          // Added to the ones already dismissed, never taken off.
          for (const id of sent ?? [])
            if (!server.dismissed.includes(id)) server.dismissed.push(id);
        }
        return Response.json(served());
      }
      // CopilotKit's runtime info, for the direct Bot chat's provider.
      return Response.json({
        version: "fixture",
        agents: {},
        mode: "sse",
        telemetryDisabled: true,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  // A browser already answered about notifications, so that offer is not what is being tested.
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "granted",
    requestPermission: async () => "granted",
  };
  refreshNotificationPermission();
});
afterEach(async () => {
  cleanup();
  closeDesktop();
  await settleReactWork();
  queryClient.clear();
  window.localStorage.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
  refreshNotificationPermission();
  GlobalRegistrator.unregister();
});

/** What the app shell loads on every page (the self-host banner reads the same three). */
function loadAppShell() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: server.personal,
    edition: server.personal ? "personal" : "team",
    // What an earlier build read as leave to ask everybody. Nothing reads it now; it stays so a
    // build that did would show the card here and fail these tests.
    starPrompt: true,
  });
  // And a browser an earlier build had counted five messages in. Nothing reads it now either.
  window.localStorage.setItem("openbot-star-prompt-prompts", "5");
  queryClient.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    served(),
  );
}

/** A conversation, with the card's place above its message box. */
function conversation(
  props: Partial<Parameters<typeof ConversationView>[0]> = {},
) {
  return render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() => {}}
      {...props}
    />,
  );
}

/** The direct Bot chat, where a Bot's answer has a copy button. */
function directChat() {
  const messages: Message[] = [
    { id: "person", role: "user", content: "Find me a table for two" },
    { id: "answer", role: "assistant", content: "Dishoom, 7:30, booked." },
  ];
  return render(
    <CopilotKitProvider
      enableInspector={false}
      runtimeUrl="http://localhost/api/copilotkit"
    >
      <CopilotChatConfigurationProvider threadId="thread-1">
        <CopilotChatMessageView
          assistantMessage={TelemetryAssistantMessage}
          isRunning={false}
          messages={messages}
        />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>,
  );
}

async function copyTheAnswer(chat: ReturnType<typeof directChat>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  });
  await act(async () => {
    fireEvent.click(chat.getByTestId("copilot-copy-button"));
  });
}

async function sendMessages(view: ReturnType<typeof conversation>, n: number) {
  const box = view.getByRole("textbox");
  for (let sent = 0; sent < n; sent += 1) {
    await act(async () => {
      fireEvent.input(box, { target: { textContent: `Message ${sent}` } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
  }
}

const card = (view: { container: HTMLElement }) =>
  view.container.querySelector("[data-star-prompt]");

const nudges = (action: string) =>
  requests.filter(
    (request) =>
      request.path.endsWith("/nudge-events") &&
      (request.body as { action?: string }).action === action,
  );

const preferenceReads = () =>
  requests.filter(
    (request) =>
      request.path.endsWith("/people/me/preferences") &&
      request.method === "GET",
  );

test("personal edition: shows right after a copy on the third day of use", async () => {
  loadAppShell();
  const view = conversation();
  const chat = directChat();
  expect(card(view)).toBeNull();

  await copyTheAnswer(chat);

  await waitFor(() => expect(card(view)).not.toBeNull());
  expect(view.getByText(ASK)).toBeTruthy();
  await waitFor(() => expect(nudges("shown")).toHaveLength(1));
  expect(nudges("shown")[0]?.body).toEqual({
    nudge: STAR,
    action: "shown",
    place: "card",
    surface: "web",
  });
});

test("a team's OpenBot never shows it, and a copy there asks the server for nothing", async () => {
  server.personal = false;
  // Even a server that wrongly said it was due is not believed outside the personal edition.
  server.last = "win";
  loadAppShell();
  queryClient.setQueryData(userPreferencesQueryOptions("alice").queryKey, {
    ...served(),
    noticesDue: [STAR],
  });
  const view = conversation();
  const chat = directChat();
  await copyTheAnswer(chat);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(card(view)).toBeNull();
  expect(preferenceReads()).toHaveLength(0);
  expect(nudges("shown")).toHaveLength(0);
});

test("never before three days of use, even after many messages and a copy", async () => {
  server.daysActive = 2;
  loadAppShell();
  const view = conversation();
  await sendMessages(view, 8);
  await copyTheAnswer(directChat());
  await waitFor(() => expect(preferenceReads().length).toBeGreaterThan(0));
  await settleReactWork();

  expect(card(view)).toBeNull();
});

test("never before a win, even after many messages on the third day", async () => {
  loadAppShell();
  const view = conversation();
  await sendMessages(view, 8);
  await settleReactWork();

  expect(card(view)).toBeNull();
  expect(nudges("shown")).toHaveLength(0);
});

test("never right after an error, even when the server says it is due", () => {
  server.last = "win";
  loadAppShell();
  const failed = conversation({
    stopped: { message: "The Bot stopped before it finished answering." },
  });
  expect(card(failed)).toBeNull();
});

/*
 * A conversation always hands the view a notice: the allowances, the hand-off resume and the rest,
 * which mostly draw nothing. Its being there is no error, and the card must still show.
 */
test("an ordinary conversation's notice, drawing nothing, does not hide it", () => {
  server.last = "win";
  loadAppShell();
  const view = conversation({
    notice: (
      <>
        {null}
        {false}
      </>
    ),
  });
  expect(card(view)).not.toBeNull();
});

test("the server taking the win back (a routine failed after it) shows nothing", async () => {
  loadAppShell();
  const view = conversation();
  const chat = directChat();
  server.last = "error";
  // The copy is a win; then a routine fails before the app reads again. The server's last word wins.
  const { nudgeMoment } = await import("@/lib/notices");
  nudgeMoment(queryClient);
  await waitFor(() => expect(preferenceReads().length).toBeGreaterThan(0));
  await settleReactWork();
  expect(card(view)).toBeNull();
  expect(chat).toBeTruthy();
});

for (const [control, action] of [
  ["Star on GitHub", "clicked"],
  ["Not now", "dismissed"],
] as const) {
  test(`${control} hides it, saves the answer to the account, and counts it`, async () => {
    server.last = "win";
    loadAppShell();
    const view = conversation();
    fireEvent.click(
      control === "Not now"
        ? view.getByRole("button", { name: control })
        : view.getByRole("link", { name: control }),
    );

    await waitFor(() => expect(card(view)).toBeNull());
    await waitFor(() => expect(nudges(action)).toHaveLength(1));
    expect(nudges(action)[0]?.body).toEqual({
      nudge: STAR,
      action,
      place: "card",
      surface: "web",
    });
    const saved = requests.find(
      (request) =>
        request.path.endsWith("/people/me/preferences") &&
        request.method === "PATCH",
    );
    expect(saved?.body).toEqual({ dismissedNotices: [STAR] });
  });
}

test("answered once is never asked again, after a reload and in a second browser", async () => {
  server.last = "win";
  loadAppShell();
  const first = conversation();
  fireEvent.click(first.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(server.dismissed).toEqual([STAR]));
  cleanup();

  // A reload, or another browser: nothing kept in this page or its storage, only the account.
  const { forgetStarPrompt } = await import(
    "@/components/star-prompt/star-prompt"
  );
  forgetStarPrompt();
  queryClient.clear();
  window.localStorage.clear();
  loadAppShell();
  const again = conversation();
  // Another win on another day does not bring it back.
  server.daysActive = 9;
  await copyTheAnswer(directChat());
  await settleReactWork();

  expect(card(again)).toBeNull();
  expect(
    queryClient.getQueryData(userPreferencesQueryOptions("alice").queryKey)
      ?.dismissedNotices,
  ).toEqual([STAR]);
});

test("Star on GitHub is a link to the repository, opened in a new tab", () => {
  server.last = "win";
  loadAppShell();
  const link = conversation().getByRole("link", { name: "Star on GitHub" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/OpenBot",
  );
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("asks the server for nothing itself when drawn", async () => {
  server.last = "win";
  loadAppShell();
  render(<StarPrompt />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(preferenceReads()).toHaveLength(0);
});

test("a conversation that cannot take messages never shows it", () => {
  server.last = "win";
  loadAppShell();
  expect(card(conversation({ disabled: true }))).toBeNull();
});

test("in OpenBot Desktop it waits until the app has said whether notifications are on", async () => {
  const desktop = launchDesktop({ plugin: true, answersLate: true });
  refreshNotificationPermission();
  server.last = "win";
  loadAppShell();
  const view = conversation();
  expect(card(view)).toBeNull();
  expect(nudges("shown")).toHaveLength(0);

  await act(async () => desktop.answer());

  await waitFor(() => expect(card(view)).not.toBeNull());
});

test("waits while the notifications offer is still open, so the two never stack", () => {
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission: async () => "default",
  };
  refreshNotificationPermission();
  server.last = "win";
  loadAppShell();
  const open = conversation();
  expect(open.container.querySelector("[data-notify-prompt]")).not.toBeNull();
  expect(card(open)).toBeNull();
  cleanup();

  window.localStorage.setItem(NOTIFY_PROMPT_KEY, new Date().toISOString());
  const answered = conversation();
  expect(card(answered)).not.toBeNull();
  expect(
    card(answered)?.closest('[data-slot="composer-column"]'),
  ).not.toBeNull();
});
