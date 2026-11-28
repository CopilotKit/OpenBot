import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Warning } from "./layoutWatch";
import { WarningsList, warningKey } from "./WarningsList";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const warning: Warning = {
  kind: "clipped",
  at: 250,
  label: "Title",
  box: { x: 0, y: 0, width: 10, height: 10 },
  scrollWidth: 20,
  scrollHeight: 10,
};

test("keyboard focus previews the warning and blur ends the preview", async () => {
  const onHover = mock();
  const onLeave = mock();
  render(
    <>
      <WarningsList warnings={[warning]} onHover={onHover} onLeave={onLeave} />
      <button type="button">Next control</button>
    </>,
  );
  const person = userEvent.setup({ document });
  await person.tab();
  expect(onHover).toHaveBeenCalledWith(warning);
  await person.tab();
  expect(onLeave).toHaveBeenCalledTimes(1);
});

test("a warning can be pinned by keyboard and exposes the current pressed state", async () => {
  const onPin = mock();
  const view = render(
    <WarningsList
      warnings={[warning]}
      onPin={onPin}
      highlight={{ key: warningKey(warning), pinned: false }}
    />,
  );
  const row = view.getByRole("button", { name: "Title is cut off" });
  expect(row.getAttribute("aria-pressed")).toBe("false");
  const person = userEvent.setup({ document });
  await person.tab();
  await person.keyboard("{Enter}");
  expect(onPin).toHaveBeenCalledWith(warning);
  view.rerender(
    <WarningsList
      warnings={[warning]}
      onPin={onPin}
      highlight={{ key: warningKey(warning), pinned: true }}
    />,
  );
  expect(row.getAttribute("aria-pressed")).toBe("true");
});
