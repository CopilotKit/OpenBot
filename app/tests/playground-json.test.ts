import { describe, expect, test } from "bun:test";
import {
  parseJsonObject,
  validatePlaygroundDraft,
} from "../src/routes/_authed/admin/playground";

const draft = {
  slug: "s8_visual_check",
  title: "S8 visual check",
  description: "A draft with explicit JSON editor state.",
  html: "<div></div>",
  css: "",
  jsFunctions: "",
  argumentSchema: '{ "type": "object" }',
  sampleArguments: '{ "title": "Saved exactly" }',
};

describe("playground JSON editors", () => {
  test("reject malformed JSON instead of producing an empty object payload", () => {
    const result = validatePlaygroundDraft({ ...draft, sampleArguments: "{" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields.sampleArguments).toContain(
        "Sample arguments must be valid JSON",
      );
    }
  });

  test.each(["[]", "null", '"text"'])(
    "rejects %p because the editors must contain objects",
    (raw) => {
      const result = parseJsonObject(raw, "Sample arguments");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("must be a JSON object");
      }
    },
  );

  test("preserves typed object JSON in the save payload", () => {
    const result = validatePlaygroundDraft(draft);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.argumentSchema).toEqual({ type: "object" });
      expect(result.input.sampleArguments).toEqual({ title: "Saved exactly" });
    }
  });
});
