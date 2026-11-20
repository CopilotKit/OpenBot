import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller";
import { IconArrowDown } from "@tabler/icons-react";
import type * as React from "react";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  tabIndex,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  // The primitive is always a tab stop so the keyboard can scroll it. One with nothing to scroll,
  // like a conversation that has not started, is a stop between the To: field and the composer.
  const scrollable = useMessageScrollerScrollable();
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      tabIndex={tabIndex ?? (scrollable.start || scrollable.end ? 0 : -1)}
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent",
        className,
      )}
      {...props}
    />
  );
}

/**
 * KEEP THE ROOM THE SCROLLER MADE FOR A TURN UNTIL SOMETHING FILLS IT.
 *
 * When a person sends a message, the scroller lifts it to the top of the view and puts a spacer
 * under it, so the reply streams into empty room below the question instead of pushing the
 * conversation up. The scroller gives that room back the moment anything asks it to scroll to the
 * end: it hides the spacer and then scrolls to what is left. A view standing at the end is standing
 * in that room, so the conversation got shorter under it and the browser pulled everything down by
 * the spacer's height in one frame. The reply jumped from the top of the view to sit on the
 * composer. A touch of the trackpad after a reply was enough, because a downward wheel at the end
 * asks for the end (see `follow-intent.tsx`), and so does the scroller's own following once any
 * input has moved it off the anchored turn.
 *
 * So the content keeps the height the room gave it. Whenever the spacer is shown, the content's
 * least height is set to where the room ends; when the scroller hides the spacer, that least height
 * stays. Going to the end then lands exactly where the view already is, and nothing moves. The room
 * is only ever used up by the reply growing into it, or replaced by the room for the next turn,
 * which ends further down.
 *
 * Observed rather than computed, because the spacer is the scroller's: it writes the spacer's
 * height and `hidden` itself, and this only reads them. A mutation observer runs before the next
 * frame is painted, so the least height is in place before anything can scroll to the end.
 *
 * NO ROOM WHILE THE WHOLE CONVERSATION FITS IN THE VIEW. Room is what lets the scroller lift a turn
 * above where it sits, and in a conversation that fits there is nothing to make room for: the reply
 * already has the empty view below the question to grow into. Given the room anyway, the first
 * question was lifted under a Bot's introduction, which went half under the header, and a short
 * answer left the room standing empty below it. So when a turn is lifted while everything fits, its
 * room is held at nothing, decided once for that turn, and the scroller's lift lands where the
 * conversation already is. The scroller lifts the turn again on every resize, and without room that
 * goes only as far as the reply reaches: once the reply outgrows the view, the question rises as the
 * reply needs the space, until it is where the lift would have put it, and from there the reply is
 * followed as after any lift. A conversation already taller than the view gets its room as before.
 */
function holdTheRoom(content: HTMLDivElement): () => void {
  const spacer = content.querySelector<HTMLElement>(
    ":scope > [data-message-scroller-spacer]",
  );
  if (!spacer) return () => {};
  /** The turn the room was last decided for, and whether it gets any. */
  let decided: { turn: Element | null; room: boolean } | null = null;
  const hold = () => {
    if (spacer.hidden) {
      decided = null;
      return;
    }
    const turn = lastAnchor(content);
    if (decided === null || decided.turn !== turn) {
      decided = { turn, room: !fitsInView(content, spacer) };
    }
    if (!decided.room) {
      if (spacer.style.height !== "0px") spacer.style.height = "0px";
      return;
    }
    const end =
      spacer.getBoundingClientRect().bottom -
      content.getBoundingClientRect().top +
      (Number.parseFloat(getComputedStyle(content).paddingBottom) || 0);
    content.style.minHeight = `max(100%, ${end}px)`;
  };
  const observer = new MutationObserver(hold);
  observer.observe(spacer, {
    attributes: true,
    attributeFilter: ["hidden", "style"],
  });
  return () => observer.disconnect();
}

/** The newest row a turn can be lifted to: the scroller lifts the newest one it finds. */
function lastAnchor(content: HTMLElement): Element | null {
  const anchors = content.querySelectorAll(
    ':scope > [data-scroll-anchor="true"]',
  );
  return anchors[anchors.length - 1] ?? null;
}

/** Whether everything in the conversation, without any room, is within the height of the view. */
function fitsInView(content: HTMLElement, spacer: HTMLElement): boolean {
  const viewport = content.parentElement;
  if (!viewport) return false;
  const top = content.getBoundingClientRect().top;
  let bottom = 0;
  for (const child of content.children) {
    if (child === spacer) continue;
    // A `display: contents` block has no box of its own; its children are the rows.
    const boxes =
      getComputedStyle(child).display === "contents" ? child.children : [child];
    for (const box of boxes)
      bottom = Math.max(bottom, box.getBoundingClientRect().bottom - top);
  }
  const end =
    bottom + (Number.parseFloat(getComputedStyle(content).paddingBottom) || 0);
  return end <= viewport.clientHeight + 0.5;
}

function MessageScrollerContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  /*
   * Released on the call with `null`, not by returning a cleanup: the primitive forwards this ref
   * through its own callback, which drops whatever a ref callback returns.
   */
  const release = useRef<(() => void) | null>(null);
  const content = useCallback(
    (element: HTMLDivElement | null) => {
      release.current?.();
      release.current = element ? holdTheRoom(element) : null;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      ref={content}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        // Do not use `content-visibility: auto`: short transcripts can reserve item height without
        // painting the message until a scroll/resize forces it.
        "min-w-0 shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <IconArrowDown />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
};
