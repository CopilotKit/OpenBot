import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import { enterText, FieldValueError } from "../src/enter-text";

/**
 * Typing into a form the way a Bot does: an AI snapshot, then the field by its `aria-ref`.
 *
 * A CRM's New account form has text boxes and dropdowns side by side. Typing "Logistics" into the
 * Industry dropdown used `fill`, which waits on a `<select>` until it times out; the server reported
 * that as a ref gone stale, the Bot's turn ended, and no account was ever saved.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/enter-text.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const ACTING = { timeout: 2_000 };

const FORM = `<!doctype html><title>New account</title>
<form>
  <label>Account name <input name="name" value="Draft"></label>
  <label>Industry
    <select name="industry">
      <option value="">Select an industry</option>
      <option value="fin">Financial services</option>
      <option value="logistics">Logistics</option>
      <option value="retired" disabled>Retired</option>
    </select>
  </label>
</form>
<output id="changes">0</output>
<script>
  const changes = document.getElementById("changes");
  document.querySelector("select").addEventListener("change", () => {
    changes.textContent = String(Number(changes.textContent) + 1);
  });
</script>`;

let browser: Browser;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright");
  // Match the computer image: full Chromium is installed without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The form, and the refs its AI snapshot gives each field, as the computer reads them. */
async function openForm(): Promise<{
  tab: Page;
  refOf: (name: string) => string;
  industry: { options?: string[]; value?: string } | undefined;
}> {
  const tab = await browser.newPage();
  await tab.setContent(FORM);
  const snapshot = await tab.ariaSnapshot({ mode: "ai" });
  const { elements } = parseAriaSnapshot(snapshot);
  return {
    tab,
    industry: elements.find((element) => element.name === "Industry"),
    refOf: (name) => {
      const found = elements.find((element) => element.name === name);
      if (!found) throw new Error(`No ${name} in the snapshot.`);
      return found.ref;
    },
  };
}

describe.skipIf(!asked)("entering text in a form", () => {
  test("a dropdown is chosen from by the option's label, and the page sees a change", async () => {
    const { tab, refOf } = await openForm();
    await enterText(
      tab.locator(`aria-ref=${refOf("Industry")}`),
      " logistics ",
      ACTING,
    );
    expect(await tab.locator("select").inputValue()).toBe("logistics");
    expect(await tab.locator("#changes").textContent()).toBe("1");
    await tab.close();
  });

  test("a dropdown falls back to the option's value", async () => {
    const { tab, refOf } = await openForm();
    await enterText(
      tab.locator(`aria-ref=${refOf("Industry")}`),
      "fin",
      ACTING,
    );
    expect(await tab.locator("select").inputValue()).toBe("fin");
    await tab.close();
  });

  test("text that is not an option, or names a disabled one, is refused and changes nothing", async () => {
    const { tab, refOf } = await openForm();
    const industry = tab.locator(`aria-ref=${refOf("Industry")}`);
    for (const text of ["Aerospace", "Retired"]) {
      const refused = await enterText(industry, text, ACTING).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(FieldValueError);
      // Never the text it was sent, never the page's own option labels.
      expect((refused as Error).message).not.toContain(text);
      expect((refused as Error).message).not.toContain("Logistics");
    }
    expect(await tab.locator("select").inputValue()).toBe("");
    expect(await tab.locator("#changes").textContent()).toBe("0");
    await tab.close();
  });

  test("the snapshot the refusal points to lists the dropdown's options and its choice", async () => {
    const { tab, industry } = await openForm();
    expect(industry?.options).toEqual([
      "Select an industry",
      "Financial services",
      "Logistics",
      "Retired",
    ]);
    expect(industry?.value).toBe("Select an industry");
    await tab.close();
  });

  test("a text box is still filled, replacing what was there", async () => {
    const { tab, refOf } = await openForm();
    await enterText(
      tab.locator(`aria-ref=${refOf("Account name")}`),
      "Navia Freight",
      ACTING,
    );
    expect(await tab.locator("input[name=name]").inputValue()).toBe(
      "Navia Freight",
    );
    await tab.close();
  });
});
