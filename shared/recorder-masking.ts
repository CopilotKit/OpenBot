// Masking for everything the Recorder captures, applied in the browser before anything leaves it. Intelligence does no
// server-side redaction, so these functions are the only defence for what reaches it. DOM-free and import-free: the same
// file runs in the service worker, content scripts, the MAIN-world bundle, the offscreen document and Bun.

/** The collector's own marker (`@copilotkit/learning` 0.0.1 `src/types.ts` REDACTED), so the two agree. */
export const REDACTED = "[redacted]";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type CapturedEvent = {
  type: "CUSTOM";
  name: string;
  timestamp: number;
  value: JsonValue;
};
/** `url` is the address a body was sent to: on a sign-in, verification or token request a bare `code` key is a secret
 * whatever it holds. */
type MaskOptions = { digests?: ReadonlySet<string>; url?: string };
/** MaskOptions as the body maskers read them, with the request's address already judged. */
type BodyOptions = MaskOptions & { authFlow?: boolean };
type Obj = { [key: string]: JsonValue };

/** A 3-digit security code is a secret too, so digests of values this short still match. */
export const MIN_DIGEST_LENGTH = 3;
/** Intelligence's per-event limit. */
export const MAX_EVENT_BYTES = 16 * 1024;
/** Intelligence refuses timestamps at or above 253,402,300,800,000. */
export const MAX_TIMESTAMP_MS = 253_402_300_800_000 - 1;
/** Leaves room for the seq and envelope the streamer adds to each event. */
export const EVENT_BUDGET_BYTES = 15 * 1024;

/** Copy of `shared/demonstration-rules.ts` SENSITIVE_FIELD (this file has no imports); `shared/sensitive-rule.test.ts` keeps the two equal. */
export const SENSITIVE_FIELD =
  /password|secret|token|one.time|verification|credit.card|security.code|passcode|card.?(?:number|num|no)(?![a-z])|cardholder|card.?verification|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|csc|pin|otp)(?![a-z]))/i;

// The next three are copied exactly from `@copilotkit/learning` 0.0.1 `src/redact.ts` (`CREDENTIAL`, `CREDENTIAL_WORD`, `METADATA`).
/** Matches anywhere in a key's joined lowercase words (collector `CREDENTIAL`). */
const CREDENTIAL =
  /password|passwd|passphrase|passcode|credential|api(key|token)|privatekey|subscriptionkey|(access|refresh|auth|session)token|clientsecret/;
/** Matches only as whole words, as the last word, or as the entire key (collector `CREDENTIAL_WORD`). */
const CREDENTIAL_WORD =
  / (secret|id ?token)s? | (authorization|cookies?|jwt|bearer ?token|[cx]srf ?token) $|^ (pwd|pass|token|otp) $/;
/** Metadata about a credential is not the credential (collector `METADATA`), checked first. */
const METADATA =
  / (ids?|at|in|expires?|expiry|length|count|enabled|required|policy|hint|type) $/;
/** OpenBot's addition: payment-card keys that are the entire key (plan Task 3, Decision 15). */
const CARD_KEY = /^ (pin|cvv|cvc|csc) $/;
/** OpenBot's addition: payment-card keys matched on the joined words (plan Task 3, Decision 15). */
const CARD_WORDS = /cardnumber|ccnumber|cardverification/;
/** OpenBot's addition: one-time and verification code keys, matched on the joined words (`verificationCode`, `mfa_code`,
 * `two_factor_code`, `smsCode`, `authCode`, `code_verifier`), never an ordinary code (`zipCode`, `promoCode`, `errorCode`). */
const ONE_TIME_CODE_WORDS =
  /(?:verification|verify|verif|otp|totp|hotp|mfa|2fa|twofactor|2factor|twostep|2step|multifactor|sms|auth|authentication|authenticator|authorization|login|signin|logon|security|access|confirmation|onetime|recovery|backup)(?:code|pin|otp)|onetimepass|codeverifier|(?:mfa|2fa|twofactor|otp|totp)token/;
/** OpenBot's addition: one-time code keys that are the last word or the entire key (`otp`, `totp`, `x-otp`). */
const ONE_TIME_CODE_LAST = / (?:otp|totp|hotp|otc)s? $/;
/** A bare `code` key: a one-time code when it holds 4 to 10 digits, or on a sign-in request (`codeHoldsSecret`). */
const BARE_CODE = /^ codes? $/;
/** 4 to 10 digits: what a one-time code sent by text, email or an authenticator app holds. */
const CODE_DIGITS = /^\d{4,10}$/;
/** A sign-in, verification, token or OAuth address, read from its host and path split into words (`authFlowUrl`); never
 * "author". */
const AUTH_URL_WORDS =
  / (?:auth(?!or)[a-z\d]*|oauth[a-z\d]*|login|logon|log in|signin|sign in|sso|saml|oidc|openid|mfa|2 ?fa|two ?factor|2 ?step|two ?step|otp|totp|verif[a-z]*|tokens?|callback|challenge) /;
/** Headers whose values are credentials whatever their name looks like (plan Task 3 `CREDENTIAL_HEADERS`). */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "private-token",
  "x-token",
]);
/** JSON web tokens, three dot-separated base64url parts (plan Task 3 `scrubText`): the same matches as
 * `/eyJ[\w-]+\.[\w-]+\.[\w-]*\/g`, tried once per run of `[\w-]` so a long dotless run full of `eyJ` stays linear. Group 1 is
 * what precedes the run's first `eyJ` and is put back; each lookahead and backreference pair is atomic, so no part is re-scanned. */
const JWT =
  /(?<![\w-])((?:(?!eyJ)[\w-])*)eyJ(?=([\w-]+))\2\.(?=([\w-]+))\3\.[\w-]*/g;
