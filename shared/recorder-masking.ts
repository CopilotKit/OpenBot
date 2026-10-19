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
type MaskOptions = { digests?: ReadonlySet<string> };
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
const TARGET_ATTRIBUTE_VALUES = [
  "value",
  "aria-valuetext",
  "data-value",
] as const;
/** Intelligence rejects a NUL at any depth. */
const NUL = "\u0000";
/** Longest `target.value` and `target.text` kept when trimming (plan Task 3 `trimEvent`). */
const TRIMMED_TARGET_TEXT = 200;

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export function isCredentialKey(key: string): boolean {
  const words = ` ${key
    .replace(/%([\da-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/([a-z\d])(?=[A-Z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .join(" ")} `;
  if (METADATA.test(words)) return false;
  return (
    CREDENTIAL.test(words.replace(/ /g, "")) ||
    CREDENTIAL_WORD.test(words) ||
    CARD_KEY.test(words) ||
    CARD_WORDS.test(words.replace(/ /g, ""))
  );
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

/** Digits read aloud, as a speech service writes them: groups of numerals joined by a comma, a full stop, a dash or a space,
 * or by a comma or full stop and a space ("$4,2424,2424,2424,242" for a card number read in fours). */
const SPOKEN_NUMBER = /(?<![\w.,])\d+(?:(?:[,.]? |[,.-])\d+)+(?![\w])/g;

/** A spoken run of numerals loses every stretch of its groups that is a card number (13 to 19 digits that pass the Luhn
 * check) or a value typed into a sensitive field, whatever the separators between the groups. */
const scrubSpokenRun = (
  run: string,
  matches: ((value: string) => boolean) | null,
): string => {
  const groups = [...run.matchAll(/\d+/g)].map((match) => ({
    digits: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const spans: Array<[number, number]> = [];
  for (let first = 0; first < groups.length; first++) {
    const head = groups[first];
    if (!head) continue;
    let digits = "";
    for (let last = first; last < groups.length; last++) {
      const group = groups[last];
      if (!group) break;
      digits += group.digits;
      const card = digits.length <= CARD_MAX_DIGITS && isCardNumber(digits);
      const typed =
        matches !== null &&
        last - first < MAX_DIGEST_GROUPS &&
        digits.length >= MIN_DIGEST_LENGTH &&
        matches(digits);
      if (card || typed) spans.push([head.start, group.end]);
      if (digits.length > CARD_MAX_DIGITS && last - first >= MAX_DIGEST_GROUPS)
        break;
    }
  }
  return redactSpans(run, spans);
};

/** `scrubText` for what a person said while recording, as the browser's speech recognition wrote it: numbers read aloud
 * come back with thousands separators and stray signs, so a spoken card number or typed secret is found in those runs
 * first, then the text masking runs as it does on everything else. */
export function scrubTranscript(text: string, options?: MaskOptions): string {
  const matches =
    options?.digests && options.digests.size > 0
      ? digestMatcher(options)
      : null;
  return scrubText(
    text.replace(SPOKEN_NUMBER, (run) => scrubSpokenRun(run, matches)),
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

const scrubQueryPair = (pair: string, options?: MaskOptions): string => {
  const at = pair.indexOf("=");
  if (at === -1) {
    const decoded = decodeQuietly(pair);
    return scrubText(decoded, options) === decoded &&
      !matchesDigest(decoded, options)
      ? pair
      : REDACTED;
  }
  const key = pair.slice(0, at);
  const value = decodeQuietly(pair.slice(at + 1).replace(/\+/g, " "));
  const redact =
    isCredentialKey(decodeQuietly(key)) ||
    scrubText(value, options) !== value ||
    matchesDigest(value, options);
  return redact ? `${key}=${REDACTED}` : pair;
};

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
  const scrubbedQuery = query
    ? `?${query
        .split("&")
        .map((pair) => scrubQueryPair(pair, options))
        .join("&")}`
    : "";
  return `${parsed.protocol}//${parsed.host}${path}${scrubbedQuery}`;
}

const maskJson = (value: JsonValue, options?: MaskOptions): JsonValue => {
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
  if (Array.isArray(value)) return value.map((item) => maskJson(item, options));
  if (isObject(value)) {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value))
      out[key] = isCredentialKey(key) ? REDACTED : maskJson(item, options);
    return out;
  }
  return value;
};

/** One pair of a form body, as a query pair is masked; a key that is itself a secret (a long token posted bare, base64
 * padding and all) takes the whole pair. */
const maskFormPair = (pair: string, options?: MaskOptions): string => {
  const at = pair.indexOf("=");
  if (at > 0) {
    const key = decodeQuietly(pair.slice(0, at).replace(/\+/g, " "));
    if (scrubText(key, options) !== key || matchesDigest(key, options))
      return REDACTED;
  }
  return scrubQueryPair(pair, options);
};

const maskForm = (text: string, options?: MaskOptions): string =>
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

/** JSON that does not parse, above all a body cut at NETWORK_BODY_READ_MAX_BYTES before it was masked. It is read token by
 * token from its start: the value of every credential-named key is redacted (a whole object or array too, up to its end or
 * the end of the text), a string that matches a digest is redacted whole, and the result is scrubbed as text. Linear. */
const maskJsonText = (text: string, options?: MaskOptions): string => {
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
      if (
        value < text.length &&
        isCredentialKey(jsonStringValue(text.slice(i, end), true))
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
 * short) key by key; a form body pair by pair, declared or not; anything else as text. */
export function maskBody(
  text: string,
  contentType: string | undefined,
  options?: MaskOptions,
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

export function isSensitiveTarget(target: {
  attributes?: Record<string, string>;
  label?: string;
  text?: string;
}): boolean {
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
  return SENSITIVE_FIELD.test(words);
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

export function maskCollectorEvent(
  event: CapturedEvent,
  context: { sensitive: boolean },
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
    const label = typeof target.label === "string" ? target.label : undefined;
    if (context.sensitive || isSensitiveTarget({ attributes, label })) {
      for (const field of TARGET_VALUE_FIELDS)
        if (field in target) target[field] = REDACTED;
      if (attributes)
        for (const field of TARGET_ATTRIBUTE_VALUES)
          if (field in attributes) attributes[field] = REDACTED;
      delete target.selectedValues;
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
  options?: MaskOptions,
): JsonValue | undefined => {
  if (!isObject(part)) return part;
  const out: Obj = { ...part };
  if (typeof out.url === "string") out.url = scrubUrl(out.url, options);
  if (isObject(out.headers))
    out.headers = maskHeaders(out.headers as Record<string, string>, options);
  if (isObject(out.body) && typeof out.body.text === "string") {
    out.body = {
      ...out.body,
      text: maskBody(
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
  if (typeof value.url === "string") value.url = scrubUrl(value.url, options);
  if (typeof value.route === "string")
    value.route = scrubText(value.route, options);
  if (value.request !== undefined)
    value.request = maskExchange(value.request, options) ?? null;
  if (value.response !== undefined)
    value.response = maskExchange(value.response, options) ?? null;
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

export function trimEvent(
  event: CapturedEvent,
  maxBytes: number,
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
