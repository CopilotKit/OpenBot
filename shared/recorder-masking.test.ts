import { expect, test } from "bun:test";
import {
  isCredentialKey,
  isSensitiveTarget,
  luhnValid,
  maskBody,
  maskCollectorEvent,
  maskHeaders,
  maskNetworkEvent,
  normaliseSecret,
  REDACTED,
  sanitiseForIntelligence,
  scrubText,
  scrubTranscript,
  scrubUrl,
  sha256HexSync,
  trimEvent,
} from "./recorder-masking";

// Looks inside a masked event's JSON value by path, the way the assertions below read it.
// biome-ignore lint/suspicious/noExplicitAny: a probe over arbitrary event JSON
type Probe = any;
const at = (
  event: { value: unknown } | null | undefined,
  ...path: string[]
): Probe => path.reduce((node: Probe, key) => node?.[key], event?.value);

const digestsOf = (...values: string[]) =>
  new Set(values.map((v) => sha256HexSync(normaliseSecret(v))));

test("credential headers keep their name and lose their value", () => {
  expect(
    maskHeaders({
      Authorization: "Bearer abc",
      Cookie: "s=1",
      "Set-Cookie": "s=1",
      "X-Api-Key": "k",
      Accept: "application/json",
    }),
  ).toEqual({
    Authorization: REDACTED,
    Cookie: REDACTED,
    "Set-Cookie": REDACTED,
    "X-Api-Key": REDACTED,
    Accept: "application/json",
  });
});

test("credential keys follow the collector's rules plus payment-card keys", () => {
  for (const key of [
    "password",
    "apiKey",
    "subscriptionKey",
    "client_secret",
    "accessToken",
    "id_token",
    "x-csrf-token",
    "cookie",
    "token",
    "otp",
    "pin",
    "cvv",
    "cvc",
    "cardNumber",
    "cc_number",
  ])
    expect([key, isCredentialKey(key)]).toEqual([key, true]);
  for (const key of [
    "tokenExpiry",
    "token_in",
    "sessionIds",
    "passwordPolicy",
    "pinned",
    "shipping",
    "page",
    "count",
  ])
    expect([key, isCredentialKey(key)]).toEqual([key, false]);
});

test("tokens in URLs are scrubbed, ordinary query values and long readable paths are kept", () => {
  expect(
    scrubUrl(
      "https://u:p@api.example.test/v1/a/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln?access_token=abc&page=2#frag",
    ),
  ).toBe(
    `https://api.example.test/v1/a/${REDACTED}?access_token=${REDACTED}&page=2`,
  );
  const readable =
    "https://docs.example.test/docs/getting-started/installation-guide-for-enterprise-customers";
  expect(scrubUrl(readable)).toBe(readable);
});

test("JSON bodies lose credential values at any depth and keep shape", () => {
  const body = JSON.stringify({
    user: { email: "ana@example.test", password: "hunter22" },
    meta: { refreshToken: "r", count: 3 },
  });
  expect(JSON.parse(maskBody(body, "application/json"))).toEqual({
    user: { email: REDACTED, password: REDACTED },
    meta: { refreshToken: REDACTED, count: 3 },
  });
});

test("a value typed into a sensitive field is scrubbed wherever it reappears, even 3 digits long", async () => {
  const digests = digestsOf("4111111111111111", "737");
  expect(
    JSON.parse(
      maskBody(
        '{"n":"4111111111111111","s":"737","q":"shoes"}',
        "application/json",
        { digests },
      ),
    ),
  ).toEqual({ n: REDACTED, s: REDACTED, q: "shoes" });
  expect(
    maskBody(
      "card=4111111111111111&q=shoes&s=737",
      "application/x-www-form-urlencoded",
      { digests },
    ),
  ).toBe(`card=${REDACTED}&q=shoes&s=${REDACTED}`);
});

test("numbers in JSON are matched against digests too", async () => {
  const digests = digestsOf("737");
  expect(
    JSON.parse(
      maskBody('{"code":737,"qty":2}', "application/json", { digests }),
    ),
  ).toEqual({ code: REDACTED, qty: 2 });
});

