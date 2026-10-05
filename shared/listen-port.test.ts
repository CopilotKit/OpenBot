import { describe, expect, test } from "bun:test";
import { listenPort } from "./listen-port";

/**
 * Empty PORT must not become NaN / an ephemeral bind. Same empty-string trap as the supervisor.
 */
describe("Bot listen port", () => {
  test("unset and empty string fall back", () => {
    expect(listenPort(undefined, 4200)).toEqual({ ok: true, port: 4200 });
    expect(listenPort("", 4201)).toEqual({ ok: true, port: 4201 });
    expect(listenPort("   ", 4200)).toEqual({ ok: true, port: 4200 });
  });

  test("a whole number in range is accepted", () => {
    expect(listenPort("4200", 4200)).toEqual({ ok: true, port: 4200 });
    expect(listenPort("4500", 4200)).toEqual({ ok: true, port: 4500 });
    expect(listenPort("1", 4200)).toEqual({ ok: true, port: 1 });
    expect(listenPort("65535", 4200)).toEqual({ ok: true, port: 65535 });
  });

  test("prefix typos and out-of-range values are refused", () => {
    expect(listenPort("42o0", 4200).ok).toBe(false);
    expect(listenPort("0", 4200).ok).toBe(false);
    expect(listenPort("65536", 4200).ok).toBe(false);
    expect(listenPort("-1", 4200).ok).toBe(false);
    expect(listenPort("1.5", 4200).ok).toBe(false);
  });
});