/** The value after an auth scheme word (plan Task 3 `scrubText`). */
const AUTH_SCHEME = /\b(bearer|basic|token)(\s+)([^\s"',;]+)/gi;
/** Long unbroken runs; no `/` in the class so a readable path or slug survives (plan Task 3 `scrubText`). */
const LONG_RUN = /[A-Za-z0-9_+=-]{32,}/g;
/** Email addresses, bounded by RFC 5321's 64-octet local part and 255-octet domain so a long run without whitespace is
 * scanned in linear time (plan Task 3 `scrubText`). */
const EMAIL = /[^\s@"'<>]{1,64}@[^\s@"'<>]{1,255}\.[A-Za-z]{2,}/g;
/** A whole run of digit groups separated by single spaces or dashes, touching no word character: card number candidates
 * (plan Task 3 `scrubText`). */
const CARD_GROUPS = /(?<!\w)\d+(?:[ -]\d+)*(?!\w)/g;
/** A card number is 13 to 19 digits (ISO/IEC 7812-1, the range plan Task 3 `scrubText` checks). */
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;
/** The shortest group in a written card number (4-4-4-4, 4-6-5, 4-6-4, 4-4-4-4-3), so a row of page numbers is never one. */
const CARD_MIN_GROUP_DIGITS = 3;
/** A run of digit groups separated by single spaces or dashes, re-joined before hashing (plan Task 3 `scrubText`); anchored at
 * the start of a digit run so a long run of digits is scanned once, not once per digit. */
const DIGIT_GROUPS = /(?<!\d)\d+(?:[ -]\d+)+/g;
/** The most consecutive digit groups hashed as one digest candidate (a card written 4-4-4-4-3 is five). */
const MAX_DIGEST_GROUPS = 6;
/** The most digest answers one `scrubText` call remembers (see `digestMatcher`). */
const DIGEST_MEMO_LIMIT = 4096;
/** Where one token ends when hashing digest candidates (plan Task 3 `scrubText`). */
const TOKEN_CHARS = /[^\s,;&=:"'{}[\]]+/g;
/** A second, finer split for digest candidates, so a secret beside a full stop, a bracket or markup is found too ("737.",
 * "<td>737</td>"); the first split still finds a secret that contains these characters ("p.ss"). */
const TOKEN_CHARS_FINE = /[^\s,;&=:"'{}[\]().<>/\\?!|*`]+/g;
/** Only digits, spaces and dashes: normalised to digits (plan Task 3 `normaliseSecret`). */
const DIGITS_AND_SEPARATORS = /^[\d\s-]+$/;
/** Form bodies are masked pair by pair (plan Task 3 maskBody). */
const FORM_CONTENT_TYPE = /application\/x-www-form-urlencoded/i;
/** A first `key=` with no whitespace in the key: a form body, whatever type it was declared with (a string a page posts
 * as text/plain, or a URLSearchParams body whose type the page-level hook could not see). */
const FORM_START = /^[^\s=&]+=/;
const LINE_BREAK = /[\r\n]/;
/** application/json and every +json type. */
const JSON_CONTENT_TYPE = /[/+]json\s*(?:;|$)/i;
/** Text that opens like a JSON object or array: once cut short it no longer parses, whatever type it was declared with. */
const JSON_START = /^\s*[[{]/;
/** What a redacted JSON value becomes in JSON text. */
const REDACTED_JSON = JSON.stringify(REDACTED);
/** Input event target fields that hold what the person typed or chose (plan Task 3 `maskCollectorEvent`). */
const TARGET_VALUE_FIELDS = ["value", "text"] as const;
/** Attributes that hold a field's value by name (`value`, `aria-valuetext`, `aria-valuenow`, `data-value`,
 * `data-initial-value`, `ng-reflect-value`); a sensitive field loses each, and any other attribute that echoes the value. */
const VALUE_ATTRIBUTE = /value/i;
/** The shortest stretch of an edited field's content another attribute must hold to be a copy of it, as an attribute a page
 * set from what was typed a keystroke or a render earlier is: long enough that a short attribute (`rows="1"`) is never one. */
const COPY_MIN_LENGTH = 8;
/** Intelligence rejects a NUL at any depth. */
const NUL = "\u0000";
/** Longest `target.value` and `target.text` kept when trimming (plan Task 3 `trimEvent`). */
const TRIMMED_TARGET_TEXT = 200;

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An attribute that repeats one of `typed` (a sensitive field's value): contains it, spaced or not, or for a value shorter
 * than MIN_DIGEST_LENGTH is it. */
const echoes = (attribute: unknown, typed: readonly string[]): boolean => {
  if (typeof attribute !== "string" || attribute === REDACTED) return false;
  return typed.some((value) => {
    const trimmed = value.trim();
    const normalised = normaliseSecret(trimmed);
    return normalised.length >= MIN_DIGEST_LENGTH
      ? attribute.includes(trimmed) ||
          normaliseSecret(attribute).includes(normalised)
      : attribute.trim() === trimmed;
  });
};

/** An attribute that copies what was typed into a field: it holds the whole of it (`echoes`), or a stretch of it at least
 * COPY_MIN_LENGTH long, as a copy made a keystroke earlier does. */
const copies = (attribute: unknown, typed: string): boolean => {
  if (typeof attribute !== "string" || attribute === REDACTED) return false;
  const copy = attribute.trim();
  return (
    echoes(attribute, [typed]) ||
    (copy.length >= COPY_MIN_LENGTH && typed.includes(copy))
  );
};

/** A field whose text and value attributes are copies of what is typed into it: an input (React keeps its `value`
 * attribute at the value it last rendered), a textarea (its text is its default value, which React keeps at the value it
 * last rendered, a keystroke behind the one an input event reads) and an editable region (its text is its value). Never a
 * select: its text lists every option. */
const mirrorsValue = (
  tag: string | undefined,
  attributes: Record<string, string> | undefined,
): boolean => {
  const name = tag?.toLowerCase();
  const editable = attributes?.contenteditable;
  return (
    name === "input" ||
    name === "textarea" ||
    (typeof editable === "string" && editable.toLowerCase() !== "false")
  );
};

const decodeQuietly = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

export function normaliseSecret(value: string): string {
  const trimmed = value.trim();
  return DIGITS_AND_SEPARATORS.test(trimmed)
    ? trimmed.replace(/[\s-]/g, "")
    : trimmed;
}

/** A key's lowercase words, one space apart and one space at each end, each escape decoded on its own (collector rule). */
const keyWords = (key: string): string =>
  ` ${key
    .replace(/%([\da-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/([a-z\d])(?=[A-Z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .join(" ")} `;

export function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  if (METADATA.test(words)) return false;
  const joined = words.replace(/ /g, "");
  return (
    CREDENTIAL.test(joined) ||
    CREDENTIAL_WORD.test(words) ||
    CARD_KEY.test(words) ||
    CARD_WORDS.test(joined) ||
    ONE_TIME_CODE_WORDS.test(joined) ||
    ONE_TIME_CODE_LAST.test(words)
  );
}

const isBareCodeKey = (key: string): boolean => BARE_CODE.test(keyWords(key));
const isStateKey = (key: string): boolean => keyWords(key) === " state ";

/** What a bare `code` key holds is a one-time code: 4 to 10 digits (spaces and dashes aside, or a list of them), or anything
 * at all on a sign-in, verification or token request, so an ordinary `"code":"NOT_FOUND"` survives elsewhere. */
const codeHoldsSecret = (
  value: JsonValue | undefined,
  authFlow: boolean | undefined,
): boolean => {
  if (authFlow) return true;
  if (typeof value === "string")
    return CODE_DIGITS.test(normaliseSecret(value));
  if (typeof value === "number") return CODE_DIGITS.test(String(value));
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => codeHoldsSecret(item, false))
  );
};

/** Text split into lowercase words, one space apart and one space at each end (`codeEntry` and `code-entry` are both
 * " code entry ", `6DigitCode` is " 6 digit code ", `2FACode` is " 2fa code "). */
const fieldWords = (text: string): string =>
  ` ${text
    .replace(/([a-z])(?=[A-Z])/g, "$1 ")
    .replace(/(\d)(?=[A-Z][a-z])/g, "$1 ")
    .replace(/([A-Z]+)(?=[A-Z][a-z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .join(" ")} `;

/** True for a sign-in, verification, token or OAuth address, read from its host and path. */
export function authFlowUrl(url: string | undefined): boolean {
  if (!url) return false;
  let where: string;
  try {
    const parsed = new URL(url);
    where = `${parsed.hostname} ${parsed.pathname}`;
  } catch {
    where = url.replace(/[?#].*$/, "");
  }
  return AUTH_URL_WORDS.test(fieldWords(decodeQuietly(where)));
}

function isCredentialHeader(name: string): boolean {
  return isCredentialKey(name) || CREDENTIAL_HEADERS.has(name.toLowerCase());
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** SHA-256 round constants (FIPS 180-4 section 4.2.2). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) in plain JavaScript: synchronous and identical in every context, including insecure http pages
 * where `crypto.subtle` does not exist. */
export function sha256HexSync(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(
    padded.length - 8,
    Math.floor((bytes.length * 8) / 0x100000000),
  );
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const word = (list: ArrayLike<number>, i: number) => list[i] ?? 0;
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = word(w, i - 15);
      const w2 = word(w, i - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) >>> 0;
    }
    const state = Array.from(h);
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, hh = 0] = state;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          word(K, i) +
          word(w, i)) >>>
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (word(h, i) + word(next, i)) >>> 0;
  }
  return Array.from(h, (part) => part.toString(16).padStart(8, "0")).join("");
}

const matchesDigest = (value: string, options?: MaskOptions): boolean => {
  const digests = options?.digests;
  if (!digests || digests.size === 0) return false;
  const normalised = normaliseSecret(value);
  return (
    normalised.length >= MIN_DIGEST_LENGTH &&
    digests.has(sha256HexSync(normalised))
  );
};

/** One group of a digit run and where it sits in the run, as character offsets. */
type DigitGroup = { digits: string; start: number; end: number };

/** Splits a run matched by `CARD_GROUPS` or `DIGIT_GROUPS`, whose groups are always one separator apart. */
const digitGroupsOf = (run: string): DigitGroup[] => {
  const groups: DigitGroup[] = [];
  let start = 0;
  for (const digits of run.split(/[ -]/)) {
    groups.push({ digits, start, end: start + digits.length });
    start += digits.length + 1;
  }
  return groups;
};

/** Replaces each `[start, end)` span of `text` with REDACTED; overlapping spans become one marker, disjoint ones stay apart. */
const redactSpans = (text: string, spans: Array<[number, number]>): string => {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) {
      // Overlaps the span just redacted: widen that marker instead of adding another.
      cursor = Math.max(cursor, end);
      continue;
    }
    out += text.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + text.slice(cursor);
};

const isCardNumber = (digits: string): boolean =>
  digits.length >= CARD_MIN_DIGITS &&
  digits.length <= CARD_MAX_DIGITS &&
  luhnValid(digits);

/** A whole run that is a card number goes; otherwise every stretch of consecutive groups that could be a written card number
 * (each group at least 3 digits, 13 to 19 digits in all) is tested on its own, so a card beside an expiry, a security code or
 * a quantity is still found. A run of one group is a card number or nothing, as before. */
const scrubCardRun = (run: string): string => {
  if (isCardNumber(run.replace(/[ -]/g, ""))) return REDACTED;
  const groups = digitGroupsOf(run);
  if (groups.length === 1) return run;
  const spans: Array<[number, number]> = [];
  for (let first = 0; first < groups.length; first++) {
    const head = groups[first];
    if (!head) continue;
    let digits = "";
    for (let last = first; last < groups.length; last++) {
      const group = groups[last];
      if (!group || group.digits.length < CARD_MIN_GROUP_DIGITS) break;
      digits += group.digits;
      if (digits.length > CARD_MAX_DIGITS) break;
      if (isCardNumber(digits)) spans.push([head.start, group.end]);
    }
  }
  return redactSpans(run, spans);
};

/** `matchesDigest` for one `scrubText` call, hashing each distinct candidate once, so repeated words and numbers cost one hash.
 * The digests cannot change during a synchronous call, so a remembered answer is never stale; at most `DIGEST_MEMO_LIMIT`
 * answers are kept, so a body of distinct tokens cannot grow it without bound. */
const digestMatcher = (options: MaskOptions): ((value: string) => boolean) => {
  const known = new Map<string, boolean>();
  return (value) => {
    const remembered = known.get(value);
    if (remembered !== undefined) return remembered;
    const hit = matchesDigest(value, options);
    if (known.size < DIGEST_MEMO_LIMIT) known.set(value, hit);
    return hit;
  };
};

/** A whole run whose digits match a digest goes; otherwise every stretch of up to `MAX_DIGEST_GROUPS` consecutive groups is
 * hashed on its own, so a typed number is found beside other numbers ("4111 1111 1111 1112 12/28"). */
const scrubDigestRun = (
  run: string,
  matches: (value: string) => boolean,
): string => {
  if (matches(run.replace(/[ -]/g, ""))) return REDACTED;
  const groups = digitGroupsOf(run);
  const spans: Array<[number, number]> = [];
  for (let first = 0; first < groups.length; first++) {
    const head = groups[first];
    if (!head) continue;
    let digits = "";
    const stop = Math.min(groups.length, first + MAX_DIGEST_GROUPS);
    for (let last = first; last < stop; last++) {
      const group = groups[last];
      if (!group) break;
      digits += group.digits;
      if (matches(digits)) spans.push([head.start, group.end]);
    }
  }
  return redactSpans(run, spans);
};

export function scrubText(text: string, options?: MaskOptions): string {
  let out = text
    .replace(JWT, `$1${REDACTED}`)
    .replace(AUTH_SCHEME, `$1$2${REDACTED}`)
    .replace(LONG_RUN, (run) =>
      /[A-Za-z]/.test(run) && /\d/.test(run) ? REDACTED : run,
    )
    .replace(EMAIL, REDACTED)
    .replace(CARD_GROUPS, (run) => scrubCardRun(run));
  if (options?.digests && options.digests.size > 0) {
    const matches = digestMatcher(options);
    const redactToken = (token: string) => (matches(token) ? REDACTED : token);
    out = out
      .replace(DIGIT_GROUPS, (run) => scrubDigestRun(run, matches))
      .replace(TOKEN_CHARS, redactToken)
      .replace(TOKEN_CHARS_FINE, redactToken);
  }
  return out;
}

/** What joins the numerals of a number read aloud, as a speech service writes it: a comma, a full stop or a dash, alone or
 * with spaces around it, or spaces alone ("4012-888888-1881", "4 0 1 2, 8 8 8 8", "$4,2424,2424,2424,242"). */
const SPOKEN_GAP = String.raw`(?:\s*[,.\-\u2013]\s*|\s+)`;
/** A number read aloud: numerals, in any script, joined by `SPOKEN_GAP`, and the name of a month said just before it. */
const SPOKEN_NUMBER = new RegExp(
  String.raw`(\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?<!\p{Nd})(\p{Nd}+(?:${SPOKEN_GAP}\p{Nd}+)*)`,
  "giu",
);
/** A speech service drops digits of a number read aloud and runs others together, so a card, account or phone number
 * comes back neither whole nor valid: any spoken number of this many digits goes, whatever its checksum. */
const SPOKEN_DIGITS_REDACTED = 6;
/** Words that say a secret number follows: every number after one, to the end of the phrase, goes however short. */
const SPOKEN_SECRET =
  /\b(?:cards?|credit|debit|accounts?|routing|iban|ssn|social\s+security|pin|cvv\d?|cvc|security\s+codes?|pass[\s-]?codes?|pass[\s-]?words?|otp|verification\s+codes?)\b/i;
/** One word; after a `SPOKEN_SECRET` word, one with a numeral in it goes whole ("hunter2"). */
const SPOKEN_WORD = /[\p{L}\p{N}]+/gu;
const HAS_NUMERAL = /\p{Nd}/u;
/** Markers `SPOKEN_WORD` left one gap apart ("[redacted] [redacted] [redacted]" for "4 0 1"), folded into one. */
const REDACTED_RUN = new RegExp(
  `${REDACTED.replace(/[[\]]/g, "\\$&")}(?:${SPOKEN_GAP}${REDACTED.replace(/[[\]]/g, "\\$&")})+`,
  "g",
);
/** A date said in full ("October 18, 2026") keeps its day and year, the one ordinary run of six digits in speech. */
const DAY_AND_YEAR = /^\d{1,2},?\s+(?:1[89]|20)\d\d$/;

/** A spoken number before any `SPOKEN_SECRET` word: one of `SPOKEN_DIGITS_REDACTED` digits or more goes whole, a date said
 * in full excepted; a shorter one loses each stretch of its groups that is a value typed into a sensitive field. */
const scrubSpokenRun = (
  run: string,
  afterMonth: boolean,
  matches: ((value: string) => boolean) | null,
): string => {
  const digits = run.replace(/\P{Nd}/gu, "");
  if (digits.length >= SPOKEN_DIGITS_REDACTED)
    return afterMonth && DAY_AND_YEAR.test(run) ? run : REDACTED;
  if (matches === null || digits.length < MIN_DIGEST_LENGTH) return run;
  const groups = [...run.matchAll(/\d+/g)].map((match) => ({
    digits: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const spans: Array<[number, number]> = [];
  for (let first = 0; first < groups.length; first++) {
    const head = groups[first];
    if (!head) continue;
    let typed = "";
    for (let last = first; last < groups.length; last++) {
      const group = groups[last];
      if (!group) break;
      typed += group.digits;
      if (typed.length >= MIN_DIGEST_LENGTH && matches(typed))
        spans.push([head.start, group.end]);
    }
  }
  return redactSpans(run, spans);
};

/** `scrubText` for what a person said while recording, as the browser's speech recognition wrote it. A speech service
 * writes a number read aloud with thousands separators, stray signs and dashes, and drops or runs together its digits, so
 * a spoken number of six digits or more goes whatever it adds up to, every number after a word that names a secret (in
 * this phrase, or in `before`, the phrase said just before it) goes however short, and a shorter one loses a value typed
 * into a sensitive field. Then the text masking runs as it does on everything else. */
export function scrubTranscript(
  text: string,
  options?: MaskOptions & { before?: string },
): string {
  const matches =
    options?.digests && options.digests.size > 0
      ? digestMatcher(options)
      : null;
  const secret = SPOKEN_SECRET.exec(text);
  const from =
    options?.before && SPOKEN_SECRET.test(options.before)
      ? 0
      : secret
        ? secret.index + secret[0].length
        : text.length;
  const head = text.slice(0, from);
  const tail = text
    .slice(from)
    .replace(SPOKEN_WORD, (word) => (HAS_NUMERAL.test(word) ? REDACTED : word))
    .replace(REDACTED_RUN, REDACTED);
  return scrubText(
    head.replace(
      SPOKEN_NUMBER,
      (_, month: string | undefined, run: string) =>
        (month ?? "") + scrubSpokenRun(run, month !== undefined, matches),
    ) + tail,
    options,
  );
}

export function maskHeaders(
  headers: Record<string, string>,
  options?: MaskOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  // A header value read from captured JSON is not always a string (a numeric content-length), so it is scrubbed as one.
  for (const [name, value] of Object.entries(headers))
    out[name] = isCredentialHeader(name)
      ? REDACTED
      : scrubText(String(value), options);
  return out;
}

const scrubSegment = (segment: string, options?: MaskOptions): string => {
  const decoded = decodeQuietly(segment);
  const scrubbed = scrubText(decoded, options);
  if (scrubbed === decoded) return segment;
  return scrubbed.split(REDACTED).map(encodeURIComponent).join(REDACTED);
};

/** One `key=value` pair of a query or form body. `oauth` is set for the query of an OAuth callback or sign-in address, whose
 * `state` is a secret too. */
const scrubQueryPair = (
  pair: string,
  options?: BodyOptions,
  oauth = false,
): string => {
  const at = pair.indexOf("=");
  if (at === -1) {
    const decoded = decodeQuietly(pair);
    return scrubText(decoded, options) === decoded &&
      !matchesDigest(decoded, options)
      ? pair
      : REDACTED;
  }
  const key = pair.slice(0, at);
  const name = decodeQuietly(key);
  const value = decodeQuietly(pair.slice(at + 1).replace(/\+/g, " "));
  const redact =
    isCredentialKey(name) ||
    (isBareCodeKey(name) &&
      codeHoldsSecret(value, options?.authFlow || oauth)) ||
    (oauth && isStateKey(name)) ||
    scrubText(value, options) !== value ||
    matchesDigest(value, options);
  return redact ? `${key}=${REDACTED}` : pair;
};

const pairKey = (pair: string): string => {
  const at = pair.indexOf("=");
  return decodeQuietly(at === -1 ? pair : pair.slice(0, at));
};

/** A URL's path segments and query pairs are masked one by one. On a sign-in, verification, token or OAuth address, or in a
 * query shaped like an OAuth redirect (a `code` beside a `state`), `code` and `state` are secrets whatever they hold. */
export function scrubUrl(url: string, options?: MaskOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return scrubText(url, options);
  }
  if (!parsed.host) return scrubText(url.replace(/#.*$/, ""), options);
  const path = parsed.pathname
    .split("/")
    .map((segment) => scrubSegment(segment, options))
    .join("/");
  const query = parsed.search.slice(1);
  const pairs = query ? query.split("&") : [];
  const oauth =
    authFlowUrl(url) ||
    (pairs.some((pair) => isBareCodeKey(pairKey(pair))) &&
      pairs.some((pair) => isStateKey(pairKey(pair))));
  const scrubbedQuery = query
    ? `?${pairs.map((pair) => scrubQueryPair(pair, options, oauth)).join("&")}`
    : "";
  return `${parsed.protocol}//${parsed.host}${path}${scrubbedQuery}`;
}

const NO_KEYS: ReadonlySet<string> = new Set();

const maskJson = (
  value: JsonValue,
  options?: BodyOptions,
  keep: ReadonlySet<string> = NO_KEYS,
): JsonValue => {
  if (typeof value === "string")
    return matchesDigest(value, options) ? REDACTED : scrubText(value, options);
  if (typeof value === "number") {
    const digits = String(value);
    // JSON.parse already rounded an integer past 2^53, so it can no longer be checked; redact it.
    const unverifiable =
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      Math.abs(value) < 1e19;
    return unverifiable ||
      matchesDigest(digits, options) ||
      (/^\d{13,19}$/.test(digits) && luhnValid(digits))
      ? REDACTED
      : value;
  }
  if (Array.isArray(value))
    return value.map((item) => maskJson(item, options, keep));
  if (isObject(value)) {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value))
      out[key] =
        keep.has(key) && typeof item === "string"
          ? item
          : isCredentialKey(key) ||
              (isBareCodeKey(key) && codeHoldsSecret(item, options?.authFlow))
            ? REDACTED
            : maskJson(item, options, keep);
    return out;
  }
  return value;
};

/** A body's JSON masking for a value that is already JSON (an agent's state, a run's input), leaving the string values
 * of the `keep` keys as they are: the ids that join one AG-UI event to another, which the long-run rule would take. */
export function maskJsonValue(
  value: JsonValue,
  options?: MaskOptions,
  keep: ReadonlySet<string> = NO_KEYS,
): JsonValue {
  try {
    return maskJson(value, options, keep);
  } catch {
    return REDACTED;
  }
}

/** One pair of a form body, as a query pair is masked; a key that is itself a secret (a long token posted bare, base64
 * padding and all) takes the whole pair. */
const maskFormPair = (pair: string, options?: BodyOptions): string => {
  const at = pair.indexOf("=");
  if (at > 0) {
    const key = decodeQuietly(pair.slice(0, at).replace(/\+/g, " "));
    if (scrubText(key, options) !== key || matchesDigest(key, options))
      return REDACTED;
  }
  return scrubQueryPair(pair, options);
};

const maskForm = (text: string, options?: BodyOptions): string =>
  text
    .split("&")
    .map((pair) => maskFormPair(pair, options))
    .join("&");

const looksLikeForm = (text: string): boolean =>
  FORM_START.test(text) && !LINE_BREAK.test(text.trimEnd());

const isJsonSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** The index of the quote that closes the string opening at `start`, or -1 when the text ends first. */
const closingQuote = (text: string, start: number): number => {
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) i++;
    else if (code === 0x22) return i;
  }
  return -1;
};

/** Where the JSON value starting at `start` ends: past a string's closing quote, past the bracket that closes an object or
 * array, or after a number's or literal's last character; the end of the text when the text ends first. */
const valueEnd = (text: string, start: number): number => {
  const first = text.charCodeAt(start);
  if (first === 0x22) {
    const close = closingQuote(text, start);
    return close === -1 ? text.length : close + 1;
  }
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        const close = closingQuote(text, i);
        if (close === -1) return text.length;
        i = close;
      } else if (code === 0x7b || code === 0x5b) depth++;
      else if ((code === 0x7d || code === 0x5d) && --depth === 0) return i + 1;
    }
    return text.length;
  }
  let i = start;
  for (; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isJsonSpace(code) || code === 0x2c || code === 0x7d || code === 0x5d)
      break;
  }
  return i;
};

