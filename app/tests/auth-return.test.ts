import { expect, test } from "bun:test";
import {
  consumePendingAuthReturn,
  pendingAuthReturnPath,
  savePendingAuthReturn,
  signedInReturnRedirect,
} from "@/lib/auth/pending-return";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test("accepts only the two auth-return routes with one non-empty token", () => {
  expect(pendingAuthReturnPath("/link/slack?token=claim")).toBe(
    "/link/slack?token=claim",
  );
  expect(pendingAuthReturnPath("/assist?token=control-claim")).toBe(
    "/assist?token=control-claim",
  );
  expect(pendingAuthReturnPath("/link/slack?token= claim ")).toBe(
    "/link/slack?token=claim",
  );

  for (const rejected of [
    "https://evil.example/link/slack?token=claim",
    "//evil.example/link/slack?token=claim",
    "/admin?token=claim",
    "/link/slack",
    "/link/slack?token=",
    "/link/slack?token=one&token=two",
    "/link/slack?token=claim#fragment",
    "/assist?token=claim&extra=1",
    "/assist?token=claim#fragment",
    "https://openbot.invalid/assist?token=claim",
    "/%2f%2fevil.example/assist?token=claim",
  ]) {
    expect(pendingAuthReturnPath(rejected)).toBeNull();
  }
});

test("saves an expiring one-time Slack return and consumes it after auth", () => {
  const session = storage();
  expect(savePendingAuthReturn("/link/slack?token=claim", session, 100)).toBe(
    true,
  );
  expect(consumePendingAuthReturn(session, 100 + 60_000)).toBe(
    "/link/slack?token=claim",
  );
  expect(consumePendingAuthReturn(session, 100 + 60_000)).toBeNull();
});

test("rejects and deletes expired or malformed saved returns", () => {
  const session = storage();
  savePendingAuthReturn("/link/slack?token=claim", session, 0);
  expect(consumePendingAuthReturn(session, 10 * 60_000 + 1)).toBeNull();
  expect(consumePendingAuthReturn(session, 10 * 60_000 + 1)).toBeNull();
});

test("redirects a signed-in person only to a consumed Slack return", () => {
  expect(signedInReturnRedirect("/", "/link/slack?token=claim")).toBe(
    "/link/slack?token=claim",
  );
  expect(
    signedInReturnRedirect(
      "https://openbot.test/link/slack?token=claim",
      "/link/slack?token=claim",
    ),
  ).toBeNull();
  expect(signedInReturnRedirect("/", null)).toBeNull();
});

test("preserves an exact assistance return across signed-out sign-in", () => {
  const session = storage();
  expect(
    savePendingAuthReturn("/assist?token=sealed-control", session, 100),
  ).toBe(true);

  const consumed = consumePendingAuthReturn(session, 200);
  expect(signedInReturnRedirect("/sign", consumed)).toBe(
    "/assist?token=sealed-control",
  );
  expect(consumePendingAuthReturn(session, 200)).toBeNull();
});
