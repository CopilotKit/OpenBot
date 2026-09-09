import { expect, test } from "bun:test";
import { router } from "../src/router";

test("provides the generated index route", () => {
  expect(router.routesByPath["/"]?.fullPath).toBe("/");
});

test("provides the protected credential administration route", () => {
  expect(router.routesByPath["/admin/credentials"]?.fullPath).toBe(
    "/admin/credentials",
  );
});

test("keeps the one-click handoff continuation trigger in channel search", () => {
  const validate = router.routesByPath["/channel/$channelId"]?.options
    .validateSearch as { parse: (search: unknown) => unknown };

  expect(validate.parse({ continueHandoff: true })).toEqual({
    continueHandoff: true,
  });
});
