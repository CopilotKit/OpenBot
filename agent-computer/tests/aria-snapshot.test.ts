import { describe, expect, test } from "bun:test";
import { parseAriaSnapshot, parseDescriptor } from "../src/aria-snapshot";

/**
 * The parser, tested against captured Playwright output.
 *
 * The fixture below is copied from `ariaSnapshot({ mode: "ai" })` against httpbin's form in the
 * container, after filling one field and ticking two boxes. Captured output matters because the real
 * shape includes nested wrappers and quoted text that plausible hand-written YAML can miss.
 *
 * Note what the real output shows that a plausible guess did not: flags come in any order
 * (`[checked] [active] [ref=e19]`, with ref last), Playwright quotes any value containing a colon, and
 * the tree nests several levels through `generic` and `paragraph` wrappers that carry refs of their own.
 */
const CAPTURED = `- generic [ref=e2]:
  - paragraph [ref=e3]:
    - generic [ref=e4]:
      - text: "Customer name:"
      - textbox "Customer name:" [ref=e5]: Katherine Johnson
  - paragraph [ref=e6]:
    - generic [ref=e7]:
      - text: "Telephone:"
      - textbox "Telephone:" [ref=e8]
  - group "Pizza Size" [ref=e12]:
    - paragraph [ref=e14]:
      - generic [ref=e15]:
        - radio "Small" [ref=e16]
        - text: Small
    - paragraph [ref=e17]:
      - generic [ref=e18]:
        - radio "Medium" [checked] [active] [ref=e19]
        - text: Medium
  - group "Pizza Toppings" [ref=e23]:
    - paragraph [ref=e25]:
      - generic [ref=e26]:
        - checkbox "Bacon" [ref=e27]
        - text: Bacon
    - paragraph [ref=e28]:
      - generic [ref=e29]:
        - checkbox "Extra Cheese" [checked] [ref=e30]
        - text: Extra Cheese
  - button "Submit order" [ref=e44]`;

