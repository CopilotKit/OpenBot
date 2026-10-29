import { createContext } from "react";

/**
 * Whether the component is being drawn from a tool call that is still streaming.
 *
 * Provided by the conversation's gallery render. Everywhere else a component is drawn (a preview,
 * an admin screen, a test) its arguments are complete, which is the default. A component reads it
 * when something half written should be held in place rather than refused, and only then.
 */
export const GalleryStreamingContext = createContext(false);
