/**
 * Who is signed in on this phone, and the token every request to OpenBot is sent with.
 *
 * The app signs in with OAuth (./oauth.ts): the system browser's sign-in session opens OpenBot's authorization page,
 * and comes back with a code the app exchanges for tokens. The access token lives in memory for its hour; the refresh
 * token is kept in the phone's secure store, one for each OpenBot, and rotates on every use. So one refresh runs at a
 * time, and the new refresh token is kept before the old one is let go.
 *
 * `authClient` keeps the shape the screens already read (`useSession`, `signOut`), so a screen doesn't know how the
 * person signed in. The person is who `GET /api/me` says the token belongs to.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";
import { BROWSER_OPTIONS, openWith } from "./link-company";
import {
  authorizationUrl,
  base64ToBase64Url,
  base64Url,
  CLIENT_ID,
  codeExchange,
  type Grant,
  METADATA_PATH,
  type Metadata,
  REDIRECT_URI,
  readCallback,
  readGrant,
  readMetadata,
  refreshExchange,
  SERVER_TOO_OLD,
  SignInError,
  signInEnded,
} from "./oauth";
import type { OrganizationStore } from "./organization";
import { clientHeaders } from "./release";

const configured = process.env.EXPO_PUBLIC_SERVER_URL;
if (!configured)
  throw new Error(
    "Set EXPO_PUBLIC_SERVER_URL to your OpenBot deployment before building OpenBot Mobile.",
  );
const endpoint = new URL(configured);
if (
  endpoint.protocol !== "https:" &&
  !(__DEV__ && endpoint.protocol === "http:")
)
  throw new Error("OpenBot native sign-in requires HTTPS.");
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error(
    "Use the public deployment URL without credentials or query parameters.",
  );
export const serverUrl = endpoint.origin;

/** What the phone keeps, named for this OpenBot, so a build pointed elsewhere never reads another's. */
const kept = (name: string) =>
  `openbot-${endpoint.host}-${name}`.replace(/[^a-zA-Z0-9._-]/g, "-");
const REFRESH_TOKEN_KEY = kept("refresh-token");

/** An access token this close to its end is replaced before it is used. */
const REFRESH_BEFORE_END_MS = 60_000;
/**
 * An access token OpenBot refused is replaced at most this often. Without it, an address that answers 401 whatever the
 * token would use up a refresh token on every request.
 */
const REFUSED_REFRESH_EVERY_MS = 30_000;

const UNREACHABLE = "Couldn't reach OpenBot. Try again in a moment.";
const NOT_FINISHED = "Sign-in didn't finish. Try again.";

/** The person signed in, as `GET /api/me` names them. */
export type SignedInPerson = { id: string; email?: string; name?: string };

/** What `useSession` answers, in the shape the screens read. */
export type Session = { user: SignedInPerson };
type SessionState = {
  data: Session | null;
  isPending: boolean;
  error: Error | null;
};

let state: SessionState = { data: null, isPending: true, error: null };
const listeners = new Set<() => void>();
function publish(next: SessionState) {
  state = next;
  for (const listener of [...listeners]) listener();
}

let live: { access: string; expires: number } | undefined;
/** Undefined until read from the secure store; null when there is none. */
let refreshToken: string | null | undefined;
let refreshing: Promise<string | null> | undefined;
let lastRefusalRefresh = 0;

let metadata: Promise<Metadata> | undefined;
function loadMetadata(): Promise<Metadata> {
  metadata ??= (async () => {
    let response: Response;
    try {
      response = await fetch(`${serverUrl}${METADATA_PATH}`, {
        headers: { ...clientHeaders(), accept: "application/json" },
        credentials: "omit",
      });
    } catch {
      throw new SignInError(UNREACHABLE);
    }
    if (response.status >= 500) throw new SignInError(UNREACHABLE);
    if (!response.ok) throw new SignInError(SERVER_TOO_OLD);
    return readMetadata(await response.json().catch(() => null), __DEV__);
  })();
  // A failed read is asked again next time.
  metadata.catch(() => {
    metadata = undefined;
  });
  return metadata;
}

