/**
 * Private sign-in and saved passwords.
 *
 * The rule the whole module is built around: a credential goes from the person's form to the Bot's
 * browser and nowhere else. It is never a tool argument, never a tool result, never a transcript row,
 * never an AG-UI event, never an audit payload and never a log line. The model is told only whether
 * the sign-in worked.
 */

export type SignInStatus =
  | "pending"
  | "filling"
  /** The site accepted the password and sent a verification code; the form now asks for only that. */
  | "code_required"
  | "taken_over"
  | "signed_in"
  | "failed"
  | "cancelled"
  | "expired";

/** How the person answered: typed credentials, a saved login they confirmed, or a takeover. */
export type SignInMethod = "typed" | "saved" | "takeover";

export type SignInRequestRecord = {
  id: string;
  ownerUserId: string;
  botId: string;
  origin: string;
  reason: string | null;
  status: SignInStatus;
  method: SignInMethod | null;
  outcome: string | null;
  threadId: string | null;
  toolCallId: string | null;
  controlRequestId: string | null;
  continuation: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  /** While `filling`: when the attempt is given up on as abandoned (a server that died mid-fill). */
  fillingUntil: Date | null;
};

/** What a route may return about a request. No continuation, which carries the conversation. */
export type SignInRequestView = Omit<
  SignInRequestRecord,
  "continuation" | "ownerUserId"
> & {
  /** Saved logins for this site, by username. Offered only while the password manager is on. */
  savedLogins: { id: string; username: string }[];
  passwordManager: boolean;
};

/** A saved login as the store holds it: never its password, which only `revealPassword` reads. */
export type SavedLoginRecord = {
  id: string;
  ownerUserId: string;
  origin: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

/** A saved login as any route shows it. */
export type SavedLoginView = Omit<SavedLoginRecord, "ownerUserId">;

export type PasswordStore = {
  createRequest(
    input: Omit<
      SignInRequestRecord,
      | "status"
      | "method"
      | "outcome"
      | "controlRequestId"
      | "createdAt"
      | "resolvedAt"
      | "fillingUntil"
    >,
  ): Promise<SignInRequestRecord>;
  request(ownerUserId: string, id: string): Promise<SignInRequestRecord | null>;
  pendingRequests(ownerUserId: string): Promise<SignInRequestRecord[]>;
  /**
   * Move a request on, only from one of `from`. Returns null when it was not in one of them, which is
   * how two submits racing each other end with exactly one sign-in.
   */
  transition(
    ownerUserId: string,
    id: string,
    from: readonly SignInStatus[],
    to: Partial<
      Pick<
        SignInRequestRecord,
        | "status"
        | "method"
        | "outcome"
        | "controlRequestId"
        | "resolvedAt"
        | "fillingUntil"
      >
    >,
  ): Promise<SignInRequestRecord | null>;
  logins(ownerUserId: string, origin?: string): Promise<SavedLoginRecord[]>;
  login(ownerUserId: string, id: string): Promise<SavedLoginRecord | null>;
  saveLogin(input: {
    ownerUserId: string;
    origin: string;
    username: string;
    password: string;
  }): Promise<SavedLoginRecord>;
  /**
   * The password of one of this person's saved logins, for the Bot it is about to be typed for, or
   * null when there is no such login any more. Recorded by the vault: who, which login, which Bot.
   */
  revealPassword(
    ownerUserId: string,
    id: string,
    botId: string,
  ): Promise<string | null>;
  touchLogin(ownerUserId: string, id: string): Promise<void>;
  deleteLogin(ownerUserId: string, id: string): Promise<boolean>;
};

export class SignInRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "SignInRefusedError";
  }
}

/**
 * A site as the origin a login belongs to.
 *
 * A saved login is for one origin exactly, the way a browser's password manager scopes one, so a
 * login saved for `https://example.com` is never offered on `https://example.com.evil.test`, on
 * `http://example.com`, or on a subdomain. Only http(s); a bare host is read as https.
 */
export function originOf(site: string): string {
  const trimmed = site.trim();
  if (!trimmed) throw new SignInRefusedError("Name the website to sign in to.");
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new SignInRefusedError(
      `${trimmed.slice(0, 200)} is not a website address.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new SignInRefusedError(
      "Only http and https websites can be signed in to.",
    );
  if (url.username || url.password)
    throw new SignInRefusedError(
      "A website address must not carry credentials.",
    );
  return url.origin;
}
