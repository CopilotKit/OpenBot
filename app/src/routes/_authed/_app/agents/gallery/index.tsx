import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { z } from "zod";
import { ImportTemplate } from "@/components/agents/import-template";
import { TemplateCard } from "@/components/agents/template-card";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  isTemplateCategory,
  TEMPLATE_CATEGORIES,
  type TemplateCategorySlug,
  templateCategoryLabel,
} from "@/lib/templates/categories";
import {
  galleryListQueryOptions,
  type GalleryTemplateCard,
} from "@/lib/templates/queries";
import { cn } from "@/lib/utils";

/**
 * The gallery: the coworkers this deployment ships with, plus any repository an administrator pinned.
 *
 * WHAT IS DELIBERATELY NOT HERE, because every one of them would be a lie this screen has no way to
 * tell the truth about. No install count, no download count, no stars, no rating. Nothing in this
 * feature counts a template's use — there is no service to count on, by design — so any such number
 * beside a template would be either invented or supplied by whoever wrote the template, and a number
 * a stranger supplies about their own work while somebody decides whether to trust it is worse than
 * no number at all. Popularity is the single strongest signal a marketplace gives, and it is the one
 * this design refuses to fake.
 *
 * THE COUNTS ON THE FILTER CHIPS ARE NOT THAT NUMBER, and the difference is the whole reason they
 * are allowed. "Sales 5" is this browser counting five cards it is holding; it says nothing about
 * use, reaches no service, and no author can raise it except by writing a sixth template. It is a
 * fact about the list on the screen rather than a claim about the world.
 *
 * WHY THERE IS NOW A SEARCH BOX. There was not, and the reason given was that a few dozen templates
 * fit on a page and a search over them is furniture. That held while a deployment shipped three. A
 * catalogue of two dozen and up is a different object: the question stops being "what is here" and
 * becomes "is the thing I need here", and a page that can only be scrolled answers the second one by
 * making somebody read every card. The filtering is over the list already in hand — no request, no
 * server-side ranking, and so nothing that could order a stranger's template above another's.
 *
 * WHAT IS HERE is the author's CLAIM, the summary, the category, and the connectors the template
 * asks for — the things that let somebody decide whether to open it. The prose a template will feed
 * a model is not on a card; it is on the template's own page, under a heading saying whose words it
 * is.
 *
 * Opening one is a search parameter, matching the roster next door: the list stays behind the panel,
 * Back closes it, and the URL can be handed to the person who actually has to decide.
 */
const gallerySearchSchema = z.object({
  /** The slug being read. The document is fetched by it; nothing about a template travels in a URL. */
  use: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/gallery/")({
  validateSearch: gallerySearchSchema,
  component: GalleryRoute,
});

/**
 * The route owns the URL; the screen owns what is drawn.
 *
 * A thin wrapper rather than one component doing both, because `Route.useSearch` and
 * `Route.useNavigate` resolve against this file's generated route id and nothing else. That makes
 * the screen untestable without standing up the app's whole route tree, and this screen has rules
 * worth a test — that an author's claim is never an anchor, that a file the gallery could not read
 * is named rather than swallowed, and that a chip's count is the number of cards pressing it shows.
 * Splitting the URL out costs six lines and the screen becomes an ordinary component with two props.
 */
function GalleryRoute() {
  const { use } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TemplateGallery
      onClose={() => navigate({ search: {} })}
      reading={use ?? null}
    />
  );
}

/** The chip that selects nothing in particular. Not a category, so it can never collide with one. */
const ALL = "all";

/** Where a template with no category the app recognises is counted and filtered. */
const UNCATEGORISED = "uncategorised";

type CategoryFilter = typeof ALL | typeof UNCATEGORISED | TemplateCategorySlug;

type CategoryChip = {
  key: CategoryFilter;
  label: string;
  /** Counted here, from cards this browser is holding. Never read off a template. */
  count: number;
};

/**
 * Which chip a card is counted under.
 *
 * A category the app does not recognise is uncategorised rather than a group of its own. The server
 * refuses an unknown value, so one arriving here means the two halves are different versions — and a
 * chip drawn from a slug this build has no words for would be a chip labelled with somebody else's
 * string, which is the exact thing the closed vocabulary exists to prevent.
 */
function groupOf(card: GalleryTemplateCard): CategoryFilter {
  return isTemplateCategory(card.category) ? card.category : UNCATEGORISED;
}

/**
 * Whether a card answers what somebody typed.
 *
 * Four fields, and `author` and `source` are deliberately not among them. Those two exist to be
 * doubted — they are the evidence somebody weighs after they have found a template — and a search
 * that surfaced a file because its unverified author string contained the word somebody typed would
 * hand the one field nothing has checked a say in what gets seen first.
 */
