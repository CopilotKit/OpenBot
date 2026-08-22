import { describe, expect, test } from "bun:test";
import { chatCompletionsUrl } from "../src/routing/model";

/**
 * Where the deployment's own model calls go.
 *
 * This existed as `${base}/v1/chat/completions` and the documented value of `OPENAI_BASE_URL`
 * already ends in `/v1`, so every deployment behind a gateway got `/v1/v1/chat/completions` and a
 * 404. Both callers treat a throw as "not sure": the intent router silently routed everything to
 * the default coworker, and tool selection would have silently offered every tool. Neither said
 * anything, which is why the case is pinned here rather than left to a comment.
 */
describe("chatCompletionsUrl", () => {
  test("unset falls back to the public API, with its version", () => {
    expect(chatCompletionsUrl({})).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  test("a gateway documented with /v1 is not given a second one", () => {
    expect(
      chatCompletionsUrl({ OPENAI_BASE_URL: "https://gateway.internal/v1" }),
    ).toBe("https://gateway.internal/v1/chat/completions");
  });

  test("a trailing slash is not a different URL", () => {
    expect(
      chatCompletionsUrl({ OPENAI_BASE_URL: "https://gateway.internal/v1/" }),
    ).toBe("https://gateway.internal/v1/chat/completions");
  });

  test("a host with no version gets one, which is what a bare origin means", () => {
    expect(
      chatCompletionsUrl({ OPENAI_BASE_URL: "http://localhost:4010" }),
    ).toBe("http://localhost:4010/v1/chat/completions");
  });

  test("a version other than 1 is still a version", () => {
    expect(chatCompletionsUrl({ OPENAI_BASE_URL: "https://x.test/v2" })).toBe(
      "https://x.test/v2/chat/completions",
    );
  });

  test("whitespace and empty are the same as unset", () => {
    expect(chatCompletionsUrl({ OPENAI_BASE_URL: "   " })).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl({ OPENAI_BASE_URL: "" })).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  test("a path that merely contains v1 is not a version segment", () => {
    // `/v1beta` is Google's, and it is not the segment this is looking for.
    expect(
      chatCompletionsUrl({ OPENAI_BASE_URL: "https://x.test/v1beta" }),
    ).toBe("https://x.test/v1beta/v1/chat/completions");
  });
});
