import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { HandoffDetails } from "@/lib/copilot/handoff-tool";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("shows attachment names and the number of files without exposing paths", () => {
  const view = render(
    <HandoffDetails
      given={{
        task: "Upload these invoices",
        attachments: [
          { path: "downloads/Invoice-0016.pdf" },
          { path: "private/export/Invoice-0011.pdf" },
        ],
      }}
    />,
  );

  expect(view.getByText("2 files attached")).toBeTruthy();
  expect(view.getByText("Invoice-0016.pdf")).toBeTruthy();
  expect(view.getByText("Invoice-0011.pdf")).toBeTruthy();
  expect(view.container.textContent).not.toContain("downloads/");
  expect(view.container.textContent).not.toContain("private/export/");
});

test("keeps drawing while an attachment path is still streaming", () => {
  const view = render(
    <HandoffDetails
      given={{
        task: "Upload these invoices",
        attachments: [
          { path: "downloads/Invoice-0016.pdf" },
          {} as { path: string },
        ],
      }}
    />,
  );

  expect(view.getByText("1 file attached")).toBeTruthy();
  expect(view.getByText("Invoice-0016.pdf")).toBeTruthy();
});
