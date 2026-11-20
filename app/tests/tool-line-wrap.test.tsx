import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ToolLine } from "@/components/channels/tool-line";

/**
 * A tool line in a phone-width column. A folded run of reads and searches is labelled in full,
 * "Read 1 file, searched for 2 patterns and listed 1 directory", and at 390px that label ran 59px
 * past the column, cut off mid-word. The label wraps instead, and what it was done to, which is
 * already truncated, gives way first. Layout is measured in a browser; this holds the classes that
 * decide it, as `answer-width.test.tsx` does for the column.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const LABEL = "Read 1 file, searched for 2 patterns and listed 1 directory";

test("a long label wraps rather than running past the column, and the detail gives way first", () => {
  for (const children of [undefined, "what came back"]) {
    const view = render(
      <ToolLine detail="ls -la /private/tmp/work" label={LABEL}>
        {children}
      </ToolLine>,
    );
    const label = view.getByText(LABEL);
    const detail = view.getByText("ls -la /private/tmp/work");
    const classes = (element: HTMLElement) => element.className.split(/\s+/);
    // Free to shrink, so its words wrap onto a second line.
    expect(classes(label)).not.toContain("shrink-0");
    expect(classes(label)).toContain("min-w-0");
    // Truncated, and shrunk ahead of the label.
    expect(classes(detail)).toContain("truncate");
    expect(classes(detail)).toContain("shrink-[100]");
    cleanup();
  }
});

/**
 * A refused or failed step's detail is the reason, and the reason has to be read in full. Cut off
 * with an ellipsis, "budget.xlsx can't be sent. Bots c..." told the person on a phone neither why
 * nor what a Bot can send, and every other refusal's reason was cut the same way. So on those rows
 * the detail wraps, under the label when it does not fit beside it; every other row keeps its
 * one-line rhythm, with the detail truncated as before.
 */
const REASON =
  "budget.xlsx can't be sent. Bots can send images (PNG, JPEG, GIF, WebP), PDFs, and text, Markdown, CSV or JSON files.";

test("a refused or failed step's reason wraps in full instead of being cut off", () => {
  for (const state of [{ refused: true }, { failed: true }]) {
    const view = render(
      <ToolLine
        attempted="Send a file"
        detail={REASON}
        label="Sent a file"
        {...state}
      />,
    );
    const detail = view.getByText(REASON);
    const classes = detail.className.split(/\s+/);
    expect(classes).not.toContain("truncate");
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("break-words");
    // The row lets the reason move under the label when it does not fit beside it.
    expect(
      (detail.parentElement as HTMLElement).className.split(/\s+/),
    ).toContain("flex-wrap");
    cleanup();
  }
});

test("a step that went through keeps its one line, with the detail truncated", () => {
  const view = render(<ToolLine detail={REASON} label="Sent a file" />);
  const detail = view.getByText(REASON);
  expect(detail.className.split(/\s+/)).toContain("truncate");
  expect(
    (detail.parentElement as HTMLElement).className.split(/\s+/),
  ).not.toContain("flex-wrap");
});
