import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { NOTIFY_PROMPT_KEY } from "@/components/notifications/notify-prompt";
import { StarPrompt } from "@/components/star-prompt/star-prompt";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import {
  noteBotCreated,
  notePromptSent,
  OPENBOT_REPO_URL,
  STAR_PROMPT_AFTER_PROMPTS,
  starPromptEarned,
} from "@/lib/star-prompt";
import { queryClient } from "@/query-client";
import { closeDesktop, launchDesktop } from "./desktop-notifications.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The ask to star OpenBot on GitHub: a card above the composer once somebody has sent their fifth
 * message from this browser. Only while the deployment allows it and the person has not answered
 * it; either answer is saved to their preferences, so it is asked once on every device. The card
 * waits while the notifications offer is still open, so the two never stack.
 */

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
const originalWebSocket = globalThis.WebSocket;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;
let requests: { path: string; method: string; body: unknown }[];
let telemetryStatus: number;

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
beforeEach(() => {
  window.localStorage.clear();
  requests = [];
  telemetryStatus = 204;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ path, method, body });
      if (path.endsWith("/api/telemetry/product-events")) {
        return new Response(null, { status: telemetryStatus });
      }
      if (path.endsWith("/api/settings/preferences") && method === "PATCH") {
        return Response.json({
          preferences: { ...preferences(), ...(body as object) },
        });
      }
      return Response.json({ error: "not served" }, { status: 500 });
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
afterEach(() => {
  cleanup();
  closeDesktop();
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

const ASK = "Enjoying OpenBot? Star it on GitHub so more people find it.";

function preferences(answered?: boolean): UserPreferences {
  return {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
    ...(answered === undefined ? {} : { starPromptAnswered: answered }),
  };
}

function seed({
  starPrompt = true as boolean | "absent",
  answered = undefined as boolean | undefined,
  loaded = true,
} = {}) {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    ...(starPrompt === "absent" ? {} : { starPrompt }),
  });
  if (loaded) {
    queryClient.setQueryData(
      userPreferencesQueryOptions("alice").queryKey,
      preferences(answered),
    );
  }
}

function sendPrompts(count: number) {
  for (let sent = 0; sent < count; sent += 1) notePromptSent();
}

const posted = (kind: string) =>
  requests.filter(
    (request) =>
      request.path.endsWith("/api/telemetry/product-events") &&
      (request.body as { kind?: string }).kind === kind,
  );

test("is not asked after four messages, and is asked after the fifth", () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS - 1);
  const before = render(<StarPrompt />);
  expect(before.queryByText(ASK)).toBeNull();
  before.unmount();

  notePromptSent();
  const after = render(<StarPrompt />);
  expect(after.getByText(ASK)).toBeTruthy();
  expect(after.getByRole("button", { name: "Not now" })).toBeTruthy();
});

test("is never asked where the deployment turned it off, or by a server too old to say", () => {
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  seed({ starPrompt: false });
  expect(render(<StarPrompt />).queryByText(ASK)).toBeNull();
  cleanup();
  queryClient.clear();
  seed({ starPrompt: "absent" });
  expect(render(<StarPrompt />).queryByText(ASK)).toBeNull();
});

test("is never asked before the person's preferences load, when they fail, or once answered", async () => {
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  seed({ loaded: false });
  const loading = render(<StarPrompt />);
  expect(loading.queryByText(ASK)).toBeNull();
  // The preferences request is answered 500 by the stub; the card still never appears.
  await waitFor(() =>
    expect(
      requests.some((request) =>
        request.path.endsWith("/api/settings/preferences"),
      ),
    ).toBe(true),
  );
  expect(loading.queryByText(ASK)).toBeNull();
  cleanup();
  queryClient.clear();

  seed({ answered: true });
  expect(render(<StarPrompt />).queryByText(ASK)).toBeNull();
});

test("Star on GitHub is a link to the repository, opened in a new tab", () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  const link = render(<StarPrompt />).getByRole("link", {
    name: "Star on GitHub",
  });
  expect(link.getAttribute("href")).toBe(OPENBOT_REPO_URL);
  expect(OPENBOT_REPO_URL).toBe("https://github.com/CopilotKit/OpenBot");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("drawing it counts one show for the prompts trigger", async () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  render(<StarPrompt />);
  await waitFor(() => expect(posted("star_prompt_shown")).toHaveLength(1));
  expect(posted("star_prompt_shown")[0]?.body).toEqual({
    kind: "star_prompt_shown",
    trigger: "prompts",
    surface: "web",
  });
});

for (const [button, kind] of [
  ["Star on GitHub", "star_prompt_clicked"],
  ["Not now", "star_prompt_dismissed"],
] as const) {
  test(`${button} hides it, saves the answer, and counts it`, async () => {
    seed();
    sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
    const view = render(<StarPrompt />);
    fireEvent.click(
      button === "Not now"
        ? view.getByRole("button", { name: button })
        : view.getByRole("link", { name: button }),
    );

    await waitFor(() => expect(view.queryByText(ASK)).toBeNull());
    await waitFor(() => expect(posted(kind)).toHaveLength(1));
    expect(posted(kind)[0]?.body).toEqual({
      kind,
      trigger: "prompts",
      surface: "web",
    });
    const saved = requests.find(
      (request) =>
        request.path.endsWith("/api/settings/preferences") &&
        request.method === "PATCH",
    );
    expect(saved?.body).toEqual({ starPromptAnswered: true });
  });
}

