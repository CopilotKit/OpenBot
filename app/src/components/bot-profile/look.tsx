import {
  BOT_COLOURS,
  type BotColour,
  newFace,
  recoloured,
  seedFor,
} from "@openbot/shared/bot-look";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
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
  sky: "Light blue",
  coral: "Coral",
  slate: "Grey",
};

const rgb = (colour: readonly number[]) => `rgb(${colour.join(",")})`;

/** A swatch's fill: the colour's sphere in small, pale where the light falls and deep at its rim. */
function swatchFill(colour: BotColour): string {
  const { pale, main, deep } = palette(colour, 1, 0);
  return `radial-gradient(circle at 35% 30%, ${rgb(pale)}, ${rgb(main)} 55%, ${rgb(deep)})`;
}

/**
 * How the Bot looks: its face, large and alive, the eight colours and a new face. A choice saves when
 * it is made, as Visibility's does, and the face shows it at once; one that can't be saved goes
 * back and says so. Drawn only for whoever may edit the Bot, the people who may also rename it.
 *
 * The colours are native radios, so the group is one stop for Tab and the arrow keys move through
 * it, as they do in any radio group. They stay live while a choice saves, so arrowing through them
 * keeps its place, and the newest choice wins.
 */
export function LookSection({ agent }: { agent: AgentProfile }) {
  const update = useMutation(updateAgentMutationOptions(queryClient));
  // The look just chosen, shown before the server has it. Cleared when the newest choice settles: by
  // then a saved one is the Bot's own seed, since the save refetches the Bot before it resolves.
  const [chosen, setChosen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const newest = useRef(0);
  const group = useId();
  const seed = chosen ?? agent.avatarSeed;
  const colour = botColourFor(seed);

  const choose = async (next: string) => {
    const turn = ++newest.current;
    setChosen(next);
    setFailed(false);
    try {
      await update.mutateAsync({
        agentId: agent.id,
        input: { ...profileUpdateInput(agent, {}), avatarSeed: next },
      });
    } catch {
      if (turn === newest.current) setFailed(true);
    }
    if (turn === newest.current) setChosen(null);
  };

  return (
    <PageSection
      description="Pick a colour, or draw a new face. It shows wherever this Bot appears."
      title="Look"
    >
      <PageRows>
        <Item size="sm">
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
          </ItemContent>
          <ItemActions>
            <Button
              onClick={() => void choose(seedFor(colour, newFace()))}
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
                    onChange={() => void choose(recoloured(seed, option))}
                    type="radio"
                    value={option}
                  />
                  {/* Chosen is a ring, not only a colour; focus is the ring every control here draws. */}
                  <span
                    aria-hidden
                    className="block size-7 rounded-full ring-offset-4 ring-offset-card transition-[outline-color,box-shadow] duration-150 peer-checked:outline-2 peer-checked:outline-foreground peer-checked:outline-offset-2 peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50"
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