describe("parseAriaSnapshot, against captured output", () => {
  test("the fixture is genuinely valid YAML", () => {
    // The guard against the mistake that made this rewrite necessary: an invented fixture will most
    // likely fail here first.
    expect(() => Bun.YAML.parse(CAPTURED)).not.toThrow();
  });

  test("keeps the controls and drops the scaffolding", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    // `generic`, `paragraph`, `group` and `text` all carry refs but are not things a Bot can act on,
    // and a list full of them is what makes a model pick the wrong element.
    expect(elements.map((e) => e.role)).toEqual([
      "textbox",
      "textbox",
      "radio",
      "radio",
      "checkbox",
      "checkbox",
      "button",
    ]);
  });

  test("finds controls nested several levels deep", () => {
    const names = parseAriaSnapshot(CAPTURED).elements.map((e) => e.name);
    // The radios live under group > paragraph > generic. A parser reading only the top level would
    // return two textboxes and call that the page.
    expect(names).toContain("Small");
    expect(names).toContain("Extra Cheese");
  });

  test("reads ref, role and accessible name", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    expect(elements[0]).toMatchObject({
      ref: "e5",
      role: "textbox",
      name: "Customer name:",
    });
    expect(elements.at(-1)).toMatchObject({
      ref: "e44",
      role: "button",
      name: "Submit order",
    });
  });

  test("reads a control's value, and omits it when empty", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    expect(elements[0]?.value).toBe("Katherine Johnson");
    expect(elements[1]?.value).toBeUndefined();
  });

  test("reports checked AND unchecked for things that can be checked", () => {
    const byName = new Map(
      parseAriaSnapshot(CAPTURED).elements.map((e) => [e.name, e]),
    );
    expect(byName.get("Medium")?.checked).toBe(true);
    expect(byName.get("Extra Cheese")?.checked).toBe(true);
    // Playwright emits nothing for an unchecked control; false is inferred so a Bot can see the state
    // rather than assuming it.
    expect(byName.get("Small")?.checked).toBe(false);
    expect(byName.get("Bacon")?.checked).toBe(false);
    // A button cannot be checked, so the field is absent rather than false.
    expect(byName.get("Submit order")).not.toHaveProperty("checked");
  });

  test("empty and unparseable input produce no elements rather than throwing", () => {
    expect(parseAriaSnapshot("").elements).toEqual([]);
    expect(parseAriaSnapshot("\t- [[[ not yaml").elements).toEqual([]);
    expect(parseAriaSnapshot("").truncated).toBe(false);
  });

  test("the element list is bounded, and says when it was cut", () => {
    const many = Array.from(
      { length: 250 },
      (_, index) => `- button "B${index}" [ref=e${index}]`,
    ).join("\n");
    const { elements, truncated } = parseAriaSnapshot(many);
    expect(elements).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe("values a real parser handles and a pattern got wrong", () => {
  test("a quoted numeric value is not left with its quotes", () => {
    // Numeric-looking text remains a string, so one-time codes are not coerced.
    const { elements } = parseAriaSnapshot(
      '- textbox "Code" [ref=e1]: "123456"',
    );
    expect(elements[0]?.value).toBe("123456");
  });

  test("a value containing a colon survives", () => {
    const { elements } = parseAriaSnapshot(
      '- textbox "Homepage" [ref=e1]: "https://example.com:8443/path"',
    );
    expect(elements[0]?.value).toBe("https://example.com:8443/path");
  });

  test("an escaped quote inside a value survives", () => {
    const { elements } = parseAriaSnapshot(
      '- textbox "Note" [ref=e1]: "she said \\"yes\\""',
    );
    expect(elements[0]?.value).toBe('she said "yes"');
  });

  /**
   * Playwright quotes a value only when it has to, so the ones a Bot most often needs to read back
   * arrive bare: a telephone number, a postcode, an order reference.
   */
  test.each([
    ["555-0142", "a telephone number keeps both groups"],
    ["90210-1234", "a postcode keeps its extension"],
    ["0142-555", "a reference keeps its leading zero"],
    ["007", "a padded number keeps its padding"],
    ["2026-08-16", "a date stays the text on the page"],
    ["20:30", "a time is not read as a number"],
    ["1.2.3", "a version is not read as a number"],
    ["true", "a field holding a word is that word"],
  ])("an unquoted %s survives: %s", (written) => {
    const { elements } = parseAriaSnapshot(
      `- textbox "Field" [ref=e1]: ${written}`,
    );
    expect(elements[0]?.value).toBe(written);
  });
});

describe("parseDescriptor", () => {
  test("flags are read in any order, including ref last", () => {
    // Exactly what the captured output does: `[checked] [active] [ref=e19]`.
    const descriptor = parseDescriptor(
      'radio "Medium" [checked] [active] [ref=e19]',
    );
    expect(descriptor?.role).toBe("radio");
    expect(descriptor?.name).toBe("Medium");
    expect(descriptor?.flags.get("ref")).toBe("e19");
    expect(descriptor?.flags.has("checked")).toBe(true);
  });

  test("an escaped quote inside a name is unescaped", () => {
    const descriptor = parseDescriptor(
      'button "Delete \\"draft\\" now" [ref=e2]',
    );
    expect(descriptor?.name).toBe('Delete "draft" now');
  });

  test("a bracket inside the name is not mistaken for a flag", () => {
    // The reason this is scanned rather than matched: the parts can contain each other.
    const descriptor = parseDescriptor('button "Save [draft]" [ref=e3]');
    expect(descriptor?.name).toBe("Save [draft]");
    expect(descriptor?.flags.get("ref")).toBe("e3");
  });

  test("an unnamed control still parses", () => {
    const descriptor = parseDescriptor("button [ref=e1]");
    expect(descriptor).toMatchObject({ role: "button", name: "" });
    expect(descriptor?.flags.get("ref")).toBe("e1");
  });

  test("junk yields nothing rather than a half-built descriptor", () => {
    expect(parseDescriptor("")).toBeNull();
    expect(parseDescriptor("   ")).toBeNull();
  });
});