/** A JSON string token's text with its escapes decoded; a token the text ends inside is read as if it closed there. */
const jsonStringValue = (token: string, closed: boolean): string => {
  try {
    return JSON.parse(closed ? token : `${token}"`) as string;
  } catch {
    return token.slice(1, closed ? -1 : undefined);
  }
};

/** The string or number a JSON value starting at `start` holds, read as far as the text goes; undefined for anything else. */
const jsonLiteralAt = (text: string, start: number): JsonValue | undefined => {
  const token = text.slice(start, valueEnd(text, start));
  if (token.charCodeAt(0) === 0x22)
    return jsonStringValue(token, closingQuote(text, start) !== -1);
  const number = Number(token);
  return /^-?\d/.test(token) && Number.isFinite(number) ? number : undefined;
};

/** JSON that does not parse, above all a body cut at NETWORK_BODY_READ_MAX_BYTES before it was masked. It is read token by
 * token from its start: the value of every credential-named key, and of a bare `code` key that holds a one-time code, is
 * redacted (a whole object or array too, up to its end or the end of the text), a string that matches a digest is redacted
 * whole, and the result is scrubbed as text. Linear. */
const maskJsonText = (text: string, options?: BodyOptions): string => {
  const hasDigests = (options?.digests?.size ?? 0) > 0;
  const out: string[] = [];
  let copied = 0;
  const redact = (start: number, end: number) => {
    out.push(text.slice(copied, start), REDACTED_JSON);
    copied = end;
  };
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x22) {
      i++;
      continue;
    }
    const close = closingQuote(text, i);
    const end = close === -1 ? text.length : close + 1;
    let next = end;
    while (next < text.length && isJsonSpace(text.charCodeAt(next))) next++;
    if (close !== -1 && text.charCodeAt(next) === 0x3a) {
      let value = next + 1;
      while (value < text.length && isJsonSpace(text.charCodeAt(value)))
        value++;
      const key = jsonStringValue(text.slice(i, end), true);
      if (
        value < text.length &&
        (isCredentialKey(key) ||
          (isBareCodeKey(key) &&
            codeHoldsSecret(jsonLiteralAt(text, value), options?.authFlow)))
      ) {
        const after = valueEnd(text, value);
        redact(value, after);
        i = after;
      } else i = value;
      continue;
    }
    if (
      hasDigests &&
      matchesDigest(jsonStringValue(text.slice(i, end), close !== -1), options)
    )
      redact(i, end);
    i = end;
  }
  out.push(text.slice(copied));
  return scrubText(out.join(""), options);
};

