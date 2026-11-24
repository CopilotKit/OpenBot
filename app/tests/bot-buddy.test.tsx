import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { BotBuddy } from "@/components/agents/bot-buddy";
import { ConversationBuddy } from "@/components/channels/conversation-buddy";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  automaticBuddy,
  buddyFor,
  type DrawnBuddy,
  ownBuddy,
  poseFor,
} from "@/lib/buddies/buddy";
import { ownBuddiesQueryOptions } from "@/lib/buddies/queries";
import { STOCK_BUDDIES } from "@/lib/buddies/stock";
import { settleReactWork } from "./settle-react-work";

/*
 * A Bot's buddy, as its conversation's corner draws it: the one the person chose for it, or the stock
 * buddy its seed picks. Small and resting, it is the still picture.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const made = {
  id: "bud_1",
  name: "Biscuit",
  status: "ready",
  progress: { done: 3, total: 3, step: null },
  error: null,
  avatarUrl: "/api/v2/organizations/default/buddies/bud_1/files/avatar.png",
  poses: {
    idle: "/api/v2/organizations/default/buddies/bud_1/files/idle.webm",
    thinking: "/api/v2/organizations/default/buddies/bud_1/files/thinking.webm",
  },
  createdAt: "2026-11-24T10:00:00Z",
} as const;

function renderBot(buddy: string | null) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(agentListQueryOptions().queryKey, [
    { id: "knowledge", avatarSeed: "knowledge", buddy },
  ] as never);
  queryClient.setQueryData(ownBuddiesQueryOptions().queryKey, [made] as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <BotBuddy name="Knowledge" seed="knowledge" size={24} />
    </QueryClientProvider>,
  );
}

describe("a Bot drawn as its buddy", () => {
  test("is the stock buddy its seed picks until somebody chooses", () => {
    const view = renderBot(null);
    const drawn = view.container.querySelector("[data-buddy]");
    expect(drawn?.getAttribute("data-buddy")).toBe(
      automaticBuddy("knowledge").key,
    );
    expect(view.getByRole("img", { name: "Knowledge" })).toBeTruthy();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      automaticBuddy("knowledge").avatarUrl,
    );
  });

  test("is the stock buddy the person chose", () => {
    const view = renderBot("stock:meemers");
    expect(
      view.container.querySelector("[data-buddy]")?.getAttribute("data-buddy"),
    ).toBe("stock:meemers");
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/buddies/meemers/avatar.png",
    );
  });

  test("is the person's own buddy when they chose it", async () => {
    const view = renderBot("own:bud_1");
    expect(
      (await view.findByRole("img", { name: "Knowledge" })).getAttribute(
        "data-buddy",
      ),
    ).toBe("own:bud_1");
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      made.avatarUrl,
    );
  });

  test("is its still picture whatever it does when nothing animated it", () => {
    const pictureOnly: DrawnBuddy = {
      key: "own:bud_2",
      name: "Pebble",
      avatarUrl: "/api/v2/organizations/default/buddies/bud_2/files/avatar.jpg",
      clips: {},
    };
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <BotBuddy
          activity="working"
          buddy={pictureOnly}
          name="Knowledge"
          seed="knowledge"
          size={96}
        />
      </QueryClientProvider>,
    );
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      pictureOnly.avatarUrl,
    );
  });
});

describe("the buddy in a conversation", () => {
  const bot = {
    id: "knowledge",
    name: "Knowledge",
    avatarSeed: "knowledge",
    buddy: null,
  };
  const corner = (activity: "idle" | "working") =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationBuddy activity={activity} bot={bot} />
      </QueryClientProvider>,
    );

  test("is not drawn while the conversation is idle", () => {
    expect(corner("idle").container.innerHTML).toBe("");
  });

  test("is drawn while the Bot works, as a button that chooses another", () => {
    const view = corner("working");
    expect(
      view.getByRole("button", { name: "Choose a buddy for Knowledge" }),
    ).toBeTruthy();
    expect(view.getByRole("img", { name: "Knowledge" })).toBeTruthy();
  });
});

describe("which buddy and which pose", () => {
  test("the same seed always picks the same stock buddy, and seeds spread across them", () => {
    expect(automaticBuddy("knowledge").key).toBe(
      automaticBuddy("knowledge").key,
    );
    const picked = new Set(
      Array.from(
        { length: 200 },
        (_, index) => automaticBuddy(`bot-${index}`).key,
      ),
    );
    expect(picked.size).toBe(STOCK_BUDDIES.length);
  });

  test("a choice that names nothing this app knows draws the automatic buddy", () => {
    const automatic = automaticBuddy("knowledge").key;
    expect(buddyFor("knowledge", "stock:nobody", []).key).toBe(automatic);
    expect(buddyFor("knowledge", "own:gone", [made as never]).key).toBe(
      automatic,
    );
  });

  test("a buddy with no clip for what the Bot does plays the next best pose", () => {
    const own = ownBuddy(made as never) as DrawnBuddy;
    expect(poseFor(own, "working")).toBe("thinking");
    expect(poseFor(own, "waiting")).toBe("idle");
    expect(poseFor(automaticBuddy("knowledge"), "waiting")).toBe("asking");
  });

  test("a buddy whose picture isn't drawn yet can't be drawn", () => {
    expect(ownBuddy({ ...made, avatarUrl: null } as never)).toBeNull();
  });
});
