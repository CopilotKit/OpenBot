import { useEffect, useRef, useState } from "react";
import {
  BOOKING_CALENDAR_ORIGIN,
  type BookingCalendarColors,
  bookingCalendarSrc,
} from "@/lib/openbot-for-business";
import { cn } from "@/lib/utils";

/** The height Calendly's embed instructions give an inline calendar, until it reports its own. */
const DEFAULT_HEIGHT = 700;
/** Below this a reported height is Calendly's page still starting (it reports 2 and 26 px first). */
const MIN_HEIGHT = 320;
/** Above this a reported height is not believed, so a bad message can't stretch the step forever. */
const MAX_HEIGHT = 1400;
/** How long the calendar has to say it is there before the step offers the browser instead. */
export const BOOKING_CALENDAR_TIMEOUT_MS = 20_000;

/**
 * One of the app's colour tokens as six hex digits, read from the page as it is drawn, so a skin
 * or the dark theme is what the calendar gets. Painted to a one-pixel canvas, which turns any CSS
 * colour (the tokens are `oklch`) into sRGB. Undefined where there is no canvas or the colour
 * doesn't parse; the calendar then keeps Calendly's own colours.
 */
function tokenHex(token: string): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (!value) return undefined;
  const context = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  const unset = "#010203";
  context.fillStyle = unset;
  context.fillStyle = value;
  if (context.fillStyle === unset) return undefined;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue]
    .map((channel) => (channel ?? 0).toString(16).padStart(2, "0"))
    .join("");
}

function appColors(): BookingCalendarColors | undefined {
  const background = tokenHex("--card");
  const text = tokenHex("--card-foreground");
  const primary = tokenHex("--primary");
  return background && text && primary
    ? { background, text, primary }
    : undefined;
}

/** What Calendly posts to the window it is embedded in: `{ event: "calendly.…", payload }`. */
type CalendlyMessage = {
  event?: unknown;
  payload?: { height?: unknown };
};

/**
 * The OpenBot for Business calendar, inline, where somebody books a call without leaving the app.
 *
 * A REAL CONTROL, SO A CARD, NOT THE ILLUSTRATION'S PANEL. It has the illustrations' rounded
 * corners and border, but the cards' fill: the muted fill is what says "this is only a picture" on
 * every other step. Calendly draws in the card's colour and the app's text and primary colours.
 *
 * ITS OWN MESSAGES SAY IT LOADED. A frame's `load` fires for an error page too, so the calendar
 * counts as there only once Calendly, from its own origin and this frame, says so. Until then a
 * spinner stands in its place. Offline, an `error` from the frame, or no word from it in
 * {@link BOOKING_CALENDAR_TIMEOUT_MS}, and `onFailed` hands the step back to the plain button. A
 * booking made in it calls `onBooked`. Its height follows what it reports, so it never scrolls
 * inside the step.
 *
 * Links in it that leave Calendly are the Desktop window's business: it opens them in the
 * person's browser. A browser opens them in a new tab.
 */
export function BookingCalendar({
  onFailed,
  onBooked,
}: {
  onFailed: () => void;
  onBooked: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() =>
    bookingCalendarSrc(window.location.host, appColors()),
  );
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const handlers = useRef({ onFailed, onBooked });
  handlers.current = { onFailed, onBooked };

  useEffect(() => {
    if (!navigator.onLine) {
      handlers.current.onFailed();
      return;
    }
    let heard = false;
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== BOOKING_CALENDAR_ORIGIN ||
        !frame.current ||
        event.source !== frame.current.contentWindow
      ) {
        return;
      }
      const message = (event.data ?? {}) as CalendlyMessage;
      if (message.event === "calendly.page_height") {
        const reported = Number.parseFloat(String(message.payload?.height));
        if (Number.isFinite(reported) && reported >= MIN_HEIGHT) {
          heard = true;
          setReady(true);
          setHeight(Math.min(Math.ceil(reported), MAX_HEIGHT));
        }
      } else if (message.event === "calendly.event_type_viewed") {
        heard = true;
        setReady(true);
      } else if (message.event === "calendly.event_scheduled") {
        handlers.current.onBooked();
      }
    };
    window.addEventListener("message", onMessage);
    // React doesn't attach `onError` to an iframe, so the frame's own event is listened to.
    const element = frame.current;
    const onError = () => handlers.current.onFailed();
    element?.addEventListener("error", onError);
    const timer = setTimeout(() => {
      if (!heard) handlers.current.onFailed();
    }, BOOKING_CALENDAR_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      element?.removeEventListener("error", onError);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex w-full min-w-0 justify-center">
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card"
        data-booking-calendar=""
        data-ready={ready ? "" : undefined}
      >
        <iframe
          className={cn(
            "block w-full border-0 transition-opacity motion-reduce:transition-none",
            ready ? "opacity-100" : "opacity-0",
          )}
          ref={frame}
          referrerPolicy="strict-origin-when-cross-origin"
          // Everything a booking needs, and nothing that lets the frame move this window.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          src={src}
          style={{ height }}
          title="Booking calendar"
        />
        {ready ? null : (
          <div
            className="absolute inset-0 grid place-items-center text-muted-foreground"
            role="status"
          >
            <span
              aria-hidden
              className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            />
            <span className="sr-only">Loading the calendar</span>
          </div>
        )}
      </div>
    </div>
  );
}
