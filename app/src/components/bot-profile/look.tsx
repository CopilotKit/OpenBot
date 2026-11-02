import {
  BOT_COLOURS,
  type BotColour,
  namedColour,
  newFace,
  recoloured,
  seedFor,
} from "@openbot/shared/bot-look";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { botColourFor, palette } from "@/components/agents/orb/bot-orb-draw";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { toast } from "@/components/ui/toast";
import { profileUpdateInput } from "@/lib/agents/form";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

/** Each colour as a person would say it. */
const COLOUR_NAMES: Record<BotColour, string> = {
  ember: "Orange",
  moss: "Green",
  sun: "Yellow",
  berry: "Pink",
  ocean: "Blue",
  sky: "Cyan",
  coral: "Red",
  slate: "Grey",
};

const rgb = (colour: readonly number[]) => `rgb(${colour.join(",")})`;

/** A swatch's fill: the colour's sphere in small, pale where the light falls and deep at its rim. */
function swatchFill(colour: BotColour): string {
  const { pale, main, deep } = palette(colour, 1, 0);
  return `radial-gradient(circle at 35% 30%, ${rgb(pale)}, ${rgb(main)} 55%, ${rgb(deep)})`;
}

/** The face part of a seed: all of it, or what follows the colour it names. */
const faceOf = (seed: string) =>
  namedColour(seed) === null ? seed : seed.slice(seed.indexOf(":") + 1);

/** How long the colours wait, after the last one is picked, before the choice is saved. */
export const SAVE_AFTER_MS = 700;

/**
 * How the Bot looks: its face, large and alive, the eight colours and a new face. Drawn only for
 * whoever may edit the Bot, the people who may also rename it.
 *
 * The colours are native radios, so the group is one stop for Tab and the arrow keys move through
 * it, as they do in any radio group. The chosen one carries the stop as its tabindex, which Safari
 * needs to reach a radio by Tab at all. Moving through them only previews: the face shows each colour
 * at once, and the one the person stops on is saved after a short pause, or as soon as focus leaves
 * the group, so browsing restyles the Bot for nobody else and saves it once. New face saves at once.
 * Either can be taken back with Undo, which saves the look from before. One that can't be saved
 * goes back and says so. What changed is said in a polite live region, as "Blue, new face".
 */
