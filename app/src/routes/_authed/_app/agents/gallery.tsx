import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { galleryListQueryOptions } from "@/lib/templates/queries";

/**
 * The gallery: the coworkers this deployment ships with, plus any repository an administrator pinned.
 *
 * WHAT IS DELIBERATELY NOT HERE, because every one of them would be a lie this screen has no way to
 * tell the truth about. No search box: three to a few dozen templates fit on a page, and a search
 * over that is furniture. No install count, no download count, no stars, no rating. Nothing in this
 * feature counts anything — there is no service to count on, by design — so any number beside a
 * template would be either invented or supplied by whoever wrote the template, and a number a
 * stranger supplies about their own work while somebody decides whether to trust it is worse than no
 * number at all. Popularity is the single strongest signal a marketplace gives, and it is the one
 * this design refuses to fake.
 *
 * WHAT IS HERE is the author's CLAIM, the summary, and the connectors the template asks for — the
 * three things that let somebody decide whether to open it. The prose a template will feed a model
 * is not on a card; it is on the consent screen, under a heading saying whose words it is.
 *
 * Opening one is a search parameter, matching the roster next door: the list stays behind the panel,
 * Back closes it, and the URL can be handed to the person who actually has to decide.
 */
const gallerySearchSchema = z.object({
  /** The slug being read. The document is fetched by it; nothing about a template travels in a URL. */
  use: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/gallery")({
  validateSearch: gallerySearchSchema,
  component: GalleryRoute,
});

/**
 * The route owns the URL; the screen owns what is drawn.
 *
 * A thin wrapper rather than one component doing both, because `Route.useSearch` and
 * `Route.useNavigate` resolve against this file's generated route id and nothing else. That makes
 * the screen untestable without standing up the app's whole route tree, and this screen has two
 * rules worth a test — that an author's claim is never an anchor, and that a file the gallery could
 * not read is named rather than swallowed. Splitting the URL out costs six lines and the screen
 * becomes an ordinary component with two props.
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

export function TemplateGallery({
  reading,
  onClose,
}: {
  /** The slug being read, or nothing. */
  reading: string | null;
  onClose: () => void;
}) {
  const gallery = useQuery(galleryListQueryOptions());

  const templates = gallery.data?.templates ?? [];
  const shipped = templates.filter((card) => card.origin.kind === "directory");
  const pinned = templates.filter((card) => card.origin.kind === "source");

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
          ) : shipped.length === 0 ? (
            <PageEmpty>This deployment ships no templates.</PageEmpty>
          ) : (
            <TemplateGrid>
              {shipped.map((card, index) => (
                <StaggerItem className="h-full" index={index} key={card.slug}>
                  <TemplateCard card={card} />
                </StaggerItem>
              ))}
            </TemplateGrid>
          )}
        </PageSection>

        {/*
         * The pinned section appears only when there is something in it. A deployment that has
         * registered no source has nothing to say here, and an empty heading reading "From a source
         * an administrator pinned" would suggest a thing is missing rather than that a thing was
         * never asked for. Registering one is an administrator's act on their own screen.
         */}
        {pinned.length > 0 ? (
          <PageSection
            description="Fetched by this server from a repository an administrator registered, at the exact commit they pinned. Your browser never talked to it."
            title="From a pinned source"
          >
            <TemplateGrid>
              {pinned.map((card, index) => (
                <StaggerItem className="h-full" index={index} key={card.slug}>
                  <TemplateCard card={card} />
                </StaggerItem>
              ))}
            </TemplateGrid>
          </PageSection>
        ) : null}

        {/*
         * WHAT COULD NOT BE OFFERED, said out loud rather than left as an absence.
         *
         * A gallery quietly listing three of four templates teaches an operator that the feature is
         * unreliable. One that names the file and the refusal teaches them that one file is wrong,
         * which is a thing somebody can go and fix.
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
 * ellipsis — and the claim is one of the three things somebody reads to decide whether to open the
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