test("card numbers are scrubbed in any format, without a digest, when they pass the Luhn check", () => {
  expect(luhnValid("4111111111111111")).toBe(true);
  expect(luhnValid("4111111111111112")).toBe(false);
  expect(
    scrubText(
      "card 4111 1111 1111 1111 and 4111-1111-1111-1111 and order 1234567890123",
    ),
  ).toBe(`card ${REDACTED} and ${REDACTED} and order 1234567890123`);
  expect(
    JSON.parse(maskBody('{"pan":4111111111111111}', "application/json")),
  ).toEqual({ pan: REDACTED });
});

test("a Luhn-valid timestamp or id is redacted too, by design (Decision 15)", () => {
  // 1760000000008 is a millisecond timestamp that happens to pass Luhn; losing it is the price of never leaking a card.
  expect(luhnValid("1760000000008")).toBe(true);
  expect(luhnValid("1760000000007")).toBe(false);
  expect(
    JSON.parse(
      maskBody('{"at":1760000000008,"n":1760000000007}', "application/json"),
    ),
  ).toEqual({ at: REDACTED, n: 1760000000007 });
});

test("query values are replaced with a literal [redacted], never percent-encoded", () => {
  expect(scrubUrl("https://x.test/a?token=abc&q=a%20b")).toBe(
    `https://x.test/a?token=${REDACTED}&q=a%20b`,
  );
});

test("a scrubbed path segment keeps a literal [redacted] and re-encodes only what is around it", () => {
  expect(scrubUrl("https://x.test/users/ana%40example.test/notes%20one")).toBe(
    `https://x.test/users/${REDACTED}/notes%20one`,
  );
  expect(
    scrubUrl("https://x.test/a/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln/b"),
  ).not.toContain("%5B");
});

test("headers keep their names and case; non-credential values are scrubbed as text", () => {
  expect(
    maskHeaders({ "X-Note": "mail ana@example.test", "x-api-key": "k" }),
  ).toEqual({ "X-Note": `mail ${REDACTED}`, "x-api-key": REDACTED });
});

test("normaliseSecret trims, and reduces digits with spaces or dashes to digits", () => {
  expect(normaliseSecret("  4111 1111-1111 1111 ")).toBe("4111111111111111");
  expect(normaliseSecret(" Hunter 2 ")).toBe("Hunter 2");
});

test("a space-formatted secret typed into a sensitive field matches its digits-only form in a body", async () => {
  const digests = digestsOf("4111 1111 1111 1111");
  expect(
    maskBody('{"x":"4111111111111111"}', "application/json", { digests }),
  ).toBe(`{"x":"${REDACTED}"}`);
});

test("collector input events from sensitive fields lose their value", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "input",
    timestamp: 1,
    value: {
      target: {
        tag: "input",
        value: "1234",
        attributes: { autocomplete: "one-time-code" },
      },
      url: "https://x.test/a?code=1",
    },
  };
  const masked = maskCollectorEvent(event, { sensitive: false });
  expect(at(masked, "target", "value")).toBe(REDACTED);
});

test("a sensitive target loses its value, its mirrored value attribute, its text and its selected values", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "click",
    timestamp: 1,
    value: {
      target: {
        tag: "input",
        value: "4111111111111111",
        text: "4111111111111111",
        selectedValues: ["x"],
        attributes: {
          name: "f7",
          value: "4111111111111111",
          "aria-valuetext": "4111111111111111",
        },
      },
    },
  };
  const target = at(maskCollectorEvent(event, { sensitive: true }), "target");
  expect(target.value).toBe(REDACTED);
  expect(target.text).toBe(REDACTED);
  expect(target.attributes.value).toBe(REDACTED);
  expect(target.attributes["aria-valuetext"]).toBe(REDACTED);
  expect(target.attributes.name).toBe("f7");
  expect("selectedValues" in target).toBe(false);
});

test("a contenteditable field's text is redacted when it is sensitive", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "input",
    timestamp: 1,
    value: {
      target: {
        tag: "div",
        value: "737",
        text: "737",
        attributes: { contenteditable: "true", "aria-label": "Security code" },
      },
    },
  };
  const target = at(maskCollectorEvent(event, { sensitive: false }), "target");
  expect([target.value, target.text]).toEqual([REDACTED, REDACTED]);
});

