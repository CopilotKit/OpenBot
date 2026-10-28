import { expect, test } from "bun:test";
import {
  narrationLanguage,
  speechLanguage,
} from "../src/shared/speech-language";

test("a page's language is used in its canonical form when it is a plain language tag", () => {
  expect(speechLanguage("en")).toBe("en");
  expect(speechLanguage("EN-gb")).toBe("en-GB");
  expect(speechLanguage(" pt_BR ")).toBe("pt-BR");
  expect(speechLanguage("zh-hant-tw")).toBe("zh-Hant-TW");
  expect(speechLanguage("es-419")).toBe("es-419");
});

test("an empty, odd or private tag is not a language the recognizer can take", () => {
  for (const value of [
    "",
    "x-klingon",
    "en-US-u-ca-gregory",
    "english",
    "e",
    42,
    null,
    undefined,
  ])
    expect(speechLanguage(value)).toBeNull();
});

test("the narration's language is the page's, else the browser's, else English", () => {
  expect(narrationLanguage("de-DE", "en-GB")).toBe("de-DE");
  expect(narrationLanguage("", "en-GB")).toBe("en-GB");
  expect(narrationLanguage(null, undefined)).toBe("en-US");
});
