import { describe, expect, test } from "bun:test";
import {
  createInMemoryCompanionStore,
  isPairingCodeShape,
  PAIRING_CODE_TTL_MS,
} from "./store";

describe("companion pairing store", () => {
  test("a minted code exchanges for a binding", async () => {
    const store = createInMemoryCompanionStore();
    const code = await store.mint("bot-1");
    const result = await store.exchange(code, "photon-drey");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agentId).toBe("bot-1");
    const binding = await store.binding("bot-1");
    expect(binding?.phoneId).toBe("photon-drey");
  });

  test("a code spends exactly once", async () => {
    const store = createInMemoryCompanionStore();
    const code = await store.mint("bot-2");
    expect((await store.exchange(code, "phone-a")).ok).toBe(true);
    const again = await store.exchange(code, "phone-b");
    expect(again).toEqual({ ok: false, refusal: "unknown" });
  });

  test("a wrong code is refused without saying which part was wrong", async () => {
    const store = createInMemoryCompanionStore();
    await store.mint("bot-3");
    const wrong = await store.exchange("ZZZZZZ", "phone-a");
    expect(wrong).toEqual({ ok: false, refusal: "unknown" });
  });

  test("a malformed code is refused as malformed", async () => {
    const store = createInMemoryCompanionStore();
    const bad = await store.exchange("abc", "phone-a");
    expect(bad).toEqual({ ok: false, refusal: "malformed" });
  });

  test("an expired code is refused and consumed", async () => {
    const store = createInMemoryCompanionStore();
    const t0 = new Date("2026-09-05T12:00:00Z");
    const code = await store.mint("bot-4", t0);
    const late = new Date(t0.getTime() + PAIRING_CODE_TTL_MS + 60_000);
    const result = await store.exchange(code, "phone-a", late);
    expect(result).toEqual({ ok: false, refusal: "expired" });
    // Consumed: a later try is unknown, not expired.
    const retry = await store.exchange(code, "phone-a", late);
    expect(retry).toEqual({ ok: false, refusal: "unknown" });
  });

  test("touch moves lastSeen only for the bound phone", async () => {
    const store = createInMemoryCompanionStore();
    const code = await store.mint("bot-5");
    await store.exchange(code, "phone-a");
    const before = (await store.binding("bot-5"))?.lastSeenAt;
    const later = new Date((before ?? new Date()).getTime() + 5_000);
    await store.touch("bot-5", "phone-b", later);
    expect((await store.binding("bot-5"))?.lastSeenAt).toEqual(before);
    await store.touch("bot-5", "phone-a", later);
    expect((await store.binding("bot-5"))?.lastSeenAt).toEqual(later);
  });

  test("sweep drops expired codes only", async () => {
    const store = createInMemoryCompanionStore();
    const t0 = new Date("2026-09-05T12:00:00Z");
    await store.mint("bot-old", t0);
    await store.mint("bot-new", new Date(t0.getTime() + PAIRING_CODE_TTL_MS / 2));
    const later = new Date(t0.getTime() + PAIRING_CODE_TTL_MS + 60_000);
    const dropped = await store.sweep(later);
    expect(dropped).toBe(1);
  });

  test("codes use the unambiguous alphabet", async () => {
    const store = createInMemoryCompanionStore();
    const code = await store.mint("bot-6");
    expect(code).toHaveLength(6);
    expect(isPairingCodeShape(code)).toBe(true);
    expect(code).not.toMatch(/[0O1IL]/);
  });
});