/** A body is masked by its shape first and its declared type second: JSON whole; JSON that no longer parses (a body cut
 * short) key by key; a form body pair by pair, declared or not; anything else as text. `options.url` is where it was sent. */
export function maskBody(
  text: string,
  contentType: string | undefined,
  options?: MaskOptions,
): string {
  return maskBodyText(text, contentType, {
    ...options,
    authFlow: authFlowUrl(options?.url),
  });
}

function maskBodyText(
  text: string,
  contentType: string | undefined,
  options: BodyOptions,
): string {
  try {
    let parsed: JsonValue | undefined;
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object")
      return JSON.stringify(maskJson(parsed, options));
    if (JSON_START.test(text)) return maskJsonText(text, options);
    if (
      (contentType && FORM_CONTENT_TYPE.test(contentType)) ||
      looksLikeForm(text)
    )
      return maskForm(text, options);
    if (contentType && JSON_CONTENT_TYPE.test(contentType))
      return maskJsonText(text, options);
    return scrubText(text, options);
  } catch {
    return REDACTED;
  }
}

/**
 * Whether a body, before it is masked, holds one of `typed`: the digests of what the person typed into sensitive fields.
 * It is read as `maskBody` reads it and looked through where the masking looks for a typed secret (a JSON string or
 * number, a form key or value, a word or a run of digits in text), so each value it finds is one the masking redacts, by
 * its digest or first as a credential's value or a card number. Only the answer leaves: a save whose body this holds
 * carries what the person entered, though all of it reads [redacted].
 */
