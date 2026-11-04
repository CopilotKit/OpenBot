import { createContext } from "react";

/**
 * Whether the component is being drawn from a tool call that is still streaming.
 *
 * Provided by the conversation's gallery render. Everywhere else a component is drawn (a preview,
 * an admin screen, a test) its arguments are complete, which is the default. A component reads it
 * when something half written should be held in place rather than refused, and only then.
 */
export const GalleryStreamingContext = createContext(false);

/**
 * Whether a call's arguments may still be arriving at all: its row is the newest of a turn that is
 * still running. The SDK's own status cannot say this on its own. It reports `inProgress` for any
 * call with no result, so a call whose run was stopped, or whose page closed before it answered,
 * reloads as `inProgress` for good; held back on that, its last bar stayed muted forever.
 *
 * The transcript provides it per row. Anywhere else nothing is known, and the status decides.
 */
export const ArgumentsArrivingContext = createContext(true);

/**
 * Whether the turn a row belongs to is still running: every row after the person's last message,
 * while the Bot works. Wider than {@link ArgumentsArrivingContext}, which is the newest row alone. A
 * call that runs beside others, a subagent, has its arguments in and no result yet while later rows
 * arrive, and it is still working for as long as its turn is. Outside a transcript, nothing runs.
 */
export const TurnInFlightContext = createContext(false);
