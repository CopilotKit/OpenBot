import { describe, expect, test } from "bun:test";
import { offeredToken } from "../src/authorisation";
import { createControl } from "../src/control";

const SECRET = "a-long-development-secret";
const url = (path: string) => new URL(`http://computer.test${path}`);

/**
 * The header path trimmed while `/stream` did not, so `?token=%20SECRET` 401d while the same
 * value in a header succeeded. `Bearer   SECRET  ` left leading spaces behind the regex.
 */
describe("offered token trimming", () => {
  test("trims a padded stream query token", () => {
    const headers = new Headers();
    expect(
      offeredToken(
        headers,
        url(`/stream?token=${encodeURIComponent(`  ${SECRET}  `)}`),
      ),
    ).toBe(SECRET);
  });

  test("trims the bearer remainder", () => {
    const headers = new Headers({ authorization: `Bearer   ${SECRET}  ` });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });
});

/**
 * `reason` and `label` are stored and polled ~1Hz by every viewer for the request TTL. A
 * model-generated megabyte string would be retained and re-served the whole time; capped at 500.
 */
describe("control reason/label caps", () => {
  test("caps a long help reason at 500 characters", () => {
    const control = createControl();
    const state = control.requestHelp("r".repeat(2000));
    expect(state.reason).toHaveLength(500);
  });

  test("caps a long secret label at 500 characters", () => {
    const control = createControl();
    const state = control.requestSecret({ label: "l".repeat(2000), ref: "e1" });
    expect(state.secretWanted).toHaveLength(500);
  });
});
