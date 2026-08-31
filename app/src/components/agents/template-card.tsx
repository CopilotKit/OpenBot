import {
  IconBoxSeam,
  IconPlugConnected,
  IconSparkles,
  IconTag,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { templateCategoryLabel } from "@/lib/templates/categories";
import type { GalleryTemplateCard } from "@/lib/templates/queries";
import { cn } from "@/lib/utils";

/**
 * A hue for one template, taken from its own seed.
 *
 * The gallery's problem is that every card used the same box icon, so twelve templates were twelve
 * identical rows and the eye had nothing to land on. The avatar solves that — `boring-avatars` draws
 * a different figure per seed — and this washes the same seed across the surface behind it so the
 * card is distinguishable before the drawing itself is legible.
 *
 * Deterministic and content-free. It is a hash of the seed, so the same template is the same colour
 * on every deployment and nothing about the colour means anything: it is not a category, not a
 * status, and not a signal about trust. A colour that meant something would be a colour a template's
 * author could choose, and every value on this card that an author chooses is labelled as a claim.
 */
function hueFor(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

/**
 * One template in the gallery.
 *
 * A CARD RATHER THAN A ROW, which is the one place this feature leaves the layout every other screen
 * uses. `openbot-screen-layout` asks for that to be said out loud: the rest of the product is
 * configuration, where a person reads one line and decides one thing, and rows are right for it. This
 * screen is the only browse surface in OpenBot — somebody is comparing coworkers they have never seen
 * against each other, which is the same reason the audit log is allowed to be a table. A single
 * column of prose-width rows makes that comparison a scroll.
 *
 * WHAT IS DELIBERATELY NOT ON IT. No install count, no downloads, no stars, no rating, no "featured",
 * no price. Every marketplace leans on those and this one cannot honestly draw a single one: nothing
 * in this feature counts anything, there is no service to count on, and a number supplied by whoever
 * wrote the template — about their own template, to somebody deciding whether to trust it — is worse
 * than no number. Popularity is the strongest signal a marketplace gives and it is the one thing here
 * that would have to be invented, so the space it would have taken goes to the author's claim, the
 * summary, and what the template asks for.
 */
export function TemplateCard({ card }: { card: GalleryTemplateCard }) {
  /*
   * The slug when the seed is absent, which a running deployment can be.
   *
   * The app and the API are deployed as one image but not always restarted as one: a browser holding
   * a new bundle against a server that has not rolled yet gets a card with no seed, and reading
   * `.length` off it took the whole gallery down with a stack trace rather than drawing a plainer
   * card. The slug is already on the wire and is already unique per template, so the fallback is a
   * real drawing rather than a placeholder.
   */
  const seed = card.avatarSeed || card.slug;
  const hue = hueFor(seed);
  const category = templateCategoryLabel(card.category);

  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card",
        "transition-colors hover:border-foreground/20",
      )}
    >
      {/*
       * The wash sits under the avatar rather than behind the whole card, so the colour never gets
       * near the prose. Low alpha over `bg-card` rather than a fill, so the same declaration works in
       * both themes: on light it reads as a tint, on dark as a faint glow, and neither needs a second
       * palette to maintain.
       */}
      <div
        className="flex items-end gap-3 px-4 pt-5 pb-4"
        style={{
          backgroundImage: `radial-gradient(90% 120% at 14% 0%, oklch(0.72 0.11 ${hue} / 0.13), transparent 62%)`,
        }}
      >
        <AbstractAvatar name={card.name} seed={seed} size={44} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-base leading-tight">
            {card.name}
          </h3>
          {/* The role, as an eyebrow. It is the coworker's job title, not the template's name. */}
          <p className="truncate text-muted-foreground text-xs">{card.title}</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        {/*
         * Three lines and then a fade. The summary is the author's, the format caps it, and a card
         * that grows to fit one long one makes every card in the row that tall.
         */}
        <p className="line-clamp-3 text-pretty text-muted-foreground text-sm leading-relaxed">
          {card.summary}
        </p>

        <div className="flex flex-col gap-1.5 text-xs">
          {/*
           * THE CLAIM, labelled, and never an anchor.
           *
           * `author` and `source` are strings a stranger typed, sitting a centimetre from a Bot's
           * name while somebody decides whether to trust it. A linked address is a thing people click
           * before they have finished reading, and nothing has verified this one.
           *
           * A `dl` once, and taken back out: the two lines under it are statements rather than
           * label-and-value, so they had `dt`s marked `sr-only` to keep the list valid — which read
           * aloud as "Asks for, Asks for google-drive". A visible sentence that already contains its
           * own label does not need a second one nobody can see.
           */}
          <p className="flex gap-1.5">
            <span className="shrink-0 text-muted-foreground">Author claim</span>
            <span className="min-w-0 truncate font-mono text-[11px] leading-5">
              {card.author ?? "not stated"}
            </span>
          </p>

          {/*
           * The address the author says it came from, and the reason it is here rather than dropped
           * for space: it is the other half of what somebody judges a template by, and a card that
           * shows a name without the place it claims to come from invites the name to be trusted on
           * its own. Truncated because a long one would push the card wide; still never an anchor.
           */}
          {card.source ? (
            <p className="flex gap-1.5">
              <span className="shrink-0 text-muted-foreground">from</span>
              <span className="min-w-0 truncate font-mono text-[11px] leading-5 text-muted-foreground">
                {card.source}
              </span>
            </p>
          ) : null}

          {/*
           * THE CATEGORY, and the reason it is not labelled a claim like the two lines above it.
           *
           * `author` and `source` are free text and could say anything, which is why each is
           * introduced by the word that makes it somebody's assertion. A category is one of nine
           * slugs; the file chose which, and could not have written anything else. There is
           * nothing here for a reader to doubt, so there is nothing to caveat — and a caveat on
           * every line teaches people to skip the ones that matter.
           *
           * Grouped with the other two facts about what the template IS rather than beside the
           * name, where a small coloured word next to a Bot's title reads as a badge and starts
           * competing with the thing somebody came to the card to read. Quiet on purpose: it earns
           * its place by making the filter chips legible on the card, not by being noticed.
           */}
          {category ? (
            <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <IconTag aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{category}</span>
            </p>
          ) : null}

          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            {card.connectors.length > 0 ? (
              <>
                <IconPlugConnected aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">
                  Asks for {card.connectors.join(", ")}
                </span>
              </>
            ) : (
              <>
                <IconBoxSeam aria-hidden className="size-3.5 shrink-0" />
                <span>Asks for no connectors</span>
              </>
            )}
          </p>

          {card.skills.length > 0 ? (
            <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <IconSparkles aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {card.skills.length === 1
                  ? "1 skill"
                  : `${card.skills.length} skills`}
                , which become yours
              </span>
            </p>
          ) : null}
        </div>

        {/*
         * READ IT, and only that. The button that installs is on the template's own page.
         *
         * A card used to open the consent screen directly, which put "let me see what this is" and
         * "I am importing this" behind one gesture — on the one screen in the product whose contents
         * were written by somebody else. Now the card leads to a page where a person can read the
         * whole of a stranger's instructions, close it, and have changed nothing. The extra click is
         * the point rather than a cost.
         */}
        <Button
          className="mt-auto w-full"
          render={(props) => (
            <Link
              params={{ slug: card.slug }}
              to="/agents/gallery/$slug"
              {...props}
            />
          )}
          size="sm"
          variant="outline"
        >
          Read this template
        </Button>

        <p className="text-center text-[11px] text-muted-foreground">
          Nothing is granted by reading it.
        </p>
      </div>
    </article>
  );
}
