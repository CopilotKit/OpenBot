/*
 * Scenes made from troubleshooting files by `bun run workbench:import` (`../importLog.ts`). Each is
 * a JSON file in `./imported/`. Those files come from customers, so git ignores them: they exist
 * only on the computer that imported them.
 *
 * Vite reads the folder at build time through `import.meta.glob`. Elsewhere (bun test, the shot
 * CLI) there is no `import.meta.glob`, and there are no imported scenes.
 */
import { SCENE_GROUPS, type Scene } from "./types";

function load(): Record<string, unknown> {
  // Vite replaces this call with the files it finds. Under bun the call fails, so the catch gives
  // nothing. A `typeof import.meta.glob` check does not work here: Vite replaces only the call, so
  // the check would say "undefined" in the browser too.
  try {
    return import.meta.glob("./imported/*.json", {
      eager: true,
      import: "default",
    });
  } catch {
    return {};
  }
}

function isScene(value: unknown): value is Scene {
  if (typeof value !== "object" || value === null) return false;
  const scene = value as Partial<Record<keyof Scene, unknown>>;
  const start = scene.start as Record<string, unknown> | null | undefined;
  return (
    typeof scene.id === "string" &&
    scene.id !== "" &&
    typeof scene.title === "string" &&
    SCENE_GROUPS.includes(scene.group as Scene["group"]) &&
    typeof start === "object" &&
    start !== null &&
    typeof start.hash === "string" &&
    typeof start.search === "string" &&
    (scene.run === undefined || Array.isArray(scene.run))
  );
}

const files = load();

export const IMPORTED_SCENES: readonly Scene[] = Object.keys(files)
  .sort()
  .map((path) => files[path])
  .filter(isScene);
