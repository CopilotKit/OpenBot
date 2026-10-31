import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { DictationSurface } from "@/components/channels/composer/dictation-controls";

/**
 * The surface the message box sits in must not translate while nobody is dictating.
 *
 * Any `translate` other than `none`, including `translate-y-0`'s `0px`, makes it the containing block
 * for `position: fixed` descendants. The @ menu is placed at the caret in viewport coordinates, so
 * with a translate here it was drawn that far again from the composer's corner, off the screen. The
 * layout itself can't be measured here, so the class list is the assertion.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** The utilities that apply in every state, without a variant such as `motion-reduce:`. */
function plainClasses(element: Element): string[] {
  return element.className.split(/\s+/).filter((name) => !name.includes(":"));
}

test("at rest the message box's surface names no translate, so the @ menu stays at the caret", () => {
  const view = render(
    <DictationSurface canSend={false} dictation={{ busy: false } as never}>
      <span>message box</span>
    </DictationSurface>,
  );
  const surface = view.getByText("message box").parentElement;
  if (!surface) throw new Error("surface missing");
  expect(
    plainClasses(surface).filter((name) => /^-?translate-/.test(name)),
  ).toEqual([]);
});
