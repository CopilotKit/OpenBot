/**
 * A Bot using the person's own computer: the screen, the mouse and the keyboard, through OpenBot
 * Desktop on a Mac. A prototype.
 *
 * The tool is OpenBot's own page's (app/src/lib/copilot/person-computer-tool.tsx), offered only in
 * OpenBot Desktop's window on a Mac. Desktop takes each action, and asks the person once per
 * session of OpenBot before the first (desktop/src-tauri/src/person_computer.rs). Every answer carries the
 * screen after the action. The backend puts the newest few in front of the model as pictures, and
 * leaves the picture's text out of what the model reads.
 */

export const PERSON_COMPUTER_TOOL = "person_computer";

/** The screen after an action: a JPEG in base64, and its size in pixels. */
export type PersonComputerScreen = {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
};

/** What the tool answers: what was done and the screen after it, or why nothing was done. */
export type PersonComputerAnswer =
  | { ok: true; did: string; screen: PersonComputerScreen }
  | { ok: false; reason: string };

/**
 * The screen an answer carries, and the rest of the answer, or undefined when the text is not an
 * answer with a screen.
 */
export function screenOfAnswer(content: string):
  | {
      answer: Record<string, unknown>;
      screen: PersonComputerScreen;
    }
  | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer))
    return undefined;
  const screen = (answer as { screen?: unknown }).screen;
  if (typeof screen !== "object" || screen === null) return undefined;
  const { base64, mimeType, width, height } = screen as Record<string, unknown>;
  if (
    typeof base64 !== "string" ||
    typeof mimeType !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number"
  )
    return undefined;
  return {
    answer: answer as Record<string, unknown>,
    screen: { base64, mimeType, width, height },
  };
}
