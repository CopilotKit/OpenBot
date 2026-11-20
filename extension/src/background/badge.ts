import type { RecorderState } from "../protocol/messages";

/** OpenBot's destructive token. */
const RECORDING_COLOR = "#e7000b";
const MAX_SHOWN = 999;

function badgeText(state: RecorderState): string {
  if (state.phase !== "recording") return "";
  if (state.actions === 0) return "REC";
  return state.actions > MAX_SHOWN ? `${MAX_SHOWN}+` : String(state.actions);
}

/** The toolbar badge: the action count while recording, empty otherwise. */
export async function showBadge(state: RecorderState): Promise<void> {
  const text = badgeText(state);
  if (text)
    await chrome.action.setBadgeBackgroundColor({ color: RECORDING_COLOR });
  await chrome.action.setBadgeText({ text });
}
