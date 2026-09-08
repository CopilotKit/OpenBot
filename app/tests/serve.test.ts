import { describe, expect, test } from "bun:test";
import { fileFor, isApiCall, isClientRoute } from "../serve";

/**
 * Serving the built app, which replaced `vite preview`.
 *
 * The failure that made this necessary: `vite preview` under `bun --bun` dies on the first proxied
 * call with `TypeError: socket.destroySoon is not a function`, so the app served its page, exited,
 * and the shell's window went on saying "OpenBot is running" with nothing listening.
 */
describe("what answers a request", () => {
  test("the server answers its own prefix, and nothing near it", () => {
    expect(isApiCall("/api")).toBe(true);
    expect(isApiCall("/api/channels")).toBe(true);
    // Not the app's own routes, and not a path that merely starts with the same letters.
    expect(isApiCall("/apixyz")).toBe(false);
    expect(isApiCall("/channel/api")).toBe(false);
    expect(isApiCall("/")).toBe(false);
  });

  /**
   * A miss under `/assets` is a real 404. Answering index.html there hands a script tag some HTML,
   * which fails in the console rather than in the network panel and reads as a broken app.
   */
  test("a missing built file is not answered with the page", () => {
    expect(isClientRoute("/assets/index-abc123.js")).toBe(false);
    expect(isClientRoute("/favicon.ico")).toBe(false);
  });

  /** Every other miss is the app's own router: /channel/<id> has to load the page. */
  test("a client route is answered with the page", () => {
    expect(isClientRoute("/channel/channel_1ed78a89")).toBe(true);
    expect(isClientRoute("/agents")).toBe(true);
    expect(isClientRoute("/")).toBe(true);
  });
});

describe("which file a path names", () => {
  test("the root and any directory are the page", () => {
    expect(fileFor("/")).toEndWith("/dist/index.html");
    expect(fileFor("/channel/")).toEndWith("/dist/index.html");
  });

  test("a built asset is itself", () => {
    expect(fileFor("/assets/index-abc.js")).toEndWith(
      "/dist/assets/index-abc.js",
    );
  });

  /**
   * Nothing outside the directory, whatever the request says. This server has the deployment's
   * `.env` two levels above it, so the traversal guard is not theoretical.
   */
  test("a path that climbs out is refused", () => {
    expect(fileFor("/../.env")).toBeNull();
    expect(fileFor("/../../.env")).toBeNull();
    expect(fileFor("/%2e%2e/%2e%2e/.env")).toBeNull();
    expect(fileFor("/assets/../../.env")).toBeNull();
  });
});
