import { IconBoxSeam, IconPlugConnected } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { ImportTemplate } from "@/components/agents/import-template";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type GalleryTemplateCard,
  galleryListQueryOptions,
} from "@/lib/templates/queries";

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
      <PageShell
        backButton={{ label: "Coworkers", linkProps: { to: "/agents" } }}
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
            <PageRows>
              {shipped.map((card, index) => (
                <StaggerItem index={index} key={card.slug}>
                  <TemplateRow card={card} />
                  {index < shipped.length - 1 ? <Separator /> : null}
                </StaggerItem>
              ))}
            </PageRows>
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
            <PageRows>
              {pinned.map((card, index) => (
                <StaggerItem index={index} key={card.slug}>
                  <TemplateRow card={card} />
                  {index < pinned.length - 1 ? <Separator /> : null}
                </StaggerItem>
              ))}
            </PageRows>
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
 * One template, as much as a card should say.
 *
 * The whole row does not navigate. "Use this template" is a separate control on purpose: the row
 * carries a stranger's name and a stranger's summary, and a card that opened the consent screen
 * anywhere somebody clicked would make reading the card and starting the import the same gesture.
 * They are different decisions and they get different targets.
 */
function TemplateRow({ card }: { card: GalleryTemplateCard }) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconBoxSeam className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="break-words">{card.name}</ItemTitle>
        <ItemDescription className="line-clamp-none break-words">
          {card.summary}
        </ItemDescription>
        {/*
         * THE CLAIM, labelled as one, in the row rather than under the name.
         *
         * `author` and `source` are attacker-controlled strings sitting a centimetre from a Bot's
         * name while somebody decides whether to trust it. Both are rendered as plain text and
         * NEVER as an anchor — an address that is a link is a thing somebody clicks before they
         * have finished reading, and this one has been verified by nobody. `break-all` so a long
         * one wraps rather than pushing the card wide, which would hide the rest of the row.
         */}
        <ItemDescription className="line-clamp-none">
          <span className="text-muted-foreground">Author claim: </span>
          <span className="break-all font-mono text-xs">
            {card.author ?? "not stated"}
          </span>
          {card.source ? (
            <>
              <span className="text-muted-foreground"> · from </span>
              <span className="break-all font-mono text-xs">{card.source}</span>
            </>
          ) : null}
        </ItemDescription>
      </ItemContent>
      {/*
       * The connectors it WANTS, on their own line rather than crammed beside the button. A set
       * belongs in the footer, which is `basis-full`; in `ItemActions` it fights the name for width
       * and wraps badly the moment a template asks for two.
       */}
      {card.connectors.length > 0 ? (
        <ItemFooter className="gap-1.5 text-muted-foreground text-xs">
          <IconPlugConnected className="size-3.5" />
          <span>
            Asks for {card.connectors.join(", ")}. Nothing is granted by
            importing it.
          </span>
        </ItemFooter>
      ) : (
        <ItemFooter className="text-muted-foreground text-xs">
          Asks for no connectors.
        </ItemFooter>
      )}
      <ItemActions>
        <Button
          render={(props) => (
            <Link search={{ use: card.slug }} to="/agents/gallery" {...props} />
          )}
          size="sm"
          variant="outline"
        >
          Use this template
        </Button>
      </ItemActions>
    </Item>
  );
}
