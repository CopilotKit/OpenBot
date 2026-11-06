import { IconChevronRight, IconFileText, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { grantRoster } from "@/lib/agents/grant-roster";
import { grantSummary } from "@/lib/agents/grant-summary";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * The deployment's skills: named instructions a person invokes with `/` and a Bot follows.
 *
 * Its own screen rather than a tab on Plugins, because a skill is not a connector. It adds no
 * capability at all: it can only ask a Bot to use tools that Bot was already granted, and every one
 * of those calls is still decided, policy-checked and audited. That is why anybody may write one for
 * themselves on their own Skills page, while adding an MCP server stays an administrator's decision.
 *
 * A list of rows that each open the skill's own page (`skill-page.tsx`), as Plugins does for its
 * tools. Each row used to carry a chip for every Bot and a Remove button, so at a few Bots the
 * skill's own name lost the fight for attention. Writing one is its own page too
 * (`new-skill-page.tsx`).
 */
export function SkillsPage() {
  const paths = useManagePaths();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  // In the personal edition this sits under Settings, beside the person's own skills on Capabilities.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";

  const skills = plugins.data?.skills ?? [];
  const newSkill = (size: "lg" | "sm") => (
    <Button
      render={(props) => <Link {...props} {...paths.newSkill()} />}
      size={size}
      variant={size === "lg" ? "default" : "outline"}
    >
      <IconPlus />
      New skill
    </Button>
  );

  return (
    <PageShell
      action={newSkill("lg")}
      description={
        personal
          ? "Write instructions your Bots follow when you pick a skill from the / menu. A skill only uses what a Bot can already do."
          : "Write instructions a Bot follows when someone picks a skill from the / menu. A skill only uses what a Bot can already do, and you choose which Bots offer it."
      }
      title="Skills"
    >
      {/* One section, so no title: the page title already names it. */}
      <PageSection>
        {/* A read that failed says so; `isPending` goes false on it too, and it is not "none". */}
        {plugins.isPending ? null : !plugins.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load skills. Reload the page.
          </p>
        ) : skills.length === 0 ? (
          <PageEmpty
            action={newSkill("sm")}
            icon={IconFileText}
            title="No skills yet"
          >
            {personal
              ? "Write one. Your Bots offer it as soon as you save."
              : "Write one, then choose which Bots offer it."}
          </PageEmpty>
        ) : (
          <PageRows>
            {skills.map((skill, index) => {
              /*
               * Counted over the same Bots the skill's page draws a switch for, so the number here
               * and the switches there always agree. See `grantRoster` for why hidden holders count.
               */
              const bots = grantRoster({
                roster: agents ?? [],
                hidden: hiddenAgents ?? [],
                holders: skill.grantedTo,
              });
              const held = bots.filter((bot) =>
                skill.grantedTo.includes(bot.id),
              ).length;
              return (
                <React.Fragment key={skill.slug}>
                  {/* A real link with no children: children passed to `render` replace the row's own. */}
                  <Item
                    render={<Link {...paths.skill(skill.slug)} />}
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * The name and what it is for. Not the command: the `/` menu finds a skill by
                       * its name, so the command is the skill's key rather than something to read.
                       */}
                      {skill.summary ? (
                        <ItemDescription>{skill.summary}</ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <span className="text-muted-foreground text-xs">
                        {grantSummary(held, bots.length)}
                      </span>
                      <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                  {index !== skills.length - 1 && <Separator />}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
