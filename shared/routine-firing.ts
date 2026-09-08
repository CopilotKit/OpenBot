/**
 * The sentences that tell a scheduled turn it IS a firing, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the same reason `handoff-markers.ts` gives: the server
 * writes this text into the transcript and the browser has to recognise it again to draw it as a
 * firing rather than as something the person typed. Two copies of a sentence is a contract with two
 * authors, and the first rewording breaks the renderer silently.
 */
export const FIRING_FRAME = [
  "One of your routines is firing right now, on its schedule, and this is that firing.",
  "Carry out the instruction below in this turn: do the work now, then say what happened.",
  "Do not create, list or change any routine unless the instruction itself asks you to.",
] as const;

/** The frame and the blank line under it, which is what `readFiring` strips. */
const PREFIX = [...FIRING_FRAME, "", ""].join("\n");

/**
 * The stored instruction, wrapped in the sentences that tell the turn it IS a firing.
 *
 * FOUND ON A LIVE FIRING, and it recorded `succeeded`. The instruction read "Every run, append the
 * current date and time as a new bulleted list item to the Notion page …" and was sent to the model
 * verbatim as the turn's user message. The model read it as a question about routine MANAGEMENT
 * rather than as work: it called `list_routines`, found a routine that already said exactly that,
 * answered that it was already configured, and appended nothing. Nothing failed, so nothing was
 * reported — a routine telling somebody it is working while doing nothing at all, which is worse
 * than one that breaks.
 *
 * And the model was not being stupid. Instructions are WRITTEN in schedule-speak — "every run",
 * "every 15 minutes", "each morning" — because that is how a person asks for a standing thing, and
 * schedule-shaped prose arriving out of nowhere reads as a request to SET UP a schedule. The most
 * plausible reading of its own routine's text was "check whether this is set up"; it was, so it did
 * nothing, successfully. No wording of the stored instruction fixes that on its own, because the
 * sentence a person writes is the sentence that describes the schedule.
 *
 * So the frame says the three things the instruction cannot say about itself: that this is a
 * scheduled firing happening now, that the work belongs in this turn, and that managing routines is
 * not what was asked. It is PRESENTATION — which is why it lives here and not in the stored row or
 * in the routine runner's signature: the row keeps what the person asked for, and this is how it is
 * put to the model.
 *
 * ONLY THE NEW MESSAGE IS FRAMED, and that matters twice. The framed text is what
 * `persistedInputMessages` writes to the transcript — correctly, since the transcript should show
 * what the turn was actually asked — so it comes back as HISTORY on the next firing. History is
 * converted and seeded exactly as the platform handed it over and nothing re-frames it; a test holds
 * that, because the alternative is a message that grows a fresh paragraph of frame every night.
 *
 * Because the frame reaches the transcript, {@link readFiring} exists to take it off again for the
 * one reader it was never addressed to: the person.
 */
export function frameFiring(instruction: string): string {
  return [...FIRING_FRAME, "", instruction].join("\n");
}

/**
 * The instruction back out of a framed message, or null if this was not one.
 *
 * A prefix match on the whole frame rather than on its first sentence: the frame is three fixed
 * lines and a blank one, and a person quoting one of them into a channel — which is exactly what
 * somebody debugging a routine does — must not have their own message redrawn as a firing.
 */
export function readFiring(text: string): string | null {
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : null;
}
