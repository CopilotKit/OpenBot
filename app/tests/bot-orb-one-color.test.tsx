import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { BotLookProvider } from "../src/components/agents/bot-look";
import { ORB_IMAGES } from "../src/components/agents/orb-images";
import { ChannelItemContent } from "../src/components/app-sidebar/channel-item-content";
import { BotProfileHeader } from "../src/components/bot-profile/profile";
import { ConversationIntro } from "../src/components/channels/conversation-intro";
import { agentListQueryOptions } from "../src/lib/agents/queries";
import { deploymentKeys } from "../src/lib/deployment/queries";
import { ORB_PALETTES, orbPalette } from "../src/lib/orb-palette";

/**
 * A Bot's orb is one color wherever it is drawn: in the sidebar, at the top of its own page and at
 * the top of a conversation with it.
 *
 * Seen on Windows with the Personal Assistant: its orb was green in the sidebar, the Bots list and
 * the command menu, and blue, teal and pink at the top of its page and of its conversation. Both
 * came from the same palette, drawn two ways, and a person read them as two Bots. This test then
 * measured the drawn color in a real browser.
 *
 * An orb is now one picture, the designers' sphere for its palette (Figma's "Orbs"), at every size.
 * One color everywhere is then the same picture everywhere, which the markup says without a
 * browser: each place's orb, for each of the eight palettes, is the picture of that Bot's palette.
 */

/** One Bot for each of the eight palettes, the Personal Assistant's first. */
const BOTS = ORB_PALETTES.map((palette, index) => {
  const seed =
    index === 0
      ? "personal-assistant"
      : Array.from({ length: 400 }, (_, n) => `bot-${n}`).find(
          (candidate) => orbPalette(candidate) === palette,
        );
  if (!seed || orbPalette(seed) !== palette)
    throw new Error(`no seed for palette ${index}`);
  return {
    id: seed,
    name: `Bot ${index}`,
    title: "Everyday life",
    roleDescription: "Help with email, your calendar and everyday errands.",
    avatarSeed: seed,
    visibility: "private" as const,
  };
});

type Bot = (typeof BOTS)[number];

/** Where a Bot's orb is drawn, as each place draws it. */
const SURFACES = {
  "the sidebar": (bot: Bot) => (
    <ChannelItemContent
      emphasis="agent"
      name={bot.name}
      participantIds={[bot.id]}
      title="Multiplying 17 by 23"
    />
  ),
  "its page": (bot: Bot) => <BotProfileHeader agent={bot} />,
  "its conversation": (bot: Bot) => <ConversationIntro agent={bot} />,
};

function markup(): string {
  const client = new QueryClient();
  client.setQueryData(agentListQueryOptions().queryKey, BOTS as never);
  client.setQueryData(deploymentKeys.capabilities(), { edition: "personal" });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {/* OpenBot's own look, where Bots are orbs. */}
      <BotLookProvider value="orb">
        <div>
          {BOTS.map((bot) =>
            Object.entries(SURFACES).map(([surface, draw]) => (
              <div data-bot={bot.id} data-surface={surface} key={surface}>
                {draw(bot)}
              </div>
            )),
          )}
        </div>
      </BotLookProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("each Bot's orb is its palette's picture in the sidebar, on its page and in its conversation", () => {
  document.body.innerHTML = markup();
  const drawn = BOTS.map((bot) =>
    Object.keys(SURFACES).map((surface) => {
      const orb = document.querySelector<HTMLElement>(
        `[data-bot="${bot.id}"][data-surface="${surface}"] [role="img"][data-variant]`,
      );
      return `${bot.name} on ${surface}: ${/url\("?([^")]+)"?\)/.exec(orb?.style.backgroundImage ?? "")?.[1]}`;
    }),
  );
  expect(drawn).toEqual(
    BOTS.map((bot, index) =>
      Object.keys(SURFACES).map(
        (surface) => `${bot.name} on ${surface}: ${ORB_IMAGES[index]}`,
      ),
    ),
  );
});