test("a count the server refuses still hides it and still saves the answer", async () => {
  telemetryStatus = 500;
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  const view = render(<StarPrompt />);
  fireEvent.click(view.getByRole("button", { name: "Not now" }));

  await waitFor(() => expect(view.queryByText(ASK)).toBeNull());
  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.path.endsWith("/api/settings/preferences") &&
          request.method === "PATCH",
      ),
    ).toBe(true),
  );
});

test("storage that refuses earns nothing and breaks nothing", () => {
  // As with site data blocked: reaching `localStorage` at all throws.
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage refused");
    },
  });
  try {
    expect(() => sendPrompts(STAR_PROMPT_AFTER_PROMPTS)).not.toThrow();
    expect(() => noteBotCreated()).not.toThrow();
    expect(starPromptEarned("prompts")).toBe(false);
    expect(starPromptEarned("bot_created")).toBe(false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  }
});

test("creating a Bot earns the bot_created trigger, and only that one", async () => {
  expect(starPromptEarned("bot_created")).toBe(false);
  const options = createAgentMutationOptions(queryClient);
  await options.onSuccess?.(
    // The created Bot itself is not read; only that a create succeeded.
    {} as never,
    {} as never,
    undefined as never,
    {} as never,
  );
  expect(starPromptEarned("bot_created")).toBe(true);
  expect(starPromptEarned("prompts")).toBe(false);
});

test("a conversation counts each message sent, and asks above the composer at the fifth", async () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS - 1);
  let resolveSend = () => {};
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        })
      }
    />,
  );
  expect(view.container.querySelector("[data-star-prompt]")).toBeNull();

  const box = view.getByRole("textbox");
  fireEvent.input(box, { target: { textContent: "And a taxi" } });
  fireEvent.keyDown(box, { key: "Enter" });
  resolveSend();

  await waitFor(() => expect(starPromptEarned("prompts")).toBe(true));
  await waitFor(() =>
    expect(view.container.querySelector("[data-star-prompt]")).not.toBeNull(),
  );
});

test("a send the conversation refuses is not counted", async () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS - 1);
  let refuse = (_reason: Error) => {};
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        })
      }
    />,
  );
  const box = view.getByRole("textbox");
  fireEvent.input(box, { target: { textContent: "And a taxi" } });
  fireEvent.keyDown(box, { key: "Enter" });
  refuse(new Error("Agent unavailable"));

  // The words go back in the box when a send is refused; wait for that, then check nothing counted.
  await waitFor(() => expect(box.textContent).toContain("And a taxi"));
  expect(starPromptEarned("prompts")).toBe(false);
  expect(view.container.querySelector("[data-star-prompt]")).toBeNull();
});

test("a conversation that cannot take messages never asks", () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  const view = render(
    <ConversationView
      channelId="c-1"
      disabled
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() => {}}
    />,
  );
  expect(view.container.querySelector("[data-star-prompt]")).toBeNull();
});

test("in OpenBot Desktop the card waits until the app has said whether notifications are on", async () => {
  const desktop = launchDesktop({ plugin: true, answersLate: true });
  refreshNotificationPermission();
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() => {}}
    />,
  );
  expect(view.container.querySelector("[data-star-prompt]")).toBeNull();
  expect(posted("star_prompt_shown")).toHaveLength(0);

  await act(async () => desktop.answer());

  await waitFor(() =>
    expect(view.container.querySelector("[data-star-prompt]")).not.toBeNull(),
  );
});

test("a card drawn again in the same browser is counted as shown once", async () => {
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  render(<StarPrompt />);
  await waitFor(() => expect(posted("star_prompt_shown")).toHaveLength(1));
  cleanup();

  render(<StarPrompt />);
  expect(render(<StarPrompt />).getAllByText(ASK).length).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(posted("star_prompt_shown")).toHaveLength(1);
});

test("waits while the notifications offer is still open, so the two never stack", () => {
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission: async () => "default",
  };
  refreshNotificationPermission();
  seed();
  sendPrompts(STAR_PROMPT_AFTER_PROMPTS);
  const messages = [
    { id: "u1", role: "user" as const, content: "Book a table" },
  ];
  const open = render(
    <ConversationView
      channelId="c-1"
      messages={messages}
      onSubmit={() => {}}
    />,
  );
  expect(open.container.querySelector("[data-notify-prompt]")).not.toBeNull();
  expect(open.container.querySelector("[data-star-prompt]")).toBeNull();
  cleanup();

  window.localStorage.setItem(NOTIFY_PROMPT_KEY, new Date().toISOString());
  const answered = render(
    <ConversationView
      channelId="c-1"
      messages={messages}
      onSubmit={() => {}}
    />,
  );
  const card = answered.container.querySelector("[data-star-prompt]");
  expect(card).not.toBeNull();
  expect(card?.closest('[data-slot="composer-column"]')).not.toBeNull();
});