test("emails and long tokens are scrubbed from every string in an event", () => {
  expect(
    scrubText("mail ana@example.test key abcdefghijklmnopqrstuvwxyz012345"),
  ).toBe(`mail ${REDACTED} key ${REDACTED}`);
});

test("network events mask headers, bodies and URLs together", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: {
      method: "POST",
      url: "https://api.x.test/login?sig=abcdefghijklmnopqrstuvwxyz0123456789",
      status: 200,
      request: {
        headers: { authorization: "Bearer t" },
        body: { status: "complete", text: '{"password":"p"}' },
      },
      response: {
        headers: { "set-cookie": "s=1", "content-type": "application/json" },
        body: { status: "complete", text: '{"token":"t","ok":true}' },
      },
    },
  };
  const v = at(maskNetworkEvent(event));
  expect(v.url).toBe(`https://api.x.test/login?sig=${REDACTED}`);
  expect(v.request.headers.authorization).toBe(REDACTED);
  expect(JSON.parse(v.request.body.text)).toEqual({ password: REDACTED });
  expect(JSON.parse(v.response.body.text)).toEqual({
    token: REDACTED,
    ok: true,
  });
});

test("an event over budget is trimmed body-first and says so", () => {
  const big = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: {
      response: { body: { status: "complete", text: "a".repeat(40_000) } },
    },
  };
  const { event, trimmed } = trimEvent(big, 15 * 1024);
  expect(trimmed).toBe(true);
  expect(
    new TextEncoder().encode(JSON.stringify(event)).byteLength,
  ).toBeLessThanOrEqual(15 * 1024);
  expect(at(event, "response", "body", "status")).toBe("truncated");
});

const eventBytes = (event: unknown) =>
  new TextEncoder().encode(JSON.stringify(event)).byteLength;

test("a large request is cut first and its small response survives whole, with the event filling its budget", () => {
  const response = '{"ok":true,"id":"a1b2c3d4"}';
  expect(response).toHaveLength(27);
  const upload = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: {
      url: "https://api.x.test/upload",
      request: {
        method: "POST",
        body: { status: "complete", text: "a".repeat(2_600_000) },
      },
      response: { status: 200, body: { status: "complete", text: response } },
    },
  };
  const { event, trimmed } = trimEvent(upload, 15 * 1024);
  expect(trimmed).toBe(true);
  expect(at(event, "response", "body")).toEqual({
    status: "complete",
    text: response,
  });
  expect(at(event, "request", "body", "status")).toBe("truncated");
  expect(at(event, "request", "body", "truncated")).toBe(true);
  // The cut leaves the event as close to the budget as one more character would overshoot.
  expect(eventBytes(event)).toBeLessThanOrEqual(15 * 1024);
  expect(eventBytes(event)).toBeGreaterThan(15 * 1024 - 2);
});

test("two large bodies are cut to the same length, and neither is emptied", () => {
  const both = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: {
      request: { body: { status: "complete", text: "q".repeat(60_000) } },
      response: { body: { status: "complete", text: "r".repeat(40_000) } },
    },
  };
  const { event } = trimEvent(both, 15 * 1024);
  const request: string = at(event, "request", "body", "text");
  const responseText: string = at(event, "response", "body", "text");
  expect(request.length).toBe(responseText.length);
  expect(request.length).toBeGreaterThan(7_000);
  expect(at(event, "response", "body", "status")).toBe("truncated");
  expect(eventBytes(event)).toBeLessThanOrEqual(15 * 1024);
});

test("an input event with a huge value is trimmed by shortening the value and text", () => {
  const big = {
    type: "CUSTOM" as const,
    name: "input",
    timestamp: 1,
    value: {
      target: {
        tag: "textarea",
        value: "b".repeat(40_000),
        text: "b".repeat(40_000),
      },
    },
  };
  const { event, trimmed } = trimEvent(big, 15 * 1024);
  expect(trimmed).toBe(true);
  expect(
    new TextEncoder().encode(JSON.stringify(event)).byteLength,
  ).toBeLessThanOrEqual(15 * 1024);
  expect(at(event, "truncated")).toBe(true);
});

