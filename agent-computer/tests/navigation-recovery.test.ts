import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { assertPageAccess, navigateWebPage } from "../src/navigation";

function fixture() {
  let url = "https://example.com/";
  let failure = true;
  const visited: string[] = [];
  const page: Pick<Page, "goto" | "url"> = {
    url: () => url,
    async goto(target) {
      visited.push(target);
      if (failure) {
        failure = false;
        url = "chrome-error://chromewebdata/";
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
      url = target;
      return null;
    },
  };
  return { page, visited };
}

test("a failed navigation can recover from Chrome's internal error page without exposing it", async () => {
  const { page, visited } = fixture();
  await expect(
    navigateWebPage(page, "http://127.0.0.1:64110/", "local-chrome", 1000),
  ).rejects.toThrow("ERR_CONNECTION_REFUSED");
  expect(() => assertPageAccess("local-chrome", page.url())).toThrow(
    /only web pages/,
  );
  assertPageAccess("local-chrome", page.url(), "navigate");
  await navigateWebPage(
    page,
    "https://example.com/recovered",
    "local-chrome",
    1000,
  );
  expect(visited).toEqual([
    "http://127.0.0.1:64110/",
    "https://example.com/recovered",
  ]);
  expect(() => assertPageAccess("local-chrome", page.url())).not.toThrow();
});

test("navigation never accepts file/chrome targets or returns a nonweb redirect result", async () => {
  const { page, visited } = fixture();
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
  ]) {
    expect(() => assertPageAccess("local-chrome", url)).toThrow();
    await expect(
      navigateWebPage(page, url, "local-chrome", 1000),
    ).rejects.toThrow();
  }
  expect(visited).toHaveLength(0);
  const redirected: Pick<Page, "goto" | "url"> = {
    goto: async () => null,
    url: () => "file:///private/secret",
  };
  await expect(
    navigateWebPage(
      redirected,
      "https://example.com/redirect",
      "local-chrome",
      1000,
    ),
  ).rejects.toThrow(/only web pages/);
  expect(() => assertPageAccess("local-chrome", "about:blank")).not.toThrow();
});
