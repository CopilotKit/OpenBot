import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { SkippedToolsNotice } from "@/components/plugins/skipped-tools-notice";

/**
 * A refresh that stored every action but the ones whose names no model could be offered says which
 * it left out, on the app's own page, as a warning. It used to say so only in `lastError`, which the
 * page drew only when the app had no tools at all — so after a partial refresh nobody saw anything.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

test("names every action the refresh left out, as a status and not an alert", () => {
  const view = render(
    <SkippedToolsNotice names={["notion.export", "notion.import"]} />,
  );
  const notice = view.getByRole("status");
  expect(notice.textContent).toContain(
    "2 actions this app lists were left out",
  );
  expect(notice.textContent).toContain("notion.export");
  expect(notice.textContent).toContain("notion.import");
  expect(view.queryByRole("alert")).toBeNull();
});

test("one name is said in the singular", () => {
  const view = render(<SkippedToolsNotice names={["notion.export"]} />);
  expect(view.getByRole("status").textContent).toContain(
    "One action this app lists was left out",
  );
});

test("draws nothing when nothing was left out", () => {
  const view = render(<SkippedToolsNotice names={[]} />);
  expect(view.container.textContent).toBe("");
});
