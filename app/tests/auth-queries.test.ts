import { expect, test } from "bun:test";
import { authKeys, currentUserQueryOptions } from "../src/lib/auth/queries";

test("uses a stable key for the current authenticated user", () => {
  expect(authKeys.currentUser()).toEqual(["auth", "current-user"]);
  expect(currentUserQueryOptions().queryKey).toEqual(["auth", "current-user"]);
});
