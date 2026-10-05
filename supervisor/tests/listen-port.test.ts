import { describe, expect, test } from "bun:test";
import { listenPort } from "../src/listen-port";

/**
 * Empty PORT must not become NaN / an ephemeral bind. Same empty-string trap as the API server.
 */
describe("supervisor listen port", () => {
  test("unset and empty string fall back to 4300", () => {
    expect(listenPort(undefined, 4300)).toEqual({ ok: true, port: 4300 });
    expect(listenPort("", 4300)).toEqual({ ok: true, port: 4300 });
    expect(listenPort("   ", 4300)).toEqual({ ok: true, port: 4300 });
  });

  test("a whole number in range is accepted", () => {
    expect(listenPort("4300", 4300)).toEqual({ ok: true, port: 4300 });
    expect(listenPort("4500", 4300)).toEqual({ ok: true, port: 4500 });
    expect(listenPort("1", 4300)).toEqual({ ok: true, port: 1 });
    expect(listenPort("65535", 4300)).toEqual({ ok: true, port: 65535 });
  });

  test("prefix typos and out-of-range values are refused", () => {
    expect(listenPort("30o0", 4300).ok).toBe(false);
    expect(listenPort("0", 4300).ok).toBe(false);
    expect(listenPort("65536", 4300).ok).toBe(false);
    expect(listenPort("-1", 4300).ok).toBe(false);
    expect(listenPort("1.5", 4300).ok).toBe(false);
  });
});
