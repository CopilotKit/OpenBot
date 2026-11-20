import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { IconChevronRight } from "@tabler/icons-react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { cn } from "@/lib/utils";

/** Every framework the New Bot sheet can connect that has a mark to draw, in the sheet's order. */
const MARKED = WEB_HARNESSES.filter((harness) => harness.mark);

/** The three named in the sentence: the ones people look for first, by id so a rename follows. */
const NAMED = ["claude-agent-sdk", "langgraph", "google-adk"]
  .map((id) => MARKED.find((harness) => harness.id === id)?.name)
  .filter((name): name is string => Boolean(name));

/** Two rows, so all of them fit at the width the sheet gives the card. */
const ROWS = [
  MARKED.slice(0, Math.ceil(MARKED.length / 2)),
  MARKED.slice(Math.ceil(MARKED.length / 2)),
];

/**
 * The way into connecting an agent somebody already built, at the bottom of the New Bot sheet's
 * first step. A muted card with every supported framework's mark, so the support is seen before
 * anybody goes looking for it. The whole card is the button.
 */
export function CustomAgentCta({
  disabled,
  onConnect,
}: {
  disabled?: boolean;
  onConnect: () => void;
}) {
  const others = MARKED.length - NAMED.length;
  return (
    <button
      className="flex w-full items-center gap-5 rounded-2xl bg-muted/60 px-5 py-6 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onConnect}
      type="button"
    >
      {/* Hidden on a phone, where the sentence needs the width. */}
      <span aria-hidden="true" className="hidden shrink-0 flex-col sm:flex">
        {ROWS.map((row, index) => (
          <span
            className={cn("flex -space-x-2", index > 0 && "-mt-1.5 ml-4")}
            key={row[0]?.id ?? index}
          >
            {row.map((harness) => (
              <span
                className="grid size-10 place-items-center rounded-full bg-background ring-2 ring-muted"
                key={harness.id}
              >
                <HarnessMark
                  className="size-5"
                  id={harness.mark}
                  name={harness.name}
                />
              </span>
            ))}
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-base tracking-tight">
          Bring your own agent
        </span>
        <span className="mt-1 block text-pretty text-muted-foreground text-sm">
          Connect an agent built with {NAMED.join(", ")} or {others} other
          frameworks.
        </span>
      </span>
      <IconChevronRight
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground"
      />
    </button>
  );
}
