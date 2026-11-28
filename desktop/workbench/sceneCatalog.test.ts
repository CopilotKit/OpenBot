import { expect, test } from "bun:test";
import { APP_SCENES_URL, loadScenes } from "./sceneCatalog";

const appScene = {
  kind: "app",
  id: "app-home",
  title: "Home",
  group: "App",
  start: { route: "/", host: "desktop", session: {} },
};

test("app scenes that fail while the app server starts are asked for again", async () => {
  const urls: string[] = [];
  const loaded = await loadScenes(
    async (url) => {
      urls.push(url);
      if (urls.length < 3) throw new Error("Failed to fetch");
      return { APP_SCENES: [appScene] };
    },
    { tries: 5, waitMs: 1 },
  );
  expect(urls).toHaveLength(3);
  // Each try is a new URL, so the browser does not answer with the failure it kept.
  expect(new Set(urls).size).toBe(3);
  expect(urls.every((url) => url.startsWith(APP_SCENES_URL))).toBe(true);
  expect(loaded.notices).toEqual([]);
  expect(loaded.scenes.some((scene) => scene.id === "app-home")).toBe(true);
});

test("app scenes that never load give the desktop scenes and the hint", async () => {
  let calls = 0;
  const loaded = await loadScenes(
    async () => {
      calls++;
      throw new Error("Failed to fetch");
    },
    { tries: 3, waitMs: 1 },
  );
  expect(calls).toBe(3);
  expect(loaded.scenes.every((scene) => scene.kind !== "app")).toBe(true);
  expect(loaded.notices[0]).toContain("The app scenes did not load");
});
