import { expect, test } from "bun:test";
import { queryClient } from "../src/query-client";

test("provides a shared query client for application server state", () => {
  expect(queryClient.getDefaultOptions().queries?.retry).toBe(1);
});