test("NUL characters never reach Intelligence", () => {
  expect(sanitiseForIntelligence({ "a\u0000b": ["x\u0000y", 1] })).toEqual({
    "a�b": ["x�y", 1],
  });
});

test("a lone surrogate never reaches Intelligence, so a split emoji cannot crash the gateway's decoder", () => {
  // "\ud83d" alone is what textContent.slice(0, 1000) leaves when it cuts "😀" in half; JSON.stringify writes it as a lone escape.
  const out = sanitiseForIntelligence({
    text: "ab\ud83d",
    "k\udc00": ["\ud83d\ude00 ok"],
  });
  expect(out).toEqual({ text: "ab\ufffd", "k\ufffd": ["\ud83d\ude00 ok"] });
  expect(JSON.stringify(out)).not.toMatch(
    /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i,
  );
});

test("trimming never splits a surrogate pair", () => {
  const big = {
    type: "CUSTOM" as const,
    name: "input",
    timestamp: 1,
    value: {
      target: {
        tag: "textarea",
        value: "😀".repeat(20_000),
        text: "😀".repeat(20_000),
      },
    },
  };
  const { event } = trimEvent(big, 15 * 1024);
  const target = at(event, "target");
  for (const text of [target.value, target.text])
    expect(text.isWellFormed()).toBe(true);
});

test("a collector event whose text was cut mid-emoji is made well-formed by the masking", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "click",
    timestamp: 1,
    value: { target: { tag: "button", text: "Save \ud83d" } },
  };
  expect(
    at(maskCollectorEvent(event, { sensitive: false }), "target", "text"),
  ).toBe("Save \ufffd");
});

test("sha256HexSync matches the platform's SHA-256, and needs no crypto.subtle", async () => {
  for (const value of ["", "abc", "4111111111111111", "😀 x".repeat(100)]) {
    const platform = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ).toString("hex");
    expect(sha256HexSync(value)).toBe(platform);
  }
  expect(sha256HexSync("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const platform737 = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("737")),
  ).toString("hex");
  const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
  Object.defineProperty(globalThis.crypto, "subtle", {
    value: undefined,
    configurable: true,
  }); // an insecure http page
  try {
    expect(sha256HexSync("737")).toBe(platform737);
  } finally {
    if (subtle) Object.defineProperty(globalThis.crypto, "subtle", subtle);
    // subtle is a getter on Crypto's prototype; deleting the own override restores it
    else delete (globalThis.crypto as { subtle?: unknown }).subtle;
  }
  expect(typeof globalThis.crypto.subtle?.digest).toBe("function");
});

test("a hyphenated UUID is redacted by the long-token rule, by design (Decision 15)", () => {
  expect(scrubText("deal 3f2b8c1e-9a4d-4e6b-8f1a-2c3d4e5f6a7b")).toBe(
    `deal ${REDACTED}`,
  );
});

test("sensitivity is read from autocomplete, name, aria-label, placeholder and label text", () => {
  expect(isSensitiveTarget({ attributes: { autocomplete: "cc-csc" } })).toBe(
    true,
  );
  expect(isSensitiveTarget({ attributes: { name: "shipping_topping" } })).toBe(
    false,
  );
  expect(
    isSensitiveTarget({ attributes: { "aria-label": "Verification code" } }),
  ).toBe(true);
  expect(isSensitiveTarget({ label: "Card number" })).toBe(true);
});

test("sanitiseForIntelligence replaces every NUL, not only the first", () => {
  expect(
    sanitiseForIntelligence({ "a\u0000b\u0000c": ["x\u0000y\u0000z"] }),
  ).toEqual({ "a�b�c": ["x�y�z"] });
});

test("maskBody redacts a JSON integer too large to check after rounding", () => {
  expect(
    JSON.parse(
      maskBody('{"pan":6250941006528599123,"n":42}', "application/json"),
    ),
  ).toEqual({ pan: REDACTED, n: 42 });
});

