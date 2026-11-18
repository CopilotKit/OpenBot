import { expect, test } from "bun:test";
import { shortTitle } from "@/lib/short-title";

/** A row's title with each web address cut to its site; the words around it stay as they were. */

test("an address reads as its site, without www", () => {
  expect(
    shortTitle(
      "Check the Notion page and linked section at https://app.notion.com/p/copilotkit/Cycle-65-4133aa3818",
    ),
  ).toBe("Check the Notion page and linked section at app.notion.com");
  expect(shortTitle("Read https://www.example.com/a?b=c first")).toBe(
    "Read example.com first",
  );
});

test("the sentence's own punctuation and brackets stay", () => {
  expect(
    shortTitle("See (https://github.com/CopilotKit/OpenBot/releases)."),
  ).toBe("See (github.com).");
  expect(shortTitle("Open https://example.com/page, then reply.")).toBe(
    "Open example.com, then reply.",
  );
});

test("a title with no address, or one that isn't one, is left alone", () => {
  expect(shortTitle("Buenos Aires weather")).toBe("Buenos Aires weather");
  expect(shortTitle("Try http:// later")).toBe("Try http:// later");
});
