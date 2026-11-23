import type * as React from "react";
import { ItemMedia } from "@/components/ui/item";
import { orbName } from "@/lib/orb-palette";
import { useKit } from "@/skins/store";

/**
 * The 44px tile a row on Routines leads with: its icon over its Bot's tile gradient, the one the
 * designers drew for the Bot's orb colour (`--gradient-bot-<name>`, styles.css; UI Kit "colors").
 */
function RoutineTile({
  children,
  seed,
}: {
  children: React.ReactNode;
  seed: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-tile text-foreground [&_svg]:size-5"
      data-orb={orbName(seed)}
      style={{ backgroundImage: `var(--gradient-bot-${orbName(seed)})` }}
    >
      {children}
    </span>
  );
}

/**
 * A row's media on Routines, where a scheduled routine, a goal and a check-in sit in one list: each
 * takes its Bot's tile in the current kit, so the list reads as one kind of thing and a Bot's rows
 * share a colour. Figma draws only the routine's; the goal's and the check-in's follow it until the
 * designers draw theirs (`.pr/voprosy-dizajneram.md`, question 13).
 *
 * The legacy kit, and a row drawn anywhere but Routines (no `seed`), keep the kit's plain icon tile.
 */
export function RoutineMedia({
  children,
  seed,
}: {
  children: React.ReactNode;
  /** The row's Bot's `avatarSeed`. Absent off Routines. */
  seed?: string;
}) {
  const currentKit = useKit() === "current";
  if (currentKit && seed !== undefined)
    return (
      <ItemMedia data-routine-tile="">
        <RoutineTile seed={seed}>{children}</RoutineTile>
      </ItemMedia>
    );
  return <ItemMedia variant="icon">{children}</ItemMedia>;
}
