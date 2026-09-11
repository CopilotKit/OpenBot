import { expect, test } from "bun:test";
import { authKeys, currentUserQueryOptions } from "../src/lib/auth/queries";

test("uses a stable key for the current authenticated user", () => {
  expect(authKeys.currentUser()).toEqual(["auth", "current-user"]);
  // Spread before comparing: `queryOptions` brands its key with TanStack's `DataTag`
  // phantom symbols, which carry the result and error types and exist only in the type
  // system. No literal can satisfy that brand, so the elements are what get compared.
  expect([...currentUserQueryOptions().queryKey]).toEqual([
    "auth",
    "current-user",
  ]);
});
