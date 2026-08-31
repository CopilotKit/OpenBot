import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

/*
 * A DOM before the app's own module graph, and the import below is dynamic so it stays that way.
 *
 * This file loads `src/router`, which pulls in every route and with them the component library. Some
 * of that decides at module scope whether it has a browser to work with — a portal that concludes it
 * has none stays switched off for the whole process, because `bun test` runs every file in one. So
 * whichever file happened to load the app first decided that for everybody, and the admin dialog
 * tests failed here while working perfectly in a browser. Registering first makes the answer the
 * same however the suite is walked.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}

const { router } = await import("../src/router");

test("provides the generated index route", () => {
  expect(router.routesByPath["/"]?.fullPath).toBe("/");
});

test("provides the protected credential administration route", () => {
  expect(router.routesByPath["/admin/credentials"]?.fullPath).toBe(
    "/admin/credentials",
  );
});