export function holdsTypedSecret(
  text: string,
  contentType: string | undefined,
  typed: ReadonlySet<string>,
): boolean {
  if (typed.size === 0) return false;
  const matches = digestMatcher({ digests: typed });
  /** `scrubText`'s candidates: a run of digit groups, or a word. */
  const inWords = (value: string): boolean =>
    (value.match(DIGIT_GROUPS) ?? []).some(
      (run) => scrubDigestRun(run, matches) !== run,
    ) ||
    (value.match(TOKEN_CHARS) ?? []).some(matches) ||
    (value.match(TOKEN_CHARS_FINE) ?? []).some(matches);
  const inValue = (value: string): boolean => matches(value) || inWords(value);
  const inJson = (value: JsonValue): boolean => {
    if (typeof value === "string") return inValue(value);
    if (typeof value === "number") return matches(String(value));
    if (Array.isArray(value)) return value.some(inJson);
    return isObject(value) && Object.values(value).some(inJson);
  };
  const inJsonText = (body: string): boolean => {
    if (inWords(body)) return true;
    for (let at = body.indexOf('"'); at !== -1; ) {
      const close = closingQuote(body, at);
      const end = close === -1 ? body.length : close + 1;
      if (matches(jsonStringValue(body.slice(at, end), close !== -1)))
        return true;
      at = close === -1 ? -1 : body.indexOf('"', end);
    }
    return false;
  };
  const inPair = (pair: string): boolean => {
    const at = pair.indexOf("=");
    if (at === -1) return inValue(decodeQuietly(pair));
    const key = decodeQuietly(pair.slice(0, at).replace(/\+/g, " "));
    const value = decodeQuietly(pair.slice(at + 1).replace(/\+/g, " "));
    return (at > 0 && inValue(key)) || inValue(value);
  };
  try {
    let parsed: JsonValue | undefined;
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object")
      return inJson(parsed);
    if (JSON_START.test(text)) return inJsonText(text);
    if (
      (contentType && FORM_CONTENT_TYPE.test(contentType)) ||
      looksLikeForm(text)
    )
      return text.split("&").some(inPair);
    if (contentType && JSON_CONTENT_TYPE.test(contentType))
      return inJsonText(text);
    return inWords(text);
  } catch {
    return false;
  }
}

/** A field whose name, label, placeholder, test id or class says it takes a one-time code: OTP, 2FA, two-factor, MFA,
 * verification, passcode, security, auth, SMS, login or confirmation code, a code from an authenticator. */
const ONE_TIME_CODE_FIELD =
  / (?:otp|otc|totp|hotp|one ?time|2 ?fa|2 ?step|two ?step|2 ?factor|two ?factor|multi ?factor|mfa|2sv|pass ?codes?|verif[a-z]*|security ?codes?|auth ?codes?|authentication ?codes?|authenticator|authorization ?codes?|access ?codes?|sms ?codes?|log ?in ?codes?|sign ?in ?codes?|confirmation ?codes?|recovery ?codes?|backup ?codes?) /;
/** Codes that are not secrets: a "zip code", "promo code" or "country code" is no one-time code, whatever else it says. */
const ORDINARY_CODE =
  / (?:zip|postal|post|promo|promotion|promotional|coupon|discount|voucher|gift|referral|invite|invitation|country|area|dial|dialing|dialling|calling|region|language|lang|locale|currency|product|item|sku|article|order|tracking|reference|source|embed|html|qr|bar|error|status|response|reason|tax|vat|tariff|hs|sic|naics|icd|cpt|cost|gl|project|course|class|department|dept|store|branch|airport|iata|station|color|colour|hex|swift|bic|sort|bank) codes?(?= )/g;
