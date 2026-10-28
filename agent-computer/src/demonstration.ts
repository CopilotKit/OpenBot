import type { Page } from "playwright";
import {
  describeDemonstrationTarget,
  gestureForRecording,
  safeDemonstrationUrl,
} from "../../shared/demonstration-rules";
import type { InputMessage } from "./screencast";

/** Never reads a field's value, page body, clipboard or image. All text entry is parameterized. */
export async function describeHumanGesture(page: Page, input: InputMessage) {
  const gesture = gestureForRecording(input);
  if (!gesture) return null;
  const point =
    input.type === "mouse" || input.type === "wheel"
      ? { x: input.x, y: input.y }
      : null;
  const target = await page.evaluate(describeDemonstrationTarget, { point });
  return { ...gesture, url: safeDemonstrationUrl(page.url()), target };
}
