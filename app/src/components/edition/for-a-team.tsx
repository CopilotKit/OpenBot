import { IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { Trademark } from "@/components/edition/brand-name";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { openTeamFeatures } from "@/components/edition/team-features-dialog";
import { PageEmpty } from "@/components/layout/page-parts";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** The sentence an Admin setting that needs a team shows in the personal edition. */
export const FOR_A_TEAM = "This applies when OpenBot runs for a team.";

/**
 * Where an Admin page or section sets something the personal edition has no use for, it shows
 * this in the personal edition instead of its controls.
 *
 * Admin is in every edition, so the page keeps its place and the one person sees what a team sets
 * there. What it sets either governs other people (who signs in, roles, groups, sharing), needs a
 * computer for each Bot, or is one of the settings the personal edition fixes for its one person
 * (`PERSONAL_ENTERPRISE_SETTINGS` and `PERSONAL_CAPABILITIES` on the server). The server does not
 * read a value saved for any of them, so no control is offered that would save one.
 *
 * `children` is a second sentence, where the person has their own version of the setting
 * somewhere else.
 */
export function ForATeam({ children }: { children?: ReactNode }) {
  return (
    <PageEmpty
      action={
        <Button onClick={openTeamFeatures} size="sm" variant="outline">
          <OpenBotLogo />
          <span>
            Meet OpenBot for Business
            <Trademark />
          </span>
        </Button>
      }
      icon={IconUsersGroup}
      title="For a team"
    >
      {/* A line each, so a short second sentence doesn't wrap into the first. */}
      <span className="block">{FOR_A_TEAM}</span>
      {children ? <span className="block">{children}</span> : null}
    </PageEmpty>
  );
}

/**
 * Which edition this is, for an Admin page that draws something else in the personal edition.
 * `undefined` until the server says, so neither edition's version flashes before the other.
 * A server that could not say is the team edition, as everywhere else.
 */
export function useEdition(): "team" | "personal" | undefined {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  if (capabilities.isPending) return undefined;
  return capabilities.data?.edition ?? "team";
}

/**
 * An Admin page whose every setting needs a team. In the personal edition it draws the page's
 * title and description with {@link ForATeam} under them, and the page itself is never rendered,
 * so nothing asks the server for an API the personal edition does not have.
 */
export function TeamPage({
  title,
  description,
  backButton,
  more,
  children,
}: {
  title: string;
  description: string;
  backButton?: ComponentProps<typeof PageShell>["backButton"];
  /** A second sentence for {@link ForATeam}. */
  more?: ReactNode;
  children: ReactNode;
}) {
  const edition = useEdition();
  if (edition === undefined) return null;
  if (edition === "team") return children;
  return (
    <PageShell backButton={backButton} description={description} title={title}>
      <ForATeam>{more}</ForATeam>
    </PageShell>
  );
}

/** For the team approval pages: where the one person sets their own. */
export function YourOwnApprovals() {
  return (
    <>
      Set your own in{" "}
      <Link className="underline underline-offset-4" to="/settings/approvals">
        Settings → Approvals
      </Link>
      .
    </>
  );
}

/** For Automatic learning: where the one person reviews what OpenBot learns. */
export function YourOwnLearning() {
  return (
    <>
      Review what OpenBot learns on{" "}
      <Link className="underline underline-offset-4" to="/skills">
        Skills
      </Link>
      .
    </>
  );
}