type TokenAnswer = { ok: true; grant: Grant } | { ok: false; status: number };
async function tokenRequest(
  address: string,
  form: URLSearchParams,
): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await fetch(address, {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      credentials: "omit",
    });
  } catch {
    throw new SignInError(UNREACHABLE);
  }
  if (!response.ok) return { ok: false, status: response.status };
  return {
    ok: true,
    grant: readGrant(await response.json().catch(() => null)),
  };
}

async function storedRefreshToken(): Promise<string | null> {
  if (refreshToken === undefined)
    refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY).catch(
      () => null,
    );
  return refreshToken;
}

async function keep(grant: Grant): Promise<string> {
  if (grant.refreshToken && grant.refreshToken !== refreshToken) {
    refreshToken = grant.refreshToken;
    // Kept before anything else: the old one is already dead at OpenBot. A phone that can't keep it stays signed in
    // while the app runs, and asks again next time.
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, grant.refreshToken).catch(
      () => undefined,
    );
  }
  live = {
    access: grant.accessToken,
    expires: Date.now() + grant.expiresIn * 1000 - REFRESH_BEFORE_END_MS,
  };
  return grant.accessToken;
}

async function forget(): Promise<void> {
  live = undefined;
  refreshToken = null;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => undefined);
}

/** A new access token from the refresh token, one refresh at a time. Null when the sign-in is over. */
function refresh(): Promise<string | null> {
  refreshing ??= (async () => {
    const old = await storedRefreshToken();
    if (!old) return null;
    const { tokenEndpoint } = await loadMetadata();
    const answer = await tokenRequest(tokenEndpoint, refreshExchange(old));
    if (answer.ok) return keep(answer.grant);
    // Revoked, used twice, or its owner removed: this sign-in is over. Anything else, and it may still be good.
    if (signInEnded(answer.status)) {
      await forget();
      return null;
    }
    throw new SignInError(UNREACHABLE);
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** The access token to send, refreshed when it is about to end. Null when nobody is signed in. */
async function getAccessToken(): Promise<string | null> {
  if (live && Date.now() < live.expires) return live.access;
  return refresh();
}

/**
 * OpenBot refused `used` as signed out: a new token, when one can be had, to send the request again with. Null when it
 * can't, and the request's refusal stands.
 */
async function refreshAfterRefusal(used: string): Promise<string | null> {
  // Somebody else already replaced it.
  if (live && live.access !== used && Date.now() < live.expires)
    return live.access;
  if (Date.now() - lastRefusalRefresh < REFUSED_REFRESH_EVERY_MS) return null;
  lastRefusalRefresh = Date.now();
  live = undefined;
  return refresh().catch(() => null);
}

/** Who the token belongs to, or null when OpenBot says nobody. */
async function whoIsSignedIn(token: string): Promise<SignedInPerson | null> {
  const ask = (bearer: string) =>
    fetch(`${serverUrl}/api/me`, {
      headers: {
        ...clientHeaders(),
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
      },
      credentials: "omit",
    });
  let response = await ask(token).catch(() => {
    throw new SignInError(UNREACHABLE);
  });
  if (response.status === 401) {
    const again = await refreshAfterRefusal(token);
    if (!again) return null;
    response = await ask(again).catch(() => {
      throw new SignInError(UNREACHABLE);
    });
    if (response.status === 401) return null;
  }
  if (!response.ok) throw new SignInError(UNREACHABLE);
  const body = (await response.json().catch(() => null)) as {
    user?: { id?: unknown; email?: unknown; name?: unknown };
  } | null;
  const user = body?.user;
  if (!user || typeof user.id !== "string") throw new SignInError(UNREACHABLE);
  return {
    id: user.id,
    ...(typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
  };
}

/** Read again who is signed in. Unreachable, the person stays as they were, and the error says why. */
async function readSession(): Promise<void> {
  try {
    const token = await getAccessToken();
    const person = token ? await whoIsSignedIn(token) : null;
    if (!person) await forget();
    publish({
      data: person ? { user: person } : null,
      isPending: false,
      error: null,
    });
  } catch (failure) {
    publish({
      data: state.data,
      isPending: false,
      error: failure instanceof Error ? failure : new Error(UNREACHABLE),
    });
  }
}

let started = false;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    void readSession();
  }
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => state;

/**
 * Sign in to OpenBot in the system browser's sign-in session. Resolves false when the person closed the browser, and
 * throws a {@link SignInError} in the person's words when the sign-in was refused or didn't finish.
 */
export async function signIn(): Promise<boolean> {
  const found = await loadMetadata();
  const verifier = base64Url(Crypto.getRandomBytes(32));
  const nonce = base64Url(Crypto.getRandomBytes(16));
  const challenge = base64ToBase64Url(
    await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      verifier,
      { encoding: Crypto.CryptoEncoding.BASE64 },
    ),
  );
  const result = await WebBrowser.openAuthSessionAsync(
    authorizationUrl(found, { state: nonce, challenge }),
    REDIRECT_URI,
    BROWSER_OPTIONS,
  );
  if (result.type !== "success") return false;
  const code = readCallback(result.url, {
    state: nonce,
    ...(found.issuer ? { issuer: found.issuer } : {}),
  });
  const answer = await tokenRequest(
    found.tokenEndpoint,
    codeExchange(code, verifier),
  );
  if (!answer.ok) throw new SignInError(NOT_FINISHED);
  // Without a refresh token the person would be asked again within the hour.
  if (!answer.grant.refreshToken) throw new SignInError(SERVER_TOO_OLD);
  await keep(answer.grant);
  publish({ ...state, isPending: true });
  await readSession();
  if (!state.data) throw state.error ?? new SignInError(NOT_FINISHED);
  return true;
}

/** End this phone's sign-in: both tokens revoked at OpenBot where it can be reached, and forgotten here either way. */
async function signOut(): Promise<void> {
  const tokens: [string, string][] = [];
  const token = await storedRefreshToken();
  if (token) tokens.push([token, "refresh_token"]);
  if (live) tokens.push([live.access, "access_token"]);
  await forget();
  publish({ data: null, isPending: false, error: null });
  const revocation = await loadMetadata()
    .then((found) => found.revocationEndpoint)
    .catch(() => undefined);
  if (!revocation) return;
  await Promise.all(
    tokens.map(([value, hint]) =>
      fetch(revocation, {
        method: "POST",
        headers: {
          ...clientHeaders(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: value,
          token_type_hint: hint,
          client_id: CLIENT_ID,
        }).toString(),
        credentials: "omit",
      }).catch(() => undefined),
    ),
  );
}

export const authClient = {
  /** Who is signed in. Pending until the phone has asked OpenBot once. */
  useSession() {
    const current = useSyncExternalStore(subscribe, snapshot, snapshot);
    return { ...current, refetch: readSession };
  },
  getAccessToken,
  refreshAfterRefusal,
  signOut,
};

/**
 * Open an address in the system browser's sign-in session (ASWebAuthenticationSession on iOS, Custom Tabs on Android),
 * never a web view: a company's sign-in is entered where the person can see whose page it is. Resolves when it comes
 * back to `returnTo` or is closed. Linking the company account opens its single-use ticket here (../link-company.ts).
 */
// In the app's own task on Android, so the tab goes when the app comes back (BROWSER_OPTIONS says why).
export const openInSystemBrowser = openWith(WebBrowser.openAuthSessionAsync);

/**
 * Where each person's pick of organization is kept on this phone (../organization.ts): beside the sign-in, one place
 * for each OpenBot and each person on it, so a phone people share opens in each one's own pick.
 */
const pickedOrganization = (person: string) =>
  `openbot-${endpoint.host}-organization-${person}`.replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
export const organizationStore: OrganizationStore = {
  read: (person) => SecureStore.getItemAsync(pickedOrganization(person)),
  write: (person, id) =>
    SecureStore.setItemAsync(pickedOrganization(person), id),
};

/**
 * Renew a hosted OpenBot's sign-in: its hosted sign-in (`signIn`, a path on this OpenBot) opened in the in-app browser,
 * as sign-in itself is. Somebody still signed in to OpenBot by CopilotKit goes through it with nothing to type; it
 * resolves when the browser comes back or is closed, and the request is then sent again.
 */
export async function renewHostedSignIn(signIn: string): Promise<void> {
  const address = new URL(signIn, serverUrl);
  address.searchParams.set("returnTo", "openbotmobile://renewed");
  await WebBrowser.openAuthSessionAsync(address.href, "openbotmobile://");
}
