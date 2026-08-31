import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  IconChevronRight,
  IconPlugConnected,
  IconSparkles,
  IconTag,
} from "@tabler/icons-react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  CeilingGrid,
  ConnectorAsk,
  Glance,
  hueFor,
  SkillCard,
} from "@/components/agents/template-anatomy";
import {
  Claim,
  STRANGER_WROTE_IT,
  Verbatim,
} from "@/components/agents/template-prose";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { ClientError } from "@/lib/client";
import { describeBoundary } from "@/lib/templates/boundary";
import { templateCategoryLabel } from "@/lib/templates/categories";
import { galleryTemplateQueryOptions } from "@/lib/templates/queries";

/**
 * One template, read rather than decided.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CONSENT SCREEN. Until now the only way to read what a template
 * would tell a model was to open the import flow, which put "let me see what this is" and "I am
 * installing this" behind the same button. That is the wrong shape for the one screen in the product
 * whose content was written by somebody else: a person should be able to study a stranger's
 * instructions at length, close the page, and have changed nothing.
 *
 * So the two surfaces answer two different questions, and neither answers the other's. THIS page
 * shows the template AS WRITTEN — the prose, the skills, the asks with the author's reasons, the
 * ceiling, and the file itself. It resolves nothing against this deployment and it has no state. The
 * CONSENT SCREEN shows what would happen HERE — which connector exists, which slug is taken, whether
 * an address is needed — and carries the only button that writes anything.
 *
 * The prose is rendered through the same components the consent screen uses, deliberately. Verbatim,
 * unabridged and unformatted is a security property rather than a style, and a second implementation
 * of it is a second place for one of those three to be quietly lost.
 */
export const Route = createFileRoute("/_authed/_app/agents/gallery/$slug")({
  component: TemplateDetailRoute,
});

/**
 * The route reads the URL; the screen takes the slug.
 *
 * Split for the same reason `ImportTemplate` is: `Route.useParams` is bound to the generated route
 * tree, so a component that calls it can only be rendered by the real router. A screen that takes
 * its slug can be rendered on its own, which is what lets a test assert the properties on this page
 * that are security properties rather than styling — that the prose is unabridged, and that no
 * address on it is a link.
 */
function TemplateDetailRoute() {
  const { slug } = Route.useParams();
  return <TemplateDetail slug={slug} />;
}

