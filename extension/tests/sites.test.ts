import { expect, test } from "bun:test";
import { isExcludedSite, normaliseSites, siteOf } from "../src/shared/sites";

test("a site is the registrable domain, as browsers count one, so a bank's other hosts go with it", () => {
  expect(siteOf("https://online.bank.example.co.uk/accounts?id=1")).toBe(
    "example.co.uk",
  );
  expect(siteOf("https://mail.google.com/mail/u/0/#inbox")).toBe("google.com");
  expect(siteOf("http://WWW.Example.COM:8080/")).toBe("example.com");
  // A private suffix keeps one person's pages apart from another's.
  expect(siteOf("https://ada.github.io/notes")).toBe("ada.github.io");
  // No registrable domain: the host itself.
  expect(siteOf("http://127.0.0.1:3000/")).toBe("127.0.0.1");
  expect(siteOf("http://intranet/")).toBe("intranet");
});

test("anything that is not a website has no site", () => {
  for (const url of [
    "chrome://settings",
    "about:blank",
    "data:text/html,hi",
    "file:///Users/ada/a.pdf",
    "not a url",
    "",
    undefined,
    null,
  ])
    expect(siteOf(url)).toBeNull();
});

test("an address is left out when its site is, whichever of the site's hosts it is on", () => {
  const sites = new Set(["example.co.uk"]);
  expect(isExcludedSite("https://login.example.co.uk/", sites)).toBe(true);
  expect(isExcludedSite("https://example.co.uk/", sites)).toBe(true);
  expect(isExcludedSite("https://example.com/", sites)).toBe(false);
  expect(isExcludedSite("chrome://settings", sites)).toBe(false);
  expect(isExcludedSite("https://login.example.co.uk/", new Set())).toBe(false);
});

test("a stored list keeps only sites, once each, sorted", () => {
  expect(
    normaliseSites([
      "mail.example",
      "bank.example",
      "mail.example",
      "www.bank.example",
      "chrome://settings",
      42,
    ]),
  ).toEqual(["bank.example", "mail.example"]);
  expect(normaliseSites("bank.example")).toEqual([]);
});
