import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Turn } from "./transcript-turns";

type RailProps = {
  turns: readonly Turn[];
  /** The id of the turn being read. */
  active: string | null;
  onJump: (turn: Turn) => void;
};

function sameTurn(a: Turn, b: Turn): boolean {
  return (
    a.id === b.id &&
    a.index === b.index &&
    a.prompt === b.prompt &&
    a.reply === b.reply
  );
}

/**
 * The transcript re-renders on every streamed chunk and rebuilds its turns each time; the rail
 * redraws only when what it shows has changed, and then only the marks that did.
 */
export function sameRail(a: RailProps, b: RailProps): boolean {
  return (
    a.active === b.active &&
    a.onJump === b.onJump &&
    a.turns.length === b.turns.length &&
    a.turns.every((turn, index) => {
      const other = b.turns[index];
      return other !== undefined && sameTurn(turn, other);
    })
  );
}

/**
 * A rail in the margin beside a conversation: a mark per turn, the one being read drawn longer.
 * Hovering or focusing a mark previews its turn — what the person sent, and the start of the
 * reply — and choosing it goes there.
 *
 * Only where the margin is wide enough to hold it (`@3xl` of the scroller: the transcript's
 * `max-w-2xl` column and a gutter either side), and only once there is more than one turn to move
 * between.
 */
export const TranscriptRail = memo(function TranscriptRail({
  turns,
  active,
  onJump,
}: RailProps) {
  const listRef = useRef<HTMLOListElement | null>(null);

  /* A long conversation's rail scrolls; keep the current mark on it. */
  useEffect(() => {
    if (active === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(active)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (turns.length < 2) return null;

  return (
    <nav
      aria-label="Turns"
      className="pointer-events-none absolute inset-y-0 left-2 z-10 hidden items-center @3xl:flex"
    >
      <ol
        className="pointer-events-auto flex max-h-[min(60vh,32rem)] flex-col overflow-y-auto py-2 [scrollbar-width:none]"
        ref={listRef}
      >
        {turns.map((turn) => (
          <li key={turn.id}>
            <RailMark
              current={turn.id === active}
              onJump={onJump}
              turn={turn}
            />
          </li>
        ))}
      </ol>
    </nav>
  );
}, sameRail);

const RailMark = memo(function RailMark({
  turn,
  current,
  onJump,
}: {
  turn: Turn;
  current: boolean;
  onJump: (turn: Turn) => void;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        aria-current={current ? "true" : undefined}
        aria-label={turn.prompt}
        className="group flex h-3 w-8 cursor-pointer items-center rounded-sm px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-slot="rail-mark"
        data-turn={turn.id}
        delay={0}
        onClick={() => onJump(turn)}
      >
        <span
          className={cn(
            "h-0.5 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none",
            current
              ? "w-4 bg-foreground"
              : "w-2.5 bg-muted-foreground/40 group-hover:w-4 group-hover:bg-muted-foreground group-focus-visible:w-4",
          )}
        />
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align="center"
          className="isolate z-50"
          side="right"
          sideOffset={8}
        >
          <TooltipPrimitive.Popup
            className="w-80 origin-(--transform-origin) rounded-xl border bg-popover p-4 text-popover-foreground shadow-md data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none"
            data-slot="rail-preview"
          >
            <p className="truncate font-medium text-sm">{turn.prompt}</p>
            {turn.reply ? (
              <p className="mt-1 line-clamp-3 text-muted-foreground text-sm">
                {turn.reply}
              </p>
            ) : null}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}, sameMark);

function sameMark(
  a: { turn: Turn; current: boolean; onJump: (turn: Turn) => void },
  b: { turn: Turn; current: boolean; onJump: (turn: Turn) => void },
): boolean {
  return (
    a.current === b.current && a.onJump === b.onJump && sameTurn(a.turn, b.turn)
  );
}
