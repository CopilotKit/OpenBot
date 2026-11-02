import { expect, test } from "bun:test";
import { addressFrom } from "@/lib/browser/address";

/**
 * What the Browser page's address bar sends for what a person types, read the way Chrome's address bar reads it.
 */

test("an address with its scheme goes as typed", () => {
  for (const typed of [
    "https://github.com/CopilotKit/openbot/pulls?q=is%3Aopen",
    "http://127.0.0.1:3010/browser",
    "about:blank",
    "  https://example.com/  ",
  ])
    expect(addressFrom(typed)).toBe(typed.trim());
});

test("a bare host, with or without a port and a path, goes as https", () => {
  expect(addressFrom("openbot.ai")).toBe("https://openbot.ai");
  expect(addressFrom("news.ycombinator.com/item?id=1")).toBe(
    "https://news.ycombinator.com/item?id=1",
  );
  expect(addressFrom("localhost:3000")).toBe("https://localhost:3000");
  expect(addressFrom("127.0.0.1:8080/health")).toBe(
    "https://127.0.0.1:8080/health",
  );
  expect(addressFrom("[::1]:7740")).toBe("https://[::1]:7740");
});

test("anything else is a search", () => {
  expect(addressFrom("how to file an expense report")).toBe(
    "https://www.google.com/search?q=how%20to%20file%20an%20expense%20report",
  );
  expect(addressFrom("expenses")).toBe(
    "https://www.google.com/search?q=expenses",
  );
  expect(addressFrom("what is 2.5% of 80")).toBe(
    "https://www.google.com/search?q=what%20is%202.5%25%20of%2080",
  );
});

test("nothing typed goes nowhere", () => {
  expect(addressFrom("   ")).toBeNull();
});
