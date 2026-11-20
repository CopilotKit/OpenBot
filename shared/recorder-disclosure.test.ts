import { expect, test } from "bun:test";
import {
  RECORDER_COLLECTS,
  RECORDER_COLLECTS_SHORT,
} from "./recorder-disclosure";
import { REDACTED, scrubText } from "./recorder-masking";

/**
 * The disclosure's masking item says what the masking takes, and the masking takes it.
 *
 * It said "passwords, card numbers and other secrets", while every string a recording sends also loses its email
 * addresses, and a clicked control's name its web addresses as well (the CopilotKit capture's own cleaning, which
 * extension/tests/learning-patch.test.ts pins). A disclosure that names less than is taken is still true; one that is
 * read as "only secrets" while email addresses go too is not plain about it. Each kind is checked on a real-world string
 * against the masking itself, so the sentence cannot claim what the code no longer does either.
 */
/**
 * A payment provider's secret key, made up, built here so the file holds no string shaped like a live key: secret
 * scanners (GitHub's push protection among them) refuse a push that carries one, fake or not.
 */
const PAYMENT_KEY = [
  "sk",
  "live",
  "51H8aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
].join("_");

const masking = RECORDER_COLLECTS.find((item) => item.kind === "masking");

const MASKED: readonly { named: string; text: string; secret: string }[] = [
  {
    named: "card numbers",
    text: "Paid with 4111 1111 1111 1111 on Tuesday",
    secret: "4111 1111 1111 1111",
  },
  {
    named: "email addresses",
    text: "Send the receipt to ada.lovelace@example.com please",
    secret: "ada.lovelace@example.com",
  },
  {
    named: "sign-in tokens",
    text: "Authorization: Bearer 0f3c9a7e-1b2d-4c5e-8f9a-0b1c2d3e4f5a",
    secret: "0f3c9a7e-1b2d-4c5e-8f9a-0b1c2d3e4f5a",
  },
  {
    named: "sign-in tokens",
    text: "id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJlLXZhbHVl done",
    secret: "eyJzdWIiOiJhZGEifQ",
  },
  {
    named: "keys",
    text: `key ${PAYMENT_KEY} set`,
    secret: PAYMENT_KEY,
  },
];

test("each kind of thing the masking takes is named in the disclosure, and is taken", () => {
  const description = masking?.description ?? "";
  for (const { named, text, secret } of MASKED) {
    const masked = scrubText(text);
    expect(masked).not.toContain(secret);
    expect(masked).toContain(REDACTED);
    expect(description).toContain(named);
  }
  // A secret field's own value goes by what the field is (recorder-masking.ts `SENSITIVE_FIELD`), and a clicked
  // control's name loses its web addresses (learning-patch.test.ts).
  for (const named of [
    "passwords",
    "one-time codes",
    "secret field",
    "Web addresses",
    "buttons and links you click",
  ])
    expect(description).toContain(named);
  expect(RECORDER_COLLECTS_SHORT).toContain(
    "Passwords, card numbers, email addresses and tokens are masked",
  );
});

test("what the masking leaves is said to be left: a phone number, a name and an amount", () => {
  const text =
    "Call Ada Lovelace on +44 20 7946 0958 about the 1,250.00 refund";
  expect(scrubText(text)).toBe(text);
  expect(masking?.description).toContain(
    "such as names, phone numbers and amounts, can still be included",
  );
});
