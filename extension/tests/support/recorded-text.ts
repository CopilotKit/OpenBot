// What a leak check searches: everything a captured event records, without the numbers the clock and a stopwatch put in it.
//
// Every captured event says when it happened (`timestamp`, and a network call's `completedAt`) and how long a call took
// (`durationMs`). Those numbers are not recorded content, and they change on every run, so a check that searches the whole
// serialised event for a secret's digits fails whenever the clock happens to hold them. CI's clock read 1792433411150
// (2026-10-19T18:10:11.150Z) while a 2 MiB form test ran: its "4111" is the test card's first group, and an event whose
// body was masked in full failed its leak check. The search therefore runs on the event with those numbers set to 0.
//
// Any other number as large as a clock reading throws rather than being searched or skipped: it is either a clock field
// that CLOCK_FIELDS must name, or a recorded value as long as a card number, and neither may pass a leak check quietly.
// The tests that search events pin Date.now() to a reading that holds their secrets' digits, so a check that read the
// clock again would fail on every run instead of once in thousands.

/** The fields whose numbers come from the clock or a stopwatch, never from the page. */
const CLOCK_FIELDS: ReadonlySet<string> = new Set([
  "timestamp",
  "completedAt",
  "durationMs",
]);
/** 1e12 milliseconds after the epoch is 2001-09-09: every clock reading since is at least this large. */
const CLOCK_SIZED = 1e12;

/** 2025-06-06T12:48:31Z: holds "4921", the tests' PIN, and "4111", the first group of their card. */
export const CARD_AND_PIN_CLOCK = 1_749_214_111_000;
/** 2026-08-29T17:55:00Z: holds "880261", the tests' verification code, and so its "880" too. */
export const CODE_CLOCK = 1_788_026_100_000;

export type RecordedTextOptions = {
  /** Text the test itself put in the event that differs from run to run, such as its server's port: removed before the
   * search, so a port that happens to hold a secret's digits is not a leak. */
  blank?: readonly string[];
};

/** `value` serialised as JSON with every clock and stopwatch number set to 0, ready to be searched for secrets. */
export function recordedText(
  value: unknown,
  options: RecordedTextOptions = {},
): string {
  let text =
    JSON.stringify(value, (key, item: unknown) => {
      if (typeof item !== "number") return item;
      if (CLOCK_FIELDS.has(key)) return 0;
      if (Math.abs(item) >= CLOCK_SIZED)
        throw new Error(
          `recordedText: "${key}" holds ${item}, a number as large as a clock reading. Name the field in CLOCK_FIELDS if the clock wrote it; a recorded value this long is a leak.`,
        );
      return item;
    }) ?? "";
  for (const known of options.blank ?? [])
    if (known) text = text.replaceAll(known, "");
  return text;
}

/** The `secrets` that appear anywhere in what `value` records. */
export function leakedSecrets(
  value: unknown,
  secrets: readonly string[],
  options: RecordedTextOptions = {},
): string[] {
  const text = recordedText(value, options);
  return secrets.filter((secret) => text.includes(secret));
}
