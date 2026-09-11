import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { RejectedFiles } from "@/components/channels/composer/rejected-files";
import { settleReactWork } from "./settle-react-work";

/**
 * THE GAP UNDER THE REFUSALS HAS TO BE INSIDE THE BOX THAT GETS MEASURED.
 *
 * `Collapse` animates its height to `content.offsetHeight` (`collapse.tsx`), and `offsetHeight` is
 * the border-box height: it includes padding and excludes margins. The content wrapper has no
 * border and no padding of its own, so a bottom margin on the alert inside it collapses straight
 * out of the number `Collapse` measures. The animating box then settles 8px shorter than the space
 * the alert is meant to occupy, and the gap between the refusal block and the composer directly
 * below it is simply not drawn — on the one component here that appears without being asked for,
 * pressed against the box somebody is typing in.
 *
 * `AttachmentStrip` already spends `pb-3` for exactly this reason, on the `ul` inside its own
 * `Collapse`. This is the same bargain, spent on the wrapper `Collapse` measures rather than on the
 * alert, because the alert has a dashed border and padding inside it would land within that border
 * rather than under it.
 *
 * WHY THIS TEST IS STRUCTURAL AND NOT A MEASUREMENT. happy-dom reports `offsetHeight` as 0 for
 * everything and compiles no Tailwind, so the real number cannot be observed from here and neither
 * can a computed style. What CAN be pinned is the property the number depends on: the spacing is
 * spent as padding on the measured element and not as a margin on its child. That is the whole of
 * the defect, and it is a class-name assertion because the alternative is no assertion at all.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const oneRefusal = [
  { id: "1", name: "logo.svg", reason: "SVGs are not accepted." },
];

test("the gap below the refusals is padding on the measured box, not a margin on the alert", () => {
  const { container } = render(
    <RejectedFiles onDismiss={() => {}} rejected={oneRefusal} />,
  );

  const alert = container.querySelector('[role="alert"]') as HTMLElement;
  expect(alert).not.toBeNull();

  /*
   * `Collapse` renders `<div className={className} ref={content}>{children}</div>` inside the
   * animating box, so the alert's parent IS the element whose `offsetHeight` is measured. Reaching
   * for it through the alert rather than by class name is deliberate: the point is that the spacing
   * sits on the measured element, whichever element that turns out to be.
   */
  const measured = alert.parentElement as HTMLElement;
  const measuredClasses = (measured.getAttribute("class") ?? "").split(/\s+/);
  const alertClasses = (alert.getAttribute("class") ?? "").split(/\s+/);

  // Padding, on the box `offsetHeight` is read from — so the gap is part of the height animated to.
  expect(measuredClasses).toContain("pb-2");

  // And not a bottom margin anywhere inside it, which is the spelling that gets measured away.
  expect(alertClasses).not.toContain("mb-2");
  expect(alertClasses.filter((name) => /^-?mb-/.test(name))).toEqual([]);
});