test("isCredentialKey decodes each escape on its own, like the collector", () => {
  expect(isCredentialKey("client%5Fsecret%zz")).toBe(true);
  expect(isCredentialKey("access%5Ftoken%")).toBe(true);
});

/** Milliseconds a synchronous call takes. */
const elapsedMs = (run: () => unknown): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

/** Deterministic pseudo-random bytes, so a timing test masks realistic base64 rather than one repeated letter. */
const noise = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let seed = 1;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    bytes[i] = seed >>> 24;
  }
  return bytes;
};

test("a 2 MB run without whitespace is scrubbed in linear time", () => {
  const text = "x".repeat(2_000_000);
  let out = "";
  expect(elapsedMs(() => (out = scrubText(text)))).toBeLessThan(5000);
  expect(out === text).toBe(true);
});

test("a JSON body holding a 2 MiB data URI is masked in linear time", () => {
  // 1.5 MiB of bytes is exactly 2 MiB of base64.
  const image = `data:image/png;base64,${Buffer.from(noise(1_572_864)).toString("base64")}`;
  const body = JSON.stringify({ name: "photo.png", image });
  let out = "";
  expect(
    elapsedMs(() => (out = maskBody(body, "application/json"))),
  ).toBeLessThan(5000);
  expect(JSON.parse(out).name).toBe("photo.png");
});

test("a 200,000-digit run is scrubbed in linear time when digests are present", async () => {
  const digests = digestsOf("737");
  const text = "1".repeat(200_000);
  let out = "";
  expect(elapsedMs(() => (out = scrubText(text, { digests })))).toBeLessThan(
    5000,
  );
  expect(out === text).toBe(true);
});

test("a 2 MB run of one-digit groups is scrubbed in linear time when digests are present", async () => {
  const digests = digestsOf("737");
  const text = "1 ".repeat(1_000_000);
  let out = "";
  expect(elapsedMs(() => (out = scrubText(text, { digests })))).toBeLessThan(
    5000,
  );
  expect(out === text).toBe(true);
});

test("a long dotless run full of eyJ is scrubbed in linear time, and a JWT after other letters is still found", () => {
  expect(elapsedMs(() => scrubText("eyJ".repeat(700_000)))).toBeLessThan(5000);
  expect(scrubText("xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln end")).toBe(
    `x${REDACTED} end`,
  );
});

test("a card number beside an expiry, a security code or a quantity is still redacted", () => {
  expect(scrubText("Card 4111 1111 1111 1111 12/28")).toBe(
    `Card ${REDACTED} 12/28`,
  );
  expect(scrubText("4111111111111111 737")).toBe(`${REDACTED} 737`);
  expect(scrubText("qty 2 4111 1111 1111 1111")).toBe(`qty 2 ${REDACTED}`);
  expect(scrubText("3782 822463 10005 737")).toBe(`${REDACTED} 737`);
  expect(scrubText("4111111111111111 5555555555554444")).toBe(
    `${REDACTED} ${REDACTED}`,
  );
});

test("a card number beside an expiry is redacted when its digest is known too", async () => {
  const digests = digestsOf("4111 1111 1111 1111");
  expect(scrubText("Card 4111 1111 1111 1111 12/28", { digests })).toBe(
    `Card ${REDACTED} 12/28`,
  );
});

test("a typed number that fails Luhn is found by its digest inside a longer run of digit groups", async () => {
  const digests = digestsOf("4111 1111 1111 1112", "123456");
  expect(scrubText("Card 4111 1111 1111 1112 12/28", { digests })).toBe(
    `Card ${REDACTED} 12/28`,
  );
  expect(scrubText("ref 9 123 456 7", { digests })).toBe(`ref 9 ${REDACTED} 7`);
});

test("short numbers in a row are not mistaken for a card number", () => {
  expect(scrubText("Page 1 2 3 4 5 6 7 8 9 10 11 12")).toBe(
    "Page 1 2 3 4 5 6 7 8 9 10 11 12",
  );
});

