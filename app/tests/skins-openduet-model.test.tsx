import { describe, expect, test } from "bun:test";
import {
  columnFor,
  conversationPath,
  isSkinScreen,
  tabForPath,
} from "@/skins/openduet/places";

/*
 * The rules OpenDuet's frame runs on. Which paths are tabs decides whether a screen has a tab bar
 * or a back disc, and which column a path gets decides whether a page keeps OpenBot's width. The
 * Tasks badge is OpenBot's own count (`useWaitingCount`), held to the Bots badge in
 * skins-openduet-frame.test.tsx.
 */

describe("which tab a path is", () => {
  test("every conversation OpenBot draws is Chat", () => {
    for (const path of [
      "/",
      "/channel/new",
      "/channel/c-1",
      "/group/g-1",
      "/group/new",
      "/bot",
      "/channel/c-1/",
    ])
      expect(tabForPath(path)).toBe("chat");
  });

  test("the skin's Tasks screen is Tasks", () => {
    expect(tabForPath("/s/tasks")).toBe("tasks");
    expect(isSkinScreen("/s/tasks")).toBe(true);
  });

  test("every other page opens over the app, with no tab", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/responsibilities",
      "/routines",
      "/capabilities/skills",
      "/capabilities/memory",
      "/connections",
      "/channel/c-1/extra",
    ]) {
      expect(tabForPath(path)).toBeNull();
      expect(isSkinScreen(path)).toBe(false);
    }
  });

  test("a conversation with several Bots opens as a group", () => {
    expect(conversationPath({ id: "c", agentIds: ["a"] })).toBe("/channel/c");
    expect(conversationPath({ id: "g", agentIds: ["a", "b"] })).toBe(
      "/group/g",
    );
  });
});

/*
 * Found in review: the 430px column held every page, so a Bot's page, Admin and the computer were
 * squeezed into a phone's width on a wide screen. Only Chat and Tasks are phone-shaped now.
 */
describe("how wide the column is", () => {
  test("Chat and Tasks are a phone's width", () => {
    expect(columnFor("/")).toBe("phone");
    expect(columnFor("/channel/c-1")).toBe("phone");
    expect(columnFor("/s/tasks")).toBe("phone");
  });

  test("a conversation with its computer or its Bot's details open has room for OpenBot's pane", () => {
    expect(columnFor("/channel/c-1", { watch: true })).toBe("pane");
    expect(columnFor("/channel/c-1", { settings: true })).toBe("pane");
    expect(columnFor("/bot", { watch: true })).toBe("pane");
  });

  test("every other page keeps OpenBot's own width", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/setup",
      "/routines",
      "/capabilities/skills",
      "/connections",
    ])
      expect(columnFor(path)).toBe("page");
  });
});
