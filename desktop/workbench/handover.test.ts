import { describe, expect, test } from "bun:test";
import {
  APP_SCENE_AFTER_CONNECT,
  APP_SCENE_AFTER_INSTALL,
  appSceneAfter,
  desktopSceneFor,
  HANDBACK_SCENES,
  HANDBACK_WORDS,
} from "./handover";
import { SCENES } from "./scenes";

describe("handover", () => {
  test("every handback scene is a desktop scene", () => {
    const ids = new Set(SCENES.map((scene) => scene.id));
    for (const id of Object.values(HANDBACK_SCENES)) {
      if (id !== null)
        expect({ id, found: ids.has(id) }).toEqual({ id, found: true });
    }
  });

  test("an install goes to onboarding, a connection to the bots", () => {
    expect(appSceneAfter("install-mac")).toBe("app-onboarding");
    expect(appSceneAfter("install-windows")).toBe(APP_SCENE_AFTER_INSTALL);
    expect(appSceneAfter("state-first-run")).toBe(APP_SCENE_AFTER_INSTALL);
    expect(appSceneAfter("state-connect-session-ended")).toBe(
      APP_SCENE_AFTER_CONNECT,
    );
    expect(appSceneAfter("install-connect")).toBe(APP_SCENE_AFTER_INSTALL);
  });

  test("every handback command has words", () => {
    expect(Object.keys(HANDBACK_WORDS).sort()).toEqual(
      Object.keys(HANDBACK_SCENES).sort(),
    );
    for (const words of Object.values(HANDBACK_WORDS)) {
      expect(words.trim()).not.toBe("");
    }
  });

  test("desktopSceneFor gives the scene, or null for an unknown command", () => {
    expect(desktopSceneFor("plugin:openbot-desktop|move_to_cloud")).toBe(
      "move-to-cloud",
    );
    expect(desktopSceneFor("plugin:openbot-desktop|change_ai_connection")).toBe(
      null,
    );
    expect(desktopSceneFor("plugin:openbot-desktop|status")).toBeNull();
    expect(desktopSceneFor("toString")).toBeNull();
  });
});