test("a secret beside punctuation or inside markup is still found by its digest", async () => {
  const digests = digestsOf("737", "hunter22");
  expect(scrubText("Invalid code: 737.", { digests })).toBe(
    `Invalid code: ${REDACTED}.`,
  );
  expect(scrubText("<td>737</td>", { digests })).toBe(`<td>${REDACTED}</td>`);
  expect(scrubText("(737)", { digests })).toBe(`(${REDACTED})`);
  expect(scrubText("<b>hunter22</b>", { digests })).toBe(`<b>${REDACTED}</b>`);
  expect(
    JSON.parse(
      maskBody('{"error":"Invalid code: 737."}', "application/json", {
        digests,
      }),
    ),
  ).toEqual({ error: `Invalid code: ${REDACTED}.` });
});

test("a secret that contains a period still matches its digest", async () => {
  const digests = digestsOf("p.ss");
  expect(scrubText("password p.ss was rejected", { digests })).toBe(
    `password ${REDACTED} was rejected`,
  );
});

test("a header value that is not a string is scrubbed as its string form", () => {
  const event = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: {
      method: "GET",
      url: "https://x.test/a",
      request: { headers: { "content-length": 12 } },
      response: { headers: { "content-length": 2 } },
    },
  };
  let masked: ReturnType<typeof maskNetworkEvent> | undefined;
  expect(() => {
    masked = maskNetworkEvent(event);
  }).not.toThrow();
  expect(at(masked, "request", "headers", "content-length")).toBe("12");
  expect(at(masked, "response", "headers", "content-length")).toBe("2");
});

// A realistic sign-in and payment: what a form post or a JSON body carries. None of these may reach Intelligence.
const PASSWORD = "hunter2";
const PIN = "4921";
const CARD = "4111 1111 1111 1111";
const SESSION_TOKEN = "sess_9f8e7d6c";
const leaks = (text: string) =>
  [PASSWORD, PIN, "4111", SESSION_TOKEN].filter((secret) =>
    text.includes(secret),
  );

test("a form body is masked pair by pair whatever type it was declared with, or none", () => {
  const body = new URLSearchParams({
    username: "alice",
    password: PASSWORD,
    pin: PIN,
    card_number: CARD,
    session_token: SESSION_TOKEN,
    remember: "1",
  }).toString();
  for (const type of [
    undefined,
    "text/plain;charset=UTF-8",
    "application/x-www-form-urlencoded;charset=UTF-8",
  ]) {
    const masked = maskBody(body, type);
    expect(leaks(masked)).toEqual([]);
    expect(masked).toBe(
      "username=alice&password=[redacted]&pin=[redacted]&card_number=[redacted]&session_token=[redacted]&remember=1",
    );
  }
});

test("a form body cut short keeps none of its credentials", () => {
  const body = `username=alice&password=${PASSWORD}&pin=${PIN}&session_token=${SESSION_TOKEN}&notes=${"a".repeat(64)}`;
  const masked = maskBody(body.slice(0, body.length - 20), undefined);
  expect(leaks(masked)).toEqual([]);
  expect(masked.startsWith("username=alice&password=[redacted]")).toBe(true);
});

test("a long token posted as plain text is still redacted, though it looks like one form pair", () => {
  expect(
    maskBody("c2VjcmV0LXRva2VuLWZvci10aGUtYXBpLTEyMzQ1Njc4OTA=", "text/plain"),
  ).toBe(REDACTED);
  expect(maskBody("total = 3 apples", "text/plain")).toBe("total = 3 apples");
});

test("JSON cut short keeps none of its credentials: each credential-named key loses its value, to the end of the text", () => {
  const whole = JSON.stringify({
    user: { name: "alice", password: PASSWORD },
    session_token: SESSION_TOKEN,
    payment: { pin: PIN, card_number: CARD, cvv: 737 },
    note: "kept",
    rows: "x".repeat(1000),
  });
  const cut = whole.slice(0, whole.indexOf("xxxxx") + 5);
  for (const type of ["application/json; charset=utf-8", undefined]) {
    const masked = maskBody(cut, type);
    expect(leaks(masked)).toEqual([]);
    expect(masked).not.toContain("737");
    expect(masked).toContain('"name":"alice"');
    expect(masked).toContain('"password":"[redacted]"');
    expect(masked).toContain('"note":"kept"');
  }
});

