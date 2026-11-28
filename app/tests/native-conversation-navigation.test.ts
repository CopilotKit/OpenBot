import { expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  conversationParent,
  trackConversationParents,
} from "@/lib/native-shell/conversation-navigation";

test("each conversation keeps its own tab through draft replacement, browser Back and Forward", () => {
  const history = createMemoryHistory({ initialEntries: ["/bots"] });
  const stop = trackConversationParents(history);
  const current = () => conversationParent(history, history.location);
  history.push("/channel/new?agent=research");
  expect(current()).toMatchObject({ tab: "bots", index: 0 });
  history.replace("/channel/thread");
  expect(current()).toMatchObject({ tab: "bots", index: 0 });
  history.push("/conversations");
  history.push("/group/thread");
  expect(current()).toMatchObject({ tab: "conversations", index: 2 });
  history.go(-2);
  expect(current()).toMatchObject({ tab: "bots", index: 0 });
  history.forward();
  history.forward();
  expect(current().tab).toBe("conversations");
  history.push("/");
  history.push("/start/temporary");
  history.replace("/channel/new-thread");
  expect(current().tab).toBe("home");
  stop();
});

test("a cold deep link has a safe in-app destination without a previous entry", () => {
  const history = createMemoryHistory({
    initialEntries: ["/channel/from-notification"],
  });
  const stop = trackConversationParents(history);
  expect(conversationParent(history, history.location)).toMatchObject({
    path: "/conversations",
    index: undefined,
  });
  stop();
});