/** "code" as a word, once the ordinary codes are taken out. */
const CODE_WORD = / codes? /;
/** "6-digit", "six digit", "8 characters": the length a one-time code field asks for. */
const DIGIT_COUNT =
  / (?:\d+|four|five|six|seven|eight) ?(?:digit|character|char)s? /;
/** Short numbers that are not secrets, which veto a field's numeric shape: a postcode, a year, a quantity, a phone extension.
 * A phone number is not among them: "the code we texted to your phone" names a one-time code. */
const ORDINARY_NUMBER =
  / (?:zip|zipcode|postal|postcode|post code|year|years|yyyy|yy|month|mm|day|dd|date|dob|birth[a-z]*|bday[a-z]*|age|qty|quantity|amount|price|cost|total|count|tip|percent[a-z]*|weight|height|width|length|size|page|sku|product|item|order|tracking|house|street|address[a-z]*|apt|suite|building|floor|unit|extension|ext|country|area|dial[a-z]*|promo[a-z]*|coupon|discount|voucher|gift|referral|invite|currency|number of) /;
/** Wording that says the field takes something the site just sent the person by text, email or message: "the code we
 * texted you", "what we sent to your phone", "we've emailed you a code", "the code in the text message". Chromium's autofill
 * (`ONE_TIME_CODE`: otp, verification code, 2fa, six digit), Bitwarden's `TotpFieldNames` and Proton Pass's `TWO_FA` and
 * `OTP` dictionaries name the code; none names the delivery, which is all a field like these says. */
const DELIVERED_TO_PERSON =
  / (?:(?:we|we ve|we have|we just|we ll|we will|just|was|were|been|has been|have been|that|which|being) (?:just )?(?:sent|texted|txted|emailed|e mailed|messaged|mailed|smsed)|(?:sent|texted|txted|emailed|e mailed|messaged|mailed|delivered) (?:(?:it|this|them|you|a|an|the|code|codes|pin|number|digits|just) )*(?:to (?:you|your|\d)|you |your )|(?:by|via|in (?:the|your|a|an)|from (?:the|your|a|an)|over) (?:text|txt|sms|email|e mail)(?: message)? )/;
/** What a site sends a person besides a one-time code, by name, which vetoes `DELIVERED_TO_PERSON`: an order, tracking,
 * invoice or booking number we emailed you is no secret. */
const ORDINARY_DELIVERED =
  / (?:invoice|receipt|reference|ref|ticket|case|booking|reservation|itinerary|tracking|order|shipment|parcel|package|link|address|url|how many|how much|items|units|times) /;
/** A short numeric value, 4 to 8 digits (spaces and dashes aside), the lengths a code field takes: the shape of a one-time
 * code as typed, and never a phone number. */
const isCodeValue = (value: string | undefined): boolean =>
  typeof value === "string" && /^\d{4,8}$/.test(normaliseSecret(value));
/** A `pattern` that admits digits only (`[0-9]*`, `\d{6}`, `[0-9 ]*`, `^[0-9]{4,8}$`); group 1 and 2 are its length bounds. */
const DIGITS_PATTERN =
  /^\^?(?:\\d|\[(?:0-9|\\d) ?\])(?:[*+]|\{(\d+)(?:,(\d*))?\})\$?$/;
/** The shortest and longest one-time code a numeric field's length says it takes. */
const CODE_FIELD_MIN_LENGTH = 4;
const CODE_FIELD_MAX_LENGTH = 8;
/** Inputs a person types a code into; a button's `value` is its label, never a secret. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "tel",
  "number",
  "password",
  "search",
]);
/** Attributes that name a field without being read by SENSITIVE_FIELD: test ids and the class name, read for one-time codes
 * only (a "token" class names a tag picker as often as a secret). */
const FIELD_HINT_ATTRIBUTE =
  /^(?:class|data-(?:test-?id|test|testing-?id|qa|cy|e2e|automation-?id|tid|hook))$/i;

/** How many characters a numeric field (inputmode numeric, type tel or a digits-only pattern) takes, by its maxlength or its
 * pattern; NaN for a field that is not numeric or says no length. */
const numericFieldLength = (attributes: Record<string, string>): number => {
  const pattern = DIGITS_PATTERN.exec((attributes.pattern ?? "").trim());
  const numeric =
    attributes.inputmode?.toLowerCase() === "numeric" ||
    attributes.type?.toLowerCase() === "tel" ||
    pattern !== null;
  if (!numeric) return Number.NaN;
  const declared = Number.parseInt(attributes.maxlength ?? "", 10);
  return Number.isFinite(declared)
    ? declared
    : Number.parseInt(pattern?.[2] || pattern?.[1] || "", 10);
};

/** A short numeric input, 4 to 8 long: a one-time code field by its shape. */
const hasCodeShape = (attributes: Record<string, string>): boolean => {
  const length = numericFieldLength(attributes);
  return length >= CODE_FIELD_MIN_LENGTH && length <= CODE_FIELD_MAX_LENGTH;
};

/** A field that takes a one-time code, though it lacks autocomplete=one-time-code: its words name one; or it says "code"
 * (no zip, promo or country code) and asks for a number of digits, has a code's shape or sits on a sign-in page; or it says
 * the site just sent the person what it takes ("the code we texted you", "what we sent to your phone"), names no ordinary
 * thing sent, and holds 4 to 8 digits, is numeric, takes 4 to 8 characters or sits on a sign-in or verification page; or
 * it has a code's shape (a short numeric input) or is one numeric box of a code typed a digit per box, and names no ordinary
 * number. Text inputs, text areas and editable regions only. */
