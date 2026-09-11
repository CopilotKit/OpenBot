const PENDING_AUTH_RETURN_KEY = "openbot.pending-slack-return";
const PENDING_AUTH_RETURN_MS = 10 * 60_000;

type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type PendingAuthReturn = {
  path: string;
  expiresAt: number;
};

/**
 * The only return URL allowed through the sign-in handoff. It deliberately carries no origin,
 * arbitrary route, fragment, or duplicate query field, so this record can never become an open
 * redirect or be forwarded to an identity provider.
 */
export function pendingAuthReturnPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;

  const url = new URL(value, "https://openbot.invalid");
  if (
    (url.pathname !== "/link/slack" && url.pathname !== "/assist") ||
    url.hash !== "" ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll("token").length !== 1
  ) {
    return null;
  }

  const token = url.searchParams.get("token")?.trim();
  return token ? `${url.pathname}?token=${encodeURIComponent(token)}` : null;
}

export function savePendingAuthReturn(
  value: string,
  storage: SessionStorageLike,
  now = Date.now(),
): boolean {
  const path = pendingAuthReturnPath(value);
  if (!path) return false;

  try {
    storage.setItem(
      PENDING_AUTH_RETURN_KEY,
      JSON.stringify({ path, expiresAt: now + PENDING_AUTH_RETURN_MS }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Always removes the record before inspecting it, so a return is strictly one-time. */
export function consumePendingAuthReturn(
  storage: SessionStorageLike,
  now = Date.now(),
): string | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_AUTH_RETURN_KEY);
    storage.removeItem(PENDING_AUTH_RETURN_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<PendingAuthReturn>;
    if (
      typeof record.path !== "string" ||
      typeof record.expiresAt !== "number"
    ) {
      return null;
    }
    if (record.expiresAt <= now) return null;
    return pendingAuthReturnPath(record.path);
  } catch {
    return null;
  }
}

/** Prevents the authenticated boundary from redirecting to the route it is already loading. */
export function signedInReturnRedirect(
  currentHref: string,
  pendingReturn: string | null,
): string | null {
  const path = pendingReturn ? pendingAuthReturnPath(pendingReturn) : null;
  let current: string | null = null;
  try {
    const currentUrl = new URL(currentHref, "https://openbot.invalid");
    current = pendingAuthReturnPath(
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    );
  } catch {
    // An unparseable current location cannot equal the validated pending return.
  }
  return path && path !== current ? path : null;
}
