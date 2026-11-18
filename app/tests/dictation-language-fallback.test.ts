import { expect, test } from "bun:test";
import type { Recognition } from "@/lib/browser/narration";
import {
  dictationLanguages,
  LiveDictation,
  type LiveSource,
  type LiveState,
  liveProblem,
  MOST_LANGUAGES,
} from "@/lib/dictation/live";

/**
 * FOUND IN DOGFOODING. OpenBot Desktop on a Mac set to English (United Kingdom), with Hebrew second
 * and the region Israel, and Dictation on for English (United Kingdom) and English (United States),
 * said "This computer can't take dictation in your language." Its speech.log had one line,
 * `available(en-GB) = Unavailable`: the Mac's recognizer has no English (United Kingdom) on the
 * device, and OpenBot never asked for English (United States). Dictation now takes the first of the
 * person's languages, and their common regions, the recognizer has, and when it has none says which
 * language and where to add it.
 */

type Asked = { langs: string[]; processLocally: true };

/** A desktop recognizer that has only `has` on the device, recording what it is asked. */
function fakeRecognition(has: (language: string) => string) {
  const asked: string[] = [];
  const made: (Recognition & { refused?: string[] })[] = [];
  class Fake implements Recognition {
    static async available({ langs }: Asked) {
      asked.push(langs[0] ?? "");
      return has(langs[0] ?? "");
    }
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart: Recognition["onstart"] = null;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    constructor() {
      made.push(this);
    }
    start() {}
    stop() {}
    abort() {}
  }
  const source: LiveSource = { Recognition: Fake, platform: "mac" };
  return { source, asked, made };
}

function dictation(source: LiveSource, languages: string[]) {
  const states: LiveState[] = [];
  const live = new LiveDictation({
    source: () => source,
    languages: () => languages,
    onStart: () => {},
    onText: () => {},
    wait: async () => {},
  });
  live.subscribe(() => states.push(live.getSnapshot()));
  return { live, states };
}

test("a Mac without English (United Kingdom) on the device dictates in English (United States)", async () => {
  const { source, asked, made } = fakeRecognition((language) =>
    language === "en-US" ? "available" : "unavailable",
  );
  const { live, states } = dictation(
    source,
    dictationLanguages("en-GB", ["en-GB", "he-IL"]),
  );
  await live.start();
  expect(made).toHaveLength(1);
  expect(made[0]?.lang).toBe("en-US");
  expect(made[0]?.refused).toEqual(["en-GB", "he-IL"]);
  expect(asked).toEqual(["en-GB", "he-IL", "en-US"]);
  expect(live.getSnapshot()).toEqual({ phase: "listening" });
  expect(states.some((state) => state.phase === "error")).toBe(false);
});

test("the permission wait still holds for the language that is on the device", async () => {
  let answered = 0;
  const { source, asked, made } = fakeRecognition((language) => {
    if (language !== "en-US") return "unavailable";
    return answered++ < 2 ? "downloading" : "available";
  });
  const { live, states } = dictation(source, dictationLanguages("en-GB"));
  await live.start();
  expect(made[0]?.lang).toBe("en-US");
  expect(asked).toEqual(["en-GB", "en-US", "en-US", "en-US"]);
  expect(states.map((state) => state.phase)).toEqual([
    "preparing",
    "listening",
  ]);
});

test("with no language on the device, it names the person's language and where to add it, and starts nothing", async () => {
  const { source, asked, made } = fakeRecognition(() => "unavailable");
  const { live } = dictation(source, dictationLanguages("en-GB", ["en-GB"]));
  await live.start();
  expect(made).toEqual([]);
  // Every candidate once, then it stops.
  expect(asked).toEqual(["en-GB", "en-US", "en"]);
  expect(live.getSnapshot()).toEqual({
    phase: "error",
    error:
      "This Mac can't take dictation in English (United Kingdom). Turn on Dictation and add the language in System Settings, under Keyboard, then try again.",
  });
});

test("on Windows and in a browser it points to the right place", () => {
  expect(liveProblem("language-not-supported", "windows", "en-GB")).toBe(
    "This computer can't take dictation in English (United Kingdom). Add the language in Settings, under Time & language > Speech, then try again.",
  );
  expect(liveProblem("language-not-supported", "browser", "he-IL")).toBe(
    "This browser can't take dictation in Hebrew (Israel).",
  );
});

test("the languages tried: the person's, then their languages' common regions, once each and bounded", () => {
  expect(dictationLanguages("en-GB", ["en-GB", "he-IL"])).toEqual([
    "en-GB",
    "he-IL",
    "en-US",
    "en",
    "he",
  ]);
  expect(dictationLanguages("pt_br")).toEqual(["pt-BR", "pt-PT", "pt"]);
  expect(dictationLanguages("de-AT", ["de-AT"])).toEqual([
    "de-AT",
    "de-DE",
    "de",
  ]);
  expect(dictationLanguages("not a language", [])).toEqual(["en-US"]);
  expect(dictationLanguages(undefined)).toEqual(["en-US"]);
  const many = dictationLanguages("en-GB", [
    "fr-FR",
    "de-DE",
    "es-ES",
    "it-IT",
    "ja-JP",
    "ko-KR",
    "nl-NL",
    "sv-SE",
    "pl-PL",
    "tr-TR",
  ]);
  expect(many).toHaveLength(MOST_LANGUAGES);
  expect(many[0]).toBe("en-GB");
});