const isOneTimeCodeField = (
  target: {
    attributes?: Record<string, string>;
    label?: string;
    tag?: string;
    value?: string;
  },
  url: string | undefined,
): boolean => {
  const attributes = target.attributes ?? {};
  const tag = target.tag?.toLowerCase();
  const editable =
    tag === "textarea" ||
    (attributes.contenteditable !== undefined &&
      attributes.contenteditable !== "false");
  const input =
    (tag === undefined || tag === "input") &&
    TEXT_INPUT_TYPES.has((attributes.type ?? "").toLowerCase());
  if (!input && !editable) return false;
  const words = fieldWords(
    [
      target.label,
      attributes["aria-label"],
      attributes.placeholder,
      attributes.title,
      attributes.name,
      attributes.id,
      attributes.autocomplete,
      ...Object.entries(attributes)
        .filter(([name]) => FIELD_HINT_ATTRIBUTE.test(name))
        .map(([, value]) => value),
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .slice(0, 2000),
  );
  if (ONE_TIME_CODE_FIELD.test(words)) return true;
  if (
    DELIVERED_TO_PERSON.test(words) &&
    !ORDINARY_DELIVERED.test(words) &&
    !ORDINARY_NUMBER.test(words) &&
    words.replace(ORDINARY_CODE, "") === words
  ) {
    // A phone field ("we texted a code to this number", type=tel) is no code field: tel is not a code's shape here.
    const length = Number.parseInt(attributes.maxlength ?? "", 10);
    if (
      isCodeValue(target.value) ||
      attributes.inputmode?.toLowerCase() === "numeric" ||
      DIGITS_PATTERN.test((attributes.pattern ?? "").trim()) ||
      (length >= CODE_FIELD_MIN_LENGTH && length <= CODE_FIELD_MAX_LENGTH) ||
      authFlowUrl(url)
    )
      return true;
  }
  if (!input) return false;
  const shape = hasCodeShape(attributes);
  if (
    CODE_WORD.test(words.replace(ORDINARY_CODE, "")) &&
    (DIGIT_COUNT.test(words) || shape || authFlowUrl(url))
  )
    return true;
  // One box of a code typed a digit per box: a numeric input one character long. The content script knows its row of
  // boxes; this holds for a box judged on its own.
  return (
    (shape || numericFieldLength(attributes) === 1) &&
    !ORDINARY_NUMBER.test(words)
  );
};

/** Inputs drawn as a button or a choice: what they hold is the page's own caption or option, never what the person typed. */
const NAMING_INPUT_TYPES: ReadonlySet<string> = new Set([
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
  "range",
  "color",
]);
/** The roles of an element the person types into (CopilotKit's `TEXT_ENTRY` in clicks.ts). */
const TEXT_ENTRY_ROLE = /^(?:textbox|searchbox|combobox)$/i;

/** Whether the element holds a value the person enters: an input (one drawn as a button or a choice aside), a text area, a
 * select, an editable region or a text-entry role, as CopilotKit's capture tells one (`holdsValue` in clicks.ts). Only such
 * an element can hold a secret; a button, a link or a label only names one ("Show password", "Reset password link",
 * "Retrieve password"). One described with no tag is judged as a field. */
export function holdsValue(target: {
  tag?: string;
  attributes?: Record<string, string>;
}): boolean {
  const tag = target.tag?.toLowerCase();
  if (tag === undefined) return true;
  const attributes = target.attributes ?? {};
  if (tag === "input")
    return !NAMING_INPUT_TYPES.has(
      (attributes.type ?? "").trim().toLowerCase(),
    );
  if (tag === "textarea" || tag === "select") return true;
  const editable = attributes.contenteditable;
  if (typeof editable === "string" && editable.toLowerCase() !== "false")
    return true;
  return TEXT_ENTRY_ROLE.test(
    (attributes.role ?? "").trim().split(/\s+/)[0] ?? "",
  );
}

/** A field whose value is a secret: a password, a card, a security or one-time code. `context.url` is the page it is on;
 * `target.value`, what it holds, tells a one-time code field that names no code by its shape. Only an element that holds a
 * value (`holdsValue`) is one: a control that names a secret holds none. */
export function isSensitiveTarget(
  target: {
    attributes?: Record<string, string>;
    label?: string;
    text?: string;
    tag?: string;
    value?: string;
  },
  context?: { url?: string },
): boolean {
  if (!holdsValue(target)) return false;
  const attributes = target.attributes ?? {};
  if (attributes.type === "password") return true;
  const words = [
    target.label,
    attributes["aria-label"],
    attributes.placeholder,
    attributes.title,
    attributes.name,
    attributes.id,
    attributes.autocomplete,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return (
    SENSITIVE_FIELD.test(words) || isOneTimeCodeField(target, context?.url)
  );
}

export function sanitiseForIntelligence(value: JsonValue): JsonValue {
  const clean = (text: string) => text.replaceAll(NUL, "\uFFFD").toWellFormed();
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(sanitiseForIntelligence);
  if (isObject(value)) {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value))
      out[clean(key)] = sanitiseForIntelligence(item);
    return out;
  }
  return value;
}

const scrubStrings = (
  value: JsonValue,
  options: MaskOptions | undefined,
  key?: string,
): JsonValue => {
  if (typeof value === "string") {
    if (value === REDACTED) return value;
    return key === "url" || key === "referrer"
      ? scrubUrl(value, options)
      : scrubText(value, options);
  }
  if (Array.isArray(value))
    return value.map((item) => scrubStrings(item, options, key));
  if (isObject(value)) {
    const out: Obj = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] =
        key === "attributes" && isCredentialKey(name.replace(/^data-/i, ""))
          ? REDACTED
          : scrubStrings(item, options, name);
    }
    return out;
  }
  return value;
};

/** A field a person types text into, whose accessible name comes from its label, aria-label or placeholder and never from
 * what it holds: a text-like input or a text area (an editable region is named by its content). */
const namedByLabel = (
  tag: string | undefined,
  attributes: Record<string, string> | undefined,
): boolean =>
  tag?.toLowerCase() === "textarea" ||
  (tag?.toLowerCase() === "input" &&
    TEXT_INPUT_TYPES.has((attributes?.type ?? "").toLowerCase()));

/** `context.sensitive`: the content script judged the field sensitive. `context.onSensitive` hears what a field judged
 * sensitive here held before it was redacted, so the service worker can mask it wherever it appears later. */
export function maskCollectorEvent(
  event: CapturedEvent,
  context: { sensitive: boolean; onSensitive?: (typed: string[]) => void },
  options?: MaskOptions,
): CapturedEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const clone = sanitiseForIntelligence(
    event as unknown as JsonValue,
  ) as unknown as CapturedEvent;
  const value = clone.value;
  if (isObject(value) && isObject(value.target)) {
    const target = value.target;
    const attributes = isObject(target.attributes)
      ? (target.attributes as Record<string, string>)
      : undefined;
    const tag = typeof target.tag === "string" ? target.tag : undefined;
    // CopilotKit's capture gives only a click a label; an edit's field is named by the accessible name the targeting adds,
    // which for a text field is its label text, so the rule reads the same words for both.
    const label =
      typeof target.label === "string"
        ? target.label
        : namedByLabel(tag, attributes) && typeof target.name === "string"
          ? target.name
          : undefined;
    const url = typeof value.url === "string" ? value.url : undefined;
    const held =
      typeof target.value === "string" && target.value !== REDACTED
        ? target.value
        : undefined;
    if (
      context.sensitive ||
      isSensitiveTarget({ attributes, label, tag, value: held }, { url })
    ) {
      // Every copy of the value goes: the live value and text, the value attributes, and any attribute that echoes it.
      const typed = TARGET_VALUE_FIELDS.map((field) => target[field]).filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "" && item !== REDACTED,
      );
      if (typed.length > 0) context.onSensitive?.(typed);
      for (const field of TARGET_VALUE_FIELDS)
        if (field in target) target[field] = REDACTED;
      if (attributes)
        for (const [name, item] of Object.entries(attributes))
          if (VALUE_ATTRIBUTE.test(name) || echoes(item, typed))
            attributes[name] = REDACTED;
      delete target.selectedValues;
    } else if (
      mirrorsValue(tag, attributes) &&
      typeof target.value === "string"
    ) {
      // The masking took part of what was typed (a card, an email, a token), now or before the event came here: every
      // copy of the field's content takes the same verdict, so a copy that still held a keystroke less of it (the text of
      // React's chat box held a card's first 15 digits, which are no card on their own) never leaves. The text and the
      // value attributes are the field's own copies; any other attribute, and the field's name, goes whole if it holds a
      // stretch of what was typed.
      const typed = target.value;
      // A secret pasted whole is one value, though it holds spaces (a passphrase), and no single word of it matches.
      const masked = matchesDigest(typed, options)
        ? REDACTED
        : scrubText(typed, options);
      if (masked !== typed || masked.includes(REDACTED)) {
        target.value = masked;
        if (typeof target.text === "string" && target.text !== "")
          target.text = masked;
        if (attributes)
          for (const [name, item] of Object.entries(attributes))
            if (typeof item === "string" && item !== "")
              if (VALUE_ATTRIBUTE.test(name)) attributes[name] = masked;
              else if (copies(item, typed)) attributes[name] = REDACTED;
        for (const field of ["label", "name"] as const)
          if (copies(target[field], typed)) target[field] = REDACTED;
      }
    }
    if (Array.isArray(target.files)) {
      target.files = target.files.map((file) =>
        isObject(file) && typeof file.name === "string"
          ? { ...file, name: scrubText(file.name, options) }
          : file,
      );
    }
  }
  return { ...clone, value: scrubStrings(value, options) };
}