function describes(card: GalleryTemplateCard, needle: string): boolean {
  const fields = [
    card.name,
    card.title,
    card.summary,
    templateCategoryLabel(card.category),
  ];
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * The chips, in the vocabulary's own order.
 *
 * WHICH CHIPS EXIST IS DECIDED BY THE WHOLE LIST; WHAT THEY COUNT IS DECIDED BY THE SEARCH. Those
 * are two different questions and answering both with the filtered list was the first thing tried.
 * It made the row rearrange itself on every keystroke — chips vanishing as a search narrowed, the
 * ones that remained sliding left under the cursor — which is how somebody presses the wrong filter.
 * So a category that no template anywhere is in gets no chip at all, five of the nine usually being
 * empty on any given deployment; and a category that exists but has nothing left under the current
 * search keeps its place and says 0.
 *
 * COUNTED AFTER THE SEARCH AND BEFORE THE CATEGORY, which is what makes a count a promise rather
 * than a decoration: "Sales 5" always means five cards appear if this is pressed. Counting the whole
 * list regardless of the search would show 5 next to a chip that then drew two, and a number that
 * disagrees with the screen beside it is worse than no number.
 */
function chipsFor(
  templates: GalleryTemplateCard[],
  found: GalleryTemplateCard[],
): CategoryChip[] {
  const present = new Set(templates.map(groupOf));
  const counts = new Map<CategoryFilter, number>();
  for (const card of found) {
    const key = groupOf(card);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const chips: CategoryChip[] = [
    { key: ALL, label: "All", count: found.length },
  ];
  for (const category of TEMPLATE_CATEGORIES) {
    if (!present.has(category.slug)) continue;
    chips.push({
      key: category.slug,
      label: category.label,
      count: counts.get(category.slug) ?? 0,
    });
  }
  if (present.has(UNCATEGORISED)) {
    chips.push({
      key: UNCATEGORISED,
      label: "Uncategorised",
      count: counts.get(UNCATEGORISED) ?? 0,
    });
  }
  return chips;
}

/** What the screen says when the list is fine and the question was not. */
function describeEmpty(term: string, label: string | null): string {
  if (term && label) return `No template matches “${term}” in ${label}.`;
  if (term) return `No template matches “${term}”.`;
  if (label) return `No template is in ${label}.`;
  return "No template here.";
}

export function TemplateGallery({
  reading,
  onClose,
}: {
  /** The slug being read, or nothing. */
  reading: string | null;
  onClose: () => void;
}) {
  const gallery = useQuery(galleryListQueryOptions());
  const searchId = useId();
  /*
   * Component state rather than a search parameter. `use` is in the URL because it names a decision
   * somebody may need to hand to a colleague; how far down a list a person has narrowed to reach a
   * template is not that, and putting it in the URL would put a keystroke in the history stack.
   */
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>(ALL);

  const templates = gallery.data?.templates ?? [];
  const term = search.trim();
  const needle = term.toLowerCase();
  const found = needle
    ? templates.filter((card) => describes(card, needle))
    : templates;
  const chips = chipsFor(templates, found);
  const shown =
    category === ALL
      ? found
      : found.filter((card) => groupOf(card) === category);

  /*
   * The unfiltered shipped list as well as the filtered one. "This deployment ships no templates" is
   * a fact about the deployment, and a filter that hid every card must not be allowed to say it.
   */
  const inTheBox = templates.filter((card) => card.origin.kind === "directory");
  const shippedShown = shown.filter((card) => card.origin.kind === "directory");
  const pinnedShown = shown.filter((card) => card.origin.kind === "source");

  const activeLabel =
    category === ALL
      ? null
      : category === UNCATEGORISED
        ? "Uncategorised"
        : templateCategoryLabel(category);
  const clearBrowse = () => {
    setSearch("");
    setCategory(ALL);
  };

  const listed = !(gallery.isPending || gallery.error);
  const nothingMatches = listed && templates.length > 0 && shown.length === 0;
  /*
   * A chip row over one group offers no choice, so it is not drawn. The test is the whole list
   * rather than the search's results, so the row does not appear and disappear as somebody types.
   */
  const showChips = chips.length > 2;
  /*
   * An origin section disappears when a filter empties it, rather than standing as an empty heading.
   * The two sections are a PROVENANCE fact — code on this disk, against a repository somebody pinned
   * — which is a different question from what job a coworker does, so filtering narrows within them
   * rather than replacing them. A heading with nothing under it says a thing is missing; a heading
   * that is gone says this cut of the catalogue has none of that kind.
   */
  const shippedHidden = inTheBox.length > 0 && shippedShown.length === 0;

  return (
    <DetailPanel
      /*
       * The same width the roster gives the consent screen, and for the same reason: it renders a
       * stranger's instructions verbatim, and prose reflowed into a 400px column is prose people
       * skim — the one behaviour this whole flow exists to discourage.
       */
      detailWidth={reading ? 560 : undefined}
      detail={reading ? <ImportTemplate gallerySlug={reading} /> : null}
      onClose={onClose}
      open={Boolean(reading)}
    >
      {/*
       * WIDER THAN EVERY OTHER SCREEN, and `openbot-screen-layout` asks for that to be justified.
       *
       * Prose width is right for configuration, where a person reads one line and decides one thing.
       * This is the only browse surface in the product: somebody is comparing coworkers they have
       * never seen against each other, and at prose width that comparison is a scroll. It is the same
       * exception the audit log takes for the same reason — a surface for scanning rather than
       * reading gets the width scanning needs.
       */}
      <PageShell
        backButton={{ label: "Coworkers", linkProps: { to: "/agents" } }}
        width="wide"
        description="Coworkers somebody has already configured, as files. Nothing here is connected to anything: a template is prose and a list of asks, and what it can actually reach is decided afterwards, by somebody, on the screens that already decide it."
        title="Templates"
      >
        {/*
         * The controls appear whenever there is anything to browse, at three templates as at thirty.
         * No threshold, because a search field that materialises on the twelfth template is a control
         * nobody knows to look for and an administrator has no way to predict.
         */}
        {listed && templates.length > 0 ? (
          <PageSection>
            <div className="flex flex-col gap-3">
              <div>
                {/*
                 * Hidden, not absent. The placeholder disappears the moment somebody types, so a
                 * field whose only name is its placeholder is a field with no name for anyone who
                 * comes back to it — and none at all for a screen reader.
                 */}
                <Label className="sr-only" htmlFor={searchId}>
                  Search templates
                </Label>
                <InputGroup>
                  <InputGroupAddon>
                    <IconSearch aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    autoComplete="off"
                    id={searchId}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search by name, role, summary or category"
                    /*
                     * A text field rather than `type="search"`: the browser's own cancel button
                     * would sit beside this one, and two controls that clear the same field is one
                     * too many.
                     */
                    type="text"
                    value={search}
                  />
                  {search ? (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton onClick={() => setSearch("")}>
                        Clear
                      </InputGroupButton>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
              </div>

              {showChips ? (
                /*
                 * A `fieldset`, so the row is one named group rather than a run of loose buttons —
                 * a screen reader announcing "Sales 5, button" with nothing around it does not say
                 * what pressing it would do.
                 */
                /*
                 * `min-w-0` because a `fieldset` carries `min-inline-size: min-content` from the
                 * browser's own stylesheet, which Tailwind's reset does not touch: without it the
                 * row refuses to narrow past its widest chip and pushes the page sideways on a
                 * phone.
                 */
                <fieldset className="flex min-w-0 flex-wrap gap-1.5">
                  <legend className="sr-only">Filter by category</legend>
                  {chips.map((chip) => (
                    <Button
                      aria-pressed={category === chip.key}
                      className={cn(
                        category === chip.key &&
                          "border-foreground/25 bg-foreground/5 text-foreground",
                      )}
                      /*
                       * A chip the current search has emptied refuses rather than disappearing: it
                       * would draw nothing, and a control that promises a cut of the catalogue that
                       * is not there sends somebody to an empty page to find that out. Never `All`,
                       * which is how the search is escaped, and never the chip already selected,
                       * which would disable the control that is causing the emptiness.
                       */
                      disabled={
                        chip.count === 0 &&
                        chip.key !== ALL &&
                        category !== chip.key
                      }
                      key={chip.key}
                      onClick={() => setCategory(chip.key)}
                      size="sm"
                      variant="outline"
                    >
                      {chip.label}
                      <span className="tabular-nums text-muted-foreground">
                        {chip.count}
                      </span>
                    </Button>
                  ))}
                </fieldset>
              ) : null}
            </div>
          </PageSection>
        ) : null}

        {nothingMatches ? (
          /*
           * WHAT WAS ASKED FOR, said back. A screen that answers a search with a blank space leaves
           * somebody wondering whether the list failed to load, and the fix is one sentence naming
           * the words that produced the emptiness and one control that undoes them.
           */
          <PageSection>
            <PageEmpty>{describeEmpty(term, activeLabel)}</PageEmpty>
            <Button
              className="mt-3"
              onClick={clearBrowse}
              size="sm"
              variant="outline"
            >
              {term && activeLabel
                ? "Clear the search and the filter"
                : term
                  ? "Clear the search"
                  : "Show all categories"}
            </Button>
          </PageSection>
        ) : (
          <>
            {shippedHidden ? null : (
              <PageSection
                description="Shipped with this deployment. They are on the disk this app is running from and nothing was fetched to show them."
                title="In the box"
              >
                {/*
                 * Nothing while the read is in flight. The empty sentence below states that this
                 * deployment ships no templates, which is a claim the screen has not earned yet.
                 */}
                {gallery.isPending ? null : gallery.error ? (
                  <p className="mt-2 text-destructive text-sm" role="alert">
                    The template gallery could not be read.
                  </p>
                ) : inTheBox.length === 0 ? (
                  <PageEmpty>This deployment ships no templates.</PageEmpty>
                ) : (
                  <TemplateGrid>
                    {shippedShown.map((card, index) => (
                      <StaggerItem
                        className="h-full"
                        index={index}
                        key={card.slug}
                      >
                        <TemplateCard card={card} />
                      </StaggerItem>
                    ))}
                  </TemplateGrid>
                )}
              </PageSection>
            )}

            {/*
             * The pinned section appears only when there is something in it. A deployment that has
             * registered no source has nothing to say here, and an empty heading reading "From a
             * source an administrator pinned" would suggest a thing is missing rather than that a
             * thing was never asked for. Registering one is an administrator's act on their own
             * screen.
             */}
            {pinnedShown.length > 0 ? (
              <PageSection
                description="Fetched by this server from a repository an administrator registered, at the exact commit they pinned. Your browser never talked to it."
                title="From a pinned source"
              >
                <TemplateGrid>
                  {pinnedShown.map((card, index) => (
                    <StaggerItem
                      className="h-full"
                      index={index}
                      key={card.slug}
                    >
                      <TemplateCard card={card} />
                    </StaggerItem>
                  ))}
                </TemplateGrid>
              </PageSection>
            ) : null}
          </>
        )}

        {/*
         * WHAT COULD NOT BE OFFERED, said out loud rather than left as an absence.
         *
         * A gallery quietly listing three of four templates teaches an operator that the feature is
         * unreliable. One that names the file and the refusal teaches them that one file is wrong,
         * which is a thing somebody can go and fix.
         *
         * Never filtered. A skip is a fact about a file that could not be read, so it has no name,
         * no summary and no category to match on — hiding it behind a search would mean the one
         * thing an operator has to fix disappears as soon as anybody starts looking for something.
         */}
        {gallery.data && gallery.data.skipped.length > 0 ? (
          <PageSection
            description="These were not offered. Each is a fact about the file rather than about this deployment."
            title="Not listed"
          >
            <PageRows>
              {gallery.data.skipped.map((skip, index) => (
                <div key={`${skip.where}:${skip.reason}:${skip.message}`}>
                  <Item size="sm">
                    <ItemContent>
                      {/* Plain text. A filename and a refusal are both somebody else's strings. */}
                      <ItemTitle className="break-all font-mono text-xs">
                        {skip.where}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {skip.message}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  {index < gallery.data.skipped.length - 1 ? (
                    <Separator />
                  ) : null}
                </div>
              ))}
            </PageRows>
          </PageSection>
        ) : null}

        {/*
         * Said once, at the bottom, where somebody who has read the list is deciding what to do
         * next. It is the same sentence the consent screen opens with, and it is repeated here
         * because the decision starts on this page.
         */}
        <p className="mt-8 text-muted-foreground text-xs">
          Every author name and address on this page was typed by whoever wrote
          the template. Nothing verified any of it, and nothing on this
          deployment treats it as more than a claim.
          {gallery.data?.installers === "admin"
            ? " Installing a template here is an administrator's act."
            : null}
        </p>
      </PageShell>
    </DetailPanel>
  );
}

/**
 * The grid the cards sit in.
 *
 * Two columns from `sm` and no more, even at the wide shell's 960px. Three would put each card near
 * 300px, which truncates the summary to a line and a half and turns the author's claim into an
 * ellipsis — and the claim is one of the things somebody reads to decide whether to open the
 * template at all. A gallery of this size is read, not swept.
 */
function TemplateGrid({ children }: { children: React.ReactNode }) {
  /*
   * `items-stretch` and `h-full` all the way down, or the cards in a row end at different heights.
   *
   * A grid stretches its items by default, but each card is wrapped in the stagger's `motion.div`,
   * and a wrapper that does not pass the height on leaves the card sized to its own content. Two
   * cards side by side with different summaries then finish at different points and the row reads as
   * a mistake rather than as a pair.
   */
  return (
    <div className="grid items-stretch gap-3 sm:grid-cols-2">{children}</div>
  );
}
