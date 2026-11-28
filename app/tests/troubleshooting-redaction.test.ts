/**
 * The web app's troubleshooting file hides exactly what OpenBot Desktop's does.
 *
 * `shared/redaction-cases.json` holds real lines (Desktop's log, the CLI's JSON lines, an `.env`
 * file, the web app's own request paths, request ids and errors) and what each becomes under
 * Desktop's rules (desktop/src-tauri/src/logging.rs): `redact` for words, `redact_keeping_ids` for
 * what is known to be an id. Desktop's tests read the same file, so the two cannot drift apart.
 * The key-shaped values in it are fakes that only match the shapes.
 */
import { expect, test } from "bun:test";
import { redact, redactKeepingIds } from "@/lib/troubleshooting/redact";

type Case = { input: string; redacted: string; keepingIds: string };

const cases = (await Bun.file(
  new URL("../../shared/redaction-cases.json", import.meta.url),
).json()) as Case[];

test("the shared cases are many and real", () => {
  expect(cases.length).toBeGreaterThan(60);
});

test("every shared case redacts as Desktop does", () => {
  for (const { input, redacted, keepingIds } of cases) {
    expect([input, redact(input)]).toEqual([input, redacted]);
    expect([input, redactKeepingIds(input)]).toEqual([input, keepingIds]);
  }
});
