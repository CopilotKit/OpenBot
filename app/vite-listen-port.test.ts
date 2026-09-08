import { describe, expect, test } from "bun:test";
import { listenPort } from "../shared/listen-port";

/**
 * The app Vite config used `Number.parseInt(process.env.APP_PORT ?? "3010", 10)` (and the same
 * `??` for SERVER_PORT in the proxy target). Empty compose / leftover `.env` lines are `""`, so
 * parseInt was NaN and the proxy URL was `http://localhost:`. Same helper the Bots already use.
 */
describe("app listen ports", () => {
  test("empty APP_PORT is 3010", () => {
    expect(listenPort(undefined, 3010)).toEqual({ ok: true, port: 3010 });
    expect(listenPort("", 3010)).toEqual({ ok: true, port: 3010 });
    expect(listenPort("   ", 3010)).toEqual({ ok: true, port: 3010 });
  });

  test("empty SERVER_PORT is 3001", () => {
    expect(listenPort("", 3001)).toEqual({ ok: true, port: 3001 });
  });

  test("prefix typos are refused", () => {
    expect(listenPort("30o10", 3010).ok).toBe(false);
    expect(listenPort("3001abc", 3001).ok).toBe(false);
  });
});