const headerValue = (
  headers: JsonValue | undefined,
  name: string,
): string | undefined => {
  if (!isObject(headers)) return undefined;
  for (const [key, item] of Object.entries(headers))
    if (key.toLowerCase() === name && typeof item === "string") return item;
  return undefined;
};

const maskExchange = (
  part: JsonValue | undefined,
  options: BodyOptions,
): JsonValue | undefined => {
  if (!isObject(part)) return part;
  const out: Obj = { ...part };
  if (typeof out.url === "string") out.url = scrubUrl(out.url, options);
  if (isObject(out.headers))
    out.headers = maskHeaders(out.headers as Record<string, string>, options);
  if (isObject(out.body) && typeof out.body.text === "string") {
    out.body = {
      ...out.body,
      text: maskBodyText(
        out.body.text,
        headerValue(part.headers, "content-type"),
        options,
      ),
    };
  }
  return out;
};

export function maskNetworkEvent(
  event: CapturedEvent,
  options?: MaskOptions,
): CapturedEvent {
  const clone = sanitiseForIntelligence(
    event as unknown as JsonValue,
  ) as unknown as CapturedEvent;
  if (!isObject(clone.value)) return clone;
  const value: Obj = { ...clone.value };
  // Both bodies of a sign-in, verification or token call are read as such, by the address asked or the one answering.
  const exchange: BodyOptions = {
    ...options,
    authFlow:
      (typeof value.url === "string" && authFlowUrl(value.url)) ||
      (isObject(value.response) &&
        typeof value.response.url === "string" &&
        authFlowUrl(value.response.url)),
  };
  if (typeof value.url === "string") value.url = scrubUrl(value.url, options);
  if (typeof value.route === "string")
    value.route = scrubText(value.route, options);
  if (value.request !== undefined)
    value.request = maskExchange(value.request, exchange) ?? null;
  if (value.response !== undefined)
    value.response = maskExchange(value.response, exchange) ?? null;
  return { ...clone, value };
}

const byteLength = (event: CapturedEvent) =>
  new TextEncoder().encode(JSON.stringify(event)).byteLength;

/** Cuts at a code unit count without leaving the first half of a surrogate pair at the end. */
const cut = (text: string, length: number): string => {
  const end =
    length > 0 &&
    text.charCodeAt(length - 1) >= 0xd800 &&
    text.charCodeAt(length - 1) <= 0xdbff
      ? length - 1
      : length;
  return text.slice(0, end);
};

/**
 * Cuts the request and response bodies to one length, the longest that fits the event in `maxBytes`. A body shorter
 * than that length stays whole, so the larger body is always cut first: a small response survives a large upload,
 * and two large bodies end the same length. Called only on an event already over its budget.
 */
const truncateBodies = (event: CapturedEvent, maxBytes: number): void => {
  const value = event.value;
  if (!isObject(value)) return;
  const bodies: { exchange: Obj; body: Obj; text: string }[] = [];
  for (const side of ["request", "response"] as const) {
    const exchange = value[side];
    if (!isObject(exchange)) continue;
    const body = exchange.body;
    if (isObject(body) && typeof body.text === "string")
      bodies.push({ exchange, body, text: body.text });
  }
  if (bodies.length === 0) return;
  const capAt = (length: number) => {
    for (const { exchange, body, text } of bodies)
      exchange.body =
        text.length > length
          ? {
              ...body,
              text: cut(text, length),
              status: "truncated",
              truncated: true,
            }
          : body;
  };
  // The event with every body whole is over budget: the answer is below the longest body's length.
  let fits = -1;
  let low = 0;
  let high = Math.max(...bodies.map(({ text }) => text.length)) - 1;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    capAt(length);
    if (byteLength(event) <= maxBytes) {
      fits = length;
      low = length + 1;
    } else high = length - 1;
  }
  // Nothing fits even with the bodies emptied: they stay empty, and the caller cuts further.
  capAt(Math.max(fits, 0));
};

/** One string in an event's value, where it sits so it can be cut in place, and the field that holds it: an array's
 * items are its field's, so the names a JSON Schema's `required` lists are `required`. */
type StringLeaf = {
  holder: { [key: string]: JsonValue } | JsonValue[];
  key: string | number;
  text: string;
  field: string | null;
};

const stringLeaves = (
  value: JsonValue,
  out: StringLeaf[] = [],
  field: string | null = null,
): StringLeaf[] => {
  const visit = (
    holder: StringLeaf["holder"],
    key: string | number,
    item: JsonValue,
    itemField: string | null,
  ) => {
    if (typeof item === "string")
      out.push({ holder, key, text: item, field: itemField });
    else stringLeaves(item, out, itemField);
  };
  if (Array.isArray(value))
    for (const [index, item] of value.entries())
      visit(value, index, item, field);
  else if (isObject(value))
    for (const [key, item] of Object.entries(value))
      visit(value, key, item, key);
  return out;
};

/**
 * Cuts the strings in the event's value to one length, the longest that fits the event in `maxBytes`, as
 * truncateBodies does for bodies: a string shorter than that length stays whole, so the longest (an agent's message, a
 * tool's arguments, a long description) are cut first and its numbers stay. A string of a field `keep` names (an id, a
 * name) is never cut, at any depth. Called only on an event still over its budget.
 */
const truncateStrings = (
  event: CapturedEvent,
  maxBytes: number,
  keep: ReadonlySet<string>,
): void => {
  const value = event.value;
  if (!isObject(value)) return;
  value.truncated = true;
  const leaves = stringLeaves(value).filter(
    ({ field }) => field === null || !keep.has(field),
  );
  if (leaves.length === 0) return;
  const capAt = (length: number) => {
    for (const { holder, key, text } of leaves)
      (holder as Record<string | number, JsonValue>)[key] =
        text.length > length ? cut(text, length) : text;
  };
  let fits = -1;
  let low = 0;
  let high = Math.max(...leaves.map(({ text }) => text.length)) - 1;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    capAt(length);
    if (byteLength(event) <= maxBytes) {
      fits = length;
      low = length + 1;
    } else high = length - 1;
  }
  capAt(Math.max(fits, 0));
};

/** `strings`: before giving up on an event still over budget, cut its longest strings to fit (truncateStrings), as the
 * agent events do so that a long message keeps its ids and the start of its text. `keep`, with `strings`: the fields
 * whose strings are never cut, at any depth (the agent events' ids, names and enum-like fields). */
export function trimEvent(
  event: CapturedEvent,
  maxBytes: number,
  options: { strings?: boolean; keep?: ReadonlySet<string> } = {},
): { event: CapturedEvent; trimmed: boolean } {
  const work = sanitiseForIntelligence(
    event as unknown as JsonValue,
  ) as unknown as CapturedEvent;
  if (byteLength(work) <= maxBytes) return { event: work, trimmed: false };
  truncateBodies(work, maxBytes);
  if (
    byteLength(work) > maxBytes &&
    isObject(work.value) &&
    isObject(work.value.target)
  ) {
    const target = work.value.target;
    for (const field of TARGET_VALUE_FIELDS) {
      if (typeof target[field] === "string")
        target[field] = cut(target[field] as string, TRIMMED_TARGET_TEXT);
    }
    work.value.truncated = true;
  }
  if (options.strings && byteLength(work) > maxBytes)
    truncateStrings(work, maxBytes, options.keep ?? new Set());
  if (byteLength(work) > maxBytes) {
    const minimal: Obj = { trimmed: true };
    if (isObject(work.value) && typeof work.value.url === "string")
      minimal.url = scrubUrl(work.value.url);
    return { event: { ...work, value: minimal }, trimmed: true };
  }
  return {
    event: sanitiseForIntelligence(
      work as unknown as JsonValue,
    ) as unknown as CapturedEvent,
    trimmed: true,
  };
}