test("JSON cut inside a credential's value, or inside a credential-named object, keeps none of it", () => {
  expect(
    leaks(maskBody(`{"user":"alice","password":"${PASSWORD}`, undefined)),
  ).toEqual([]);
  const nested = maskBody(
    `{"user":"alice","credentials":{"username":"alice","answer":"blue-sky","pin":"${PIN}"`,
    "application/json",
  );
  expect(nested).toBe('{"user":"alice","credentials":"[redacted]"');
  // An escaped quote inside a value never ends the string early, so a key-shaped run inside it stays text.
  const escaped = maskBody(
    `[{"pass\\u0077ord":"${PASSWORD}","memo":"say \\"pin\\": open"},{"session_token": "${SESSION_TOKEN}`,
    "application/json",
  );
  expect(escaped).toBe(
    '[{"pass\\u0077ord":"[redacted]","memo":"say \\"pin\\": open"},{"session_token": "[redacted]"',
  );
});

test("JSON cut short is matched against digests and card numbers too", () => {
  const masked = maskBody(
    `{"memo":"my code is 737","echo":"hunter 22","total":4111111111111111,"rows":["a`,
    "application/json",
    { digests: digestsOf("737", "hunter 22") },
  );
  expect(masked).toBe(
    '{"memo":"my code is [redacted]","echo":"[redacted]","total":[redacted],"rows":["a',
  );
});

test("JSON of 2 MiB cut inside a string is masked in linear time", () => {
  const cut = `{"password":"${PASSWORD}","rows":[${'"row", '.repeat(300_000)}"${"x".repeat(100_000)}`;
  let out = "";
  expect(
    elapsedMs(() => (out = maskBody(cut, "application/json"))),
  ).toBeLessThan(5000);
  expect(leaks(out)).toEqual([]);
});

test("a spoken card number is scrubbed however the speech service wrote its digits", () => {
  // As Chrome's speech services wrote "4242 4242 4242 4242" read aloud: thousands separators, a stray currency sign or
  // dash, commas with spaces, and the plain groups an on-device model writes.
  expect(scrubTranscript("my card number is $4,2424,2424,2424,242")).toBe(
    `my card number is $${REDACTED}`,
  );
  expect(scrubTranscript("my card number is 4,242-42424,2424,242")).toBe(
    `my card number is ${REDACTED}`,
  );
  expect(scrubTranscript("My card number is 4242 4242 4242 4242.")).toBe(
    `My card number is ${REDACTED}.`,
  );
  expect(scrubTranscript("it is 4242, 4242, 4242, 4242 thanks")).toBe(
    `it is ${REDACTED} thanks`,
  );
  expect(
    scrubTranscript("card 4,242-42424,2424,242 expires 12 28, code 123"),
  ).toBe(`card ${REDACTED} expires ${REDACTED}, code ${REDACTED}`);
});

test("a spoken number the speech service cut short or ran together is scrubbed too, whatever its checksum", () => {
  // What Chrome wrote for "4 0 1 2, 8 8 8 8, 8 8 8 8, 1 8 8 1" read aloud in a real run: digits dropped or merged, so no
  // longer a valid card number, or cut off at Stop.
  const said: Array<[string, string]> = [
    ["my card number is 4012-888888-1881", `my card number is ${REDACTED}`],
    ["my card number is 4012-8888", `my card number is ${REDACTED}`],
    ["my card number is 4012 8888 8888 1881", `my card number is ${REDACTED}`],
    ["my card number is 4012-8888-8888-1881", `my card number is ${REDACTED}`],
    [
      "my card number is $4,012,888,888,881,881",
      `my card number is $${REDACTED}`,
    ],
    // Six digits or more go with no word before them, however they are split.
    ["it is 4012-888888-1881 thanks", `it is ${REDACTED} thanks`],
    ["then 4012 88 and done", `then ${REDACTED} and done`],
    ["type 4 0 1 2, 8 8 then", `type ${REDACTED} then`],
    ["type 4 0 1 2 - 8 8 then", `type ${REDACTED} then`],
    ["that is $4,2424,2424 there", `that is $${REDACTED} there`],
    ["40128888 is the one", `${REDACTED} is the one`],
    ["try 4012.8888.", `try ${REDACTED}.`],
    ["call 555 123 4567", `call ${REDACTED}`],
    ["ref ab4012888 now", `ref ab${REDACTED} now`],
  ];
  for (const [text, masked] of said) expect(scrubTranscript(text)).toBe(masked);
});

