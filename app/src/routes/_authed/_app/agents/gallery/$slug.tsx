import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Claim,
  STRANGER_WROTE_IT,
  Verbatim,
} from "@/components/agents/template-prose";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { describeBoundary } from "@/lib/templates/boundary";
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
    return (
      <PageShell
        backButton={{
          label: "Templates",
          linkProps: { to: "/agents/gallery" },
        }}
        description="This deployment does not offer a template by that name. It may have been in a source whose pin has since moved."
        title="Not here"
      >
        {null}
      </PageShell>
    );
  }

  const { entry, template, digest, yaml } = detail.data;
  const seed = entry.avatarSeed || entry.slug;
  const ceiling = describeBoundary(template.boundary);

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
       * The drawing and the role, together, because this page is about one coworker rather than about
       * a file. It is the avatar the imported Bot will actually have — the same seed — so the page is
       * a preview of the thing rather than a description of it.
       */}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <AbstractAvatar name={entry.name} seed={seed} size={40} />
        <div className="min-w-0">
          <p className="font-medium text-sm">{entry.title}</p>
          <p className="text-muted-foreground text-xs">
            {entry.runtime === "managed"
              ? "Runs on this deployment's own Bot."
              : "Runs at an address the importer supplies."}
          </p>
        </div>
      </div>

      <PageSection
        description={STRANGER_WROTE_IT}
        title="The instructions it carries"
      >
        {/*
         * FIRST, and that ordering is the argument. What a Bot will be TOLD is a larger fact about it
         * than what it may reach, and a page that led with a capability list would be teaching people
         * to skim the prose on the way to the part that looks like the security-relevant one.
         */}
        <Verbatim>{template.bot.roleDescription}</Verbatim>
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
          <Verbatim>{template.notes}</Verbatim>
        </PageSection>
      ) : null}

      {template.skills.length > 0 ? (
        <PageSection
          description="A skill is an instruction somebody invokes with a slash. It grants nothing: what a Bot may call is its grants, and naming a tool here only narrows what is offered out of what it already holds."
          title={
            template.skills.length === 1
              ? "Its skill"
              : `Its ${template.skills.length} skills`
          }
        >
          <div className="grid gap-5">
            {template.skills.map((skill) => (
              <div className="grid gap-2" key={skill.slug}>
                <div>
                  <p className="font-medium text-sm">{skill.title}</p>
                  <p className="font-mono text-muted-foreground text-xs">
                    /{skill.slug}
                  </p>
                </div>
                <p className="text-muted-foreground text-sm">{skill.summary}</p>
                <Verbatim>{skill.instructions}</Verbatim>
                {skill.tools.length > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    It names {skill.tools.join(", ")}. Naming a tool is not
                    being given it.
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </PageSection>
      ) : null}

      {/*
       * THE ASKS, WITH THE AUTHOR'S OWN REASONS, and resolved against nothing.
       *
       * Whether this deployment has Drive is a question about the deployment, and it is answered on
       * the consent screen where it changes what the button does. Answering it here as well would put
       * a second resolution path in front of a stranger's file, and two paths that must agree are two
       * paths that eventually do not.
       */}
      <PageSection
        description="What the author says this coworker needs. Every line is a request and none of it is a grant: importing writes these to a ledger as asked-for, and somebody decides each one afterwards on the screens that already decide grants."
        title="What it asks for"
      >
        <div className="grid gap-4">
          {template.requests.connectors.map((connector) => (
            <div className="grid gap-1.5" key={connector.id}>
              <p className="font-mono font-medium text-sm">{connector.id}</p>
              <p className="text-muted-foreground text-sm">{connector.why}</p>
              {connector.tools.length > 0 ? (
                <ul className="grid gap-1">
                  {connector.tools.map((tool) => (
                    <li className="text-xs" key={tool.ref}>
                      <span className="font-mono">{tool.ref}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {tool.why}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}

          {template.requests.components.map((component) => (
            <div className="grid gap-1.5" key={component.name}>
              <p className="font-mono font-medium text-sm">{component.name}</p>
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

      <PageSection
        description="The ceiling the author wrote into the file. This deployment compiles it into rules scoped to this one coworker when it is imported, and they only ever subtract from what a Bot may already do."
        title="What it will be allowed to do"
      >
        <ul className="grid gap-1">
          {ceiling.map((sentence) => (
            <li className="text-muted-foreground text-sm" key={sentence}>
              {sentence}
            </li>
          ))}
        </ul>
      </PageSection>

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
        <Verbatim>{yaml}</Verbatim>
      </PageSection>
    </PageShell>
  );
}