export function TemplateDetail({ slug }: { slug: string }) {
  const detail = useQuery(galleryTemplateQueryOptions(slug));

  if (detail.isPending) {
    return (
      <PageShell
        backButton={{
          label: "Templates",
          linkProps: { to: "/agents/gallery" },
        }}
        description="Reading the file."
        title="Template"
      >
        {null}
      </PageShell>
    );
  }

  if (detail.error || !detail.data) {
    /*
     * TWO DIFFERENT FACTS, and they were being reported as one.
     *
     * A 404 is about the name in the URL: this deployment offers no template by it. Anything else —
     * a 500, an expired session, a dropped connection, the catalogue throwing — is about the
     * deployment, and saying "does not offer a template by that name" for those sends somebody off
     * to check a slug that was never the problem, on the screen where they were about to decide
     * whether to trust a file.
     */
    const missing =
      detail.error instanceof ClientError && detail.error.status === 404;
    return (
      <PageShell
        backButton={{
          label: "Templates",
          linkProps: { to: "/agents/gallery" },
        }}
        description={
          missing
            ? "This deployment does not offer a template by that name. It may have been in a source whose pin has since moved."
            : "This deployment could not be asked for that template just now. Nothing has changed, and nothing was installed."
        }
        title={missing ? "Not here" : "Could not read it"}
      >
        {null}
      </PageShell>
    );
  }

  const { entry, template, digest, yaml } = detail.data;
  const seed = entry.avatarSeed || entry.slug;
  const hue = hueFor(seed);
  const ceiling = describeBoundary(template.boundary);
  const categoryLabel = entry.category
    ? (templateCategoryLabel(entry.category) ?? "Not filed")
    : "Not filed";

  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link
              search={{ use: entry.slug }}
              to="/agents/gallery"
              {...props}
            />
          )}
          size="lg"
        >
          Use this template
        </Button>
      }
      backButton={{ label: "Templates", linkProps: { to: "/agents/gallery" } }}
      description={entry.summary}
      title={entry.name}
    >
      {/*
       * WHO THIS COWORKER IS, given the weight the rest of the page borrows from.
       *
       * A person arriving here is deciding whether this is the right template at all, and the four
       * facts that answer it — the drawing, the job title, where it runs, and what it brings — were
       * previously a thin strip indistinguishable from the sections under it. It is one block now,
       * with the identity and the three counts inside a single bordered card, so the top of the page
       * reads as a description of a coworker rather than as the first of nine equal sections.
       *
       * `mt-8` because `PageShell`'s header supplies no bottom margin and this is the first child:
       * without it the card sits flush against the summary, and the tiles sat flush against the card.
       * Every gap here is deliberate rather than inherited.
       */}
      <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
        <div
          className="flex items-center gap-4 px-5 py-5"
          style={{
            backgroundImage: `radial-gradient(80% 140% at 10% 0%, oklch(0.72 0.11 ${hue} / 0.13), transparent 60%)`,
          }}
        >
          <AbstractAvatar name={entry.name} seed={seed} size={56} />
          <div className="min-w-0">
            <p className="font-semibold text-base leading-tight">
              {entry.title}
            </p>
            {/*
             * One sentence for both ways a deployment honours `runtime: managed` — on the managed
             * Bot it runs, or in its own process — because from here the difference is invisible and
             * ought to be. A card carries no plan, so it knows what the file asked for and not what
             * this deployment would do about it; the consent screen has the plan and says which of
             * the two it will be.
             */}
            <p className="mt-0.5 text-muted-foreground text-sm">
              {entry.runtime === "managed"
                ? "Runs on this deployment itself."
                : "Runs at an address the importer supplies."}
            </p>
          </div>
        </div>

        {/*
         * THE THREE QUESTIONS SOMEBODY ARRIVES WITH, answered before any prose starts.
         *
         * Everything below this card is a stranger's words and deserves to be read slowly. This is
         * not: it is the format's own structured fields, and a person deciding whether this template
         * is even the right one should not have to read four screens of instructions to learn that
         * it asks for two connectors and brings three skills.
         */}
        <div className="grid gap-px border-border border-t bg-border sm:grid-cols-3">
          <Glance
            icon={<IconSparkles className="size-4" />}
            label="Skills it brings"
            value={
              template.skills.length === 1
                ? "1 skill"
                : `${template.skills.length} skills`
            }
          />
          <Glance
            icon={<IconPlugConnected className="size-4" />}
            label="Connectors it asks for"
            value={
              template.requests.connectors.length === 0
                ? "None"
                : template.requests.connectors
                    .map((connector) => connector.id)
                    .join(", ")
            }
          />
          <Glance
            icon={<IconTag className="size-4" />}
            label="Kind of work"
            value={categoryLabel}
          />
        </div>
      </div>

      <PageSection
        description="The ceiling the author wrote into the file. This deployment compiles it into rules scoped to this one coworker when it is imported, and they only ever subtract from what a Bot may already do."
        title="What it will be allowed to do"
      >
        <div className="grid gap-3">
          <CeilingGrid boundary={template.boundary} />
          {/*
           * The sentences stay, and they are the authority. `describeBoundary` is shared with the
           * consent screen and the Boundaries screen precisely so one ceiling is never described
           * two ways, and the grid above is an index over the same object rather than a second
           * wording — it compresses, it does not paraphrase.
           */}
          <ul className="grid gap-1">
            {ceiling.map((sentence) => (
              <li className="text-muted-foreground text-sm" key={sentence}>
                {sentence}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>
      <PageSection
        description="What the author says this coworker needs. Every line is a request and none of it is a grant: importing writes these to a ledger as asked-for, and somebody decides each one afterwards on the screens that already decide grants."
        title="What it can reach"
      >
        <div className="grid gap-2">
          {template.requests.connectors.map((connector) => (
            <ConnectorAsk
              id={connector.id}
              key={connector.id}
              tools={connector.tools}
              why={connector.why}
            />
          ))}

          {template.requests.components.map((component) => (
            <div
              className="grid gap-1.5 rounded-lg border border-border bg-card p-3"
              key={component.name}
            >
              <p className="font-medium font-mono text-sm">{component.name}</p>
              <p className="text-muted-foreground text-sm">{component.why}</p>
            </div>
          ))}

          {template.requests.connectors.length === 0 &&
          template.requests.components.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              It asks for nothing. This coworker works with what every Bot here
              already has.
            </p>
          ) : null}
        </div>
      </PageSection>
      {template.skills.length > 0 ? (
        <PageSection
          description="A skill is an instruction somebody invokes with a slash. It grants nothing: what a Bot may call is its grants, and naming a tool here only narrows what is offered out of what it already holds."
          title={
            template.skills.length === 1
              ? "Its skill"
              : `Its ${template.skills.length} skills`
          }
        >
          <div className="grid gap-2">
            {template.skills.map((skill) => (
              <SkillCard
                instructions={skill.instructions}
                key={skill.slug}
                slug={skill.slug}
                summary={skill.summary}
                title={skill.title}
                tools={skill.tools}
              />
            ))}
          </div>
        </PageSection>
      ) : null}
      <PageSection
        description={STRANGER_WROTE_IT}
        title="The instructions it carries"
      >
        {/*
         * AFTER THE CAPABILITIES, WHICH REVERSES WHAT THIS PAGE USED TO ARGUE, deliberately.
         *
         * The old ordering put this first on the grounds that what a Bot will be TOLD is a larger
         * fact than what it may reach. That holds for somebody who has already chosen this template
         * and is now reading it closely. It does not hold for the far commoner arrival: somebody
         * deciding whether this is the right template at all, for whom four screens of a stranger's
         * prose stood between them and the two facts that answer it in a glance.
         *
         * Nothing is hidden by the change and nothing is skimmed past — the capability sections
         * above are short and structured, and this text is still whole, still verbatim, and still
         * the substance of the page rather than an appendix to it.
         */}
        <Verbatim capped={false}>{template.bot.roleDescription}</Verbatim>
      </PageSection>
      {/*
       * SETUP, ABOVE THE SKILLS RATHER THAN AT THE BOTTOM.
       *
       * This is the author's note to whoever imports it, and for anything beyond a simple coworker it
       * is the part that decides whether the thing works on arrival: which folder to point it at,
       * which connector to grant, what has to exist first. At the foot of a long page it was read
       * after the decision it was meant to inform. It is not given to a model, which is the one thing
       * about it worth saying out loud, because everything above it is.
       */}
      {template.notes ? (
        <PageSection
          description="From the author, to whoever imports it. This one is not given to a model."
          title="Setup and notes"
        >
          <Verbatim capped={false}>{template.notes}</Verbatim>
        </PageSection>
      ) : null}
      <PageSection
        description="Where this came from, as far as anything here can tell. The author and the address are the author's own words and nothing has checked either."
        title="Provenance"
      >
        <div className="grid gap-1.5">
          <Claim label="Author claim" value={entry.author ?? "not stated"} />
          {entry.source ? <Claim label="from" value={entry.source} /> : null}
          {entry.version ? (
            <Claim label="Version claim" value={entry.version} />
          ) : null}
          {entry.license ? (
            <Claim label="License claim" value={entry.license} />
          ) : null}
          {/*
           * The digest is the one value on this page nobody typed. It is computed here from the
           * parsed document, it is what the install re-checks, and it is how somebody can tell that
           * the file they read is the file that ran.
           */}
          <Claim label="Digest, computed here" value={digest} />
          <Claim
            label="Offered by"
            value={
              entry.origin.kind === "directory"
                ? `this image, ${entry.origin.filename}`
                : `${entry.origin.sourceId} at ${entry.origin.sha}, ${entry.origin.path}`
            }
          />
        </div>
      </PageSection>
      {/*
       * THE FILE ITSELF, last and in full.
       *
       * Everything above is this document read back to somebody a section at a time, which is easier
       * but is also an interpretation. The strongest thing this page can offer a reviewer is the
       * bytes: a template is fifty lines on purpose, and "read it before you install it" is only
       * honest advice if there is somewhere to read it. Serialised on the server from the document it
       * parsed, so it is the file as accepted rather than the file as posted.
       */}
      <PageSection
        description="Serialised from the document this deployment parsed. It is what the consent screen would show you, and what you could have been handed by any other means."
        title="The file"
      >
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            <IconChevronRight
              aria-hidden
              className="size-4 transition-transform group-open:rotate-90"
            />
            Show the file
          </summary>
          <div className="mt-2">
            <Verbatim capped={false}>{yaml}</Verbatim>
          </div>
        </details>
      </PageSection>
    </PageShell>
  );
}