test("after a word that names a secret, every number that follows in the phrase goes, however short", () => {
  const said: Array<[string, string]> = [
    ["my PIN is 1234", `my PIN is ${REDACTED}`],
    ["the CVV is 123", `the CVV is ${REDACTED}`],
    ["CVC 4 2 1 please", `CVC ${REDACTED} please`],
    ["the security code is 421", `the security code is ${REDACTED}`],
    ["my card number is 4012", `my card number is ${REDACTED}`],
    ["debit card ending 1881", `debit card ending ${REDACTED}`],
    ["credit limit 500", `credit limit ${REDACTED}`],
    ["account 77 please", `account ${REDACTED} please`],
    ["routing number 12", `routing number ${REDACTED}`],
    ["IBAN GB 82 WEST", `IBAN GB ${REDACTED} WEST`],
    ["SSN is 123", `SSN is ${REDACTED}`],
    [
      "my social security number is 123 45",
      `my social security number is ${REDACTED}`,
    ],
    ["the passcode is 0000", `the passcode is ${REDACTED}`],
    ["my pass code is 12", `my pass code is ${REDACTED}`],
    ["my password is hunter2", `my password is ${REDACTED}`],
    ["the OTP is 48", `the OTP is ${REDACTED}`],
    ["verification code 4821", `verification code ${REDACTED}`],
    [
      "my card number is 4012 and then order 1043",
      `my card number is ${REDACTED} and then order ${REDACTED}`,
    ],
    // A number said before the word is not after it.
    ["order 1043 on my card", "order 1043 on my card"],
  ];
  for (const [text, masked] of said) expect(scrubTranscript(text)).toBe(masked);
});

test("a number said in the phrase after one that names a secret goes too, as Chrome splits a phrase at a pause", () => {
  expect(scrubTranscript("4012", { before: "my card number is" })).toBe(
    REDACTED,
  );
  expect(scrubTranscript("it is 12 34", { before: "and my PIN" })).toBe(
    `it is ${REDACTED}`,
  );
  expect(
    scrubTranscript("order 1043", { before: "I opened the order page" }),
  ).toBe("order 1043");
});

test("ordinary numbers in speech are kept", () => {
  for (const text of [
    "order 1043, 2 items for $12.50 in 3 minutes",
    "step 3 then step 4",
    "open order 1043 and refund 2 items",
    "12345 is five digits",
    "on October 18, 2026 the parcel came",
    "it shipped December 3 2026",
    "discard 3 drafts and add 2 to the cart",
    "I pinned 2 tabs",
  ])
    expect(scrubTranscript(text)).toBe(text);
});

test("a spoken transcript keeps ordinary numbers and loses what the text masking always takes", () => {
  expect(scrubTranscript("order 1043, 2 items for $12.50 in 3 minutes")).toBe(
    "order 1043, 2 items for $12.50 in 3 minutes",
  );
  expect(scrubTranscript("write to ana@example.test now")).toBe(
    `write to ${REDACTED} now`,
  );
});

test("a value typed into a sensitive field is scrubbed when it is spoken, whatever the separators", () => {
  const digests = new Set([sha256HexSync("737"), sha256HexSync("hunter2")]);
  expect(scrubTranscript("the code is 7,3,7 ok", { digests })).toBe(
    `the code is ${REDACTED} ok`,
  );
  expect(scrubTranscript("the code is 7 3 7", { digests })).toBe(
    `the code is ${REDACTED}`,
  );
  expect(scrubTranscript("my password is hunter2", { digests })).toBe(
    `my password is ${REDACTED}`,
  );
  expect(scrubTranscript("I need 7,38 of them", { digests })).toBe(
    "I need 7,38 of them",
  );
});