export function LookSection({ agent }: { agent: AgentProfile }) {
  const update = useMutation(updateAgentMutationOptions(queryClient));
  // The look just chosen, shown before the server has it. Cleared when the newest choice settles: by
  // then a saved one is the Bot's own seed, since the save refetches the Bot before it resolves.
  const [chosen, setChosen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The look Undo puts back: the one shown before the latest change. Null when there is nothing to undo.
  const [undoTo, setUndoTo] = useState<string | null>(null);
  // What the live region last said. The count lets the same words be said twice.
  const [said, setSaid] = useState({ text: "", count: 0 });
  const newest = useRef(0);
  // The colour waiting out its pause, and the pause itself.
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newFaceButton = useRef<HTMLButtonElement>(null);
  const group = useId();
  const seed = chosen ?? agent.avatarSeed;
  const colour = botColourFor(seed);

  const input = (avatarSeed: string) => ({
    agentId: agent.id,
    input: { ...profileUpdateInput(agent, {}), avatarSeed },
  });
  const say = (text: string) =>
    setSaid((last) => ({ text, count: last.count + 1 }));

  const save = async (next: string, result: string) => {
    const turn = ++newest.current;
    setChosen(next);
    setFailed(false);
    try {
      await update.mutateAsync(input(next));
      if (turn === newest.current) say(result);
    } catch {
      if (turn === newest.current) {
        setFailed(true);
        setUndoTo(null);
      }
    }
    if (turn === newest.current) setChosen(null);
  };

  /** Takes the colour waiting out its pause, if there is one, and stops the pause. */
  const takePending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    return next;
  };

  /** Saves the colour waiting out its pause now. One the Bot already has needs no save. */
  const flush = () => {
    const next = takePending();
    if (next === null) return;
    if (next === agent.avatarSeed && !update.isPending) {
      setChosen(null);
      setUndoTo(null);
      return;
    }
    void save(next, `${COLOUR_NAMES[botColourFor(next)]}, saved`);
  };
  // The pause calls the newest `flush`, which knows the newest Bot.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // A colour still waiting when the section goes away is saved, so leaving the page keeps it.
  const leaving = useRef({ input, update });
  leaving.current = { input, update };
  useEffect(
    () => () => {
      if (timer.current === null || pending.current === null) return;
      clearTimeout(timer.current);
      const { input: of, update: saving } = leaving.current;
      saving.mutateAsync(of(pending.current)).catch(() => {
        toast.add({ title: "Couldn't save that look.", type: "error" });
      });
    },
    [],
  );

  const pick = (option: BotColour) => {
    // The first colour of a run remembers the look before it, for Undo.
    if (timer.current === null) setUndoTo(seed);
    else clearTimeout(timer.current);
    // Back in the Bot's own colour with its own face is the Bot's own seed, not a new spelling of it.
    const next =
      option === botColourFor(agent.avatarSeed) &&
      faceOf(seed) === faceOf(agent.avatarSeed)
        ? agent.avatarSeed
        : recoloured(seed, option);
    ++newest.current;
    pending.current = next;
    setChosen(next);
    setFailed(false);
    timer.current = setTimeout(() => flushRef.current(), SAVE_AFTER_MS);
  };

  const drawNewFace = () => {
    const waiting = takePending() !== null;
    if (!waiting) setUndoTo(seed);
    void save(seedFor(colour, newFace()), `${COLOUR_NAMES[colour]}, new face`);
  };

  const undo = () => {
    if (undoTo === null) return;
    const back = undoTo;
    const waiting = takePending() !== null;
    setUndoTo(null);
    newFaceButton.current?.focus();
    const result = `${COLOUR_NAMES[botColourFor(back)]}, look undone`;
    // A colour that never left its pause was never saved, so there is nothing to take back.
    if (waiting && back === agent.avatarSeed && !update.isPending) {
      ++newest.current;
      setChosen(null);
      say(result);
      return;
    }
    void save(back, result);
  };

  return (
    <PageSection
      description="Pick a colour, or draw a new face. It shows wherever this Bot appears."
      title="Look"
    >
      <PageRows>
        {/* Leaving the row saves a colour still in its pause. Undo and New face are in the row, and
            each takes the waiting colour itself. */}
        <Item
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              flush();
          }}
          size="sm"
        >
          <ItemMedia>
            <AbstractAvatar name={agent.name} seed={seed} size={72} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{COLOUR_NAMES[colour]}</ItemTitle>
            {failed ? (
              <ItemDescription className="text-destructive" role="alert">
                Couldn't save that look, so the last one is back.
              </ItemDescription>
            ) : null}
            <span className="sr-only" role="status">
              <span key={said.count}>{said.text}</span>
            </span>
          </ItemContent>
          <ItemActions>
            {undoTo !== null ? (
              <Button onClick={undo} size="sm" variant="ghost">
                Undo
              </Button>
            ) : null}
            <Button
              onClick={drawNewFace}
              ref={newFaceButton}
              size="sm"
              variant="outline"
            >
              New face
            </Button>
          </ItemActions>
          <ItemFooter className="justify-start">
            <div
              aria-label="Colour"
              className="flex flex-wrap gap-2.5"
              role="radiogroup"
            >
              {BOT_COLOURS.map((option) => (
                <label className="cursor-pointer" key={option}>
                  <input
                    aria-label={COLOUR_NAMES[option]}
                    checked={option === colour}
                    className="peer sr-only"
                    name={group}
                    onChange={() => pick(option)}
                    // Safari's Tab, and the desktop app's on a Mac, passes over a radio unless it
                    // has a tabindex of its own. The chosen colour has one, so the group stays a
                    // single stop, and the arrow keys move through it from there.
                    tabIndex={option === colour ? 0 : -1}
                    type="radio"
                    value={option}
                  />
                  {/* Chosen is a ring, not only a colour; focus is the ring every control here draws. */}
                  <span
                    aria-hidden
                    className="block size-7 rounded-full ring-offset-4 ring-offset-card transition-[outline-color,box-shadow] duration-150 peer-checked:outline-2 peer-checked:outline-foreground peer-checked:outline-offset-2 peer-focus-visible:ring-3 peer-focus-visible:ring-ring"
                    style={{ background: swatchFill(option) }}
                  />
                </label>
              ))}
            </div>
          </ItemFooter>
        </Item>
      </PageRows>
    </PageSection>
  );
}
