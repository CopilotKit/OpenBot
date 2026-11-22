import { describe, expect, test } from "bun:test";
import { PAGE_COMMANDS } from "../../../desktop/src/fakeNative/pageRegistry";
import {
  APP_SCENE_GROUPS,
  type AppRunStep,
  isApiRoute,
  isAppScene,
} from "../../../desktop/workbench/appContract";
import { APP_SCENES } from "./index";

const pageCommands = new Set<string>(PAGE_COMMANDS);

/** The page command that a step answers, settles or fails, else null. */
function commandOf(step: AppRunStep): string | null {
  if ("answer" in step) return step.answer;
  if ("settle" in step) return step.settle;
  if ("fail" in step) return step.fail;
  return null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const USER_FOLDER = /\/Users\/([^/"\\\s]+)/g;
const REAL_LOOKING_KEY = /\bsk-[A-Za-z0-9]{12,}/;

describe("app scenes", () => {
  test("each scene is an app scene", () => {
    for (const scene of APP_SCENES) {
      expect(isAppScene(scene)).toBe(true);
    }
  });

  test("ids start with app- and are unique", () => {
    const ids = APP_SCENES.map((scene) => scene.id);
    for (const id of ids) expect(id.startsWith("app-")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each group is a known group", () => {
    for (const scene of APP_SCENES) {
      expect(APP_SCENE_GROUPS).toContain(scene.group);
    }
  });

  test("each start route starts with a slash", () => {
    for (const scene of APP_SCENES) {
      expect(scene.start.route.startsWith("/")).toBe(true);
    }
  });

  test("run step times are not negative and do not go back", () => {
    for (const scene of APP_SCENES) {
      let last = 0;
      for (const step of scene.run ?? []) {
        expect(step.at).toBeGreaterThanOrEqual(0);
        expect(step.at).toBeGreaterThanOrEqual(last);
        last = step.at;
      }
    }
  });

  test("each API route is a valid route", () => {
    for (const scene of APP_SCENES) {
      for (const route of Object.keys(scene.start.api ?? {})) {
        expect({ scene: scene.id, route, valid: isApiRoute(route) }).toEqual({
          scene: scene.id,
          route,
          valid: true,
        });
      }
      for (const step of scene.run ?? []) {
        if (!("api" in step)) continue;
        expect({
          scene: scene.id,
          route: step.api,
          valid: isApiRoute(step.api),
        }).toEqual({ scene: scene.id, route: step.api, valid: true });
      }
    }
  });

  test("each page command is a known page command", () => {
    for (const scene of APP_SCENES) {
      const commands = Object.keys(scene.start.answers ?? {});
      for (const step of scene.run ?? []) {
        const command = commandOf(step);
        if (command !== null) commands.push(command);
      }
      const unknown = commands.filter((command) => !pageCommands.has(command));
      expect({ scene: scene.id, unknown }).toEqual({
        scene: scene.id,
        unknown: [],
      });
    }
  });

  test("scenes hold only made-up personal data", () => {
    for (const scene of APP_SCENES) {
      const text = JSON.stringify(scene);
      const emails = text.match(EMAIL) ?? [];
      const badEmails = emails.filter(
        (email) => !email.endsWith("@example.com"),
      );
      const badFolders = [...text.matchAll(USER_FOLDER)]
        .map((match) => match[1])
        .filter((name) => name !== "sam");
      expect({
        scene: scene.id,
        badEmails,
        badFolders,
        realLookingKey: REAL_LOOKING_KEY.test(text),
      }).toEqual({
        scene: scene.id,
        badEmails: [],
        badFolders: [],
        realLookingKey: false,
      });
    }
  });
});
