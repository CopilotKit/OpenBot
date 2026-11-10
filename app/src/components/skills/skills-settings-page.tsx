import {
  IconBook,
  IconChalkboardTeacher,
  IconChevronRight,
  IconDots,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TEACH_A_BOT } from "@/components/browser/browser-nav-item";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { LearningReview } from "@/components/settings/learning-review";
import {
  LearningSharing,
  SkillMark,
} from "@/components/settings/learning-sharing";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { grantRoster } from "@/lib/agents/grant-roster";
import { grantSummary } from "@/lib/agents/grant-summary";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { removeSkillMutationOptions } from "@/lib/plugins/mutations";
import {
  type PluginsPage,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { EditSkill } from "./edit-skill";
import { NewSkill } from "./new-skill";

type Skill = PluginsPage["skills"][number];

/**
 * Settings → Skills: the one page, for every Bot, that answers "what does it know how to do?". It
 * was Capabilities → Skills, the personal edition's Settings → Skills, and Settings → Learning.
 *
 * 1. Your skills: one list of the skills that are yours, each marked with how it was made. Skills
 *    you wrote open the side panel; in the personal edition the skills written for every Bot open
 *    their own page with a switch per Bot (`/settings/skills/$slug`); learned ones open their dialog
 *    and keep the team edition's sharing switches (`LearningSharing`).
 * 2. Workspace skills, team edition only: the admin's, read-only.
 * 3. Waiting for your review: what OpenBot proposes, with Learn now and automatic approval.
 * 4. Teach a Bot: one row to the recording page, where OpenBot can run a browser for you.
 *
 * Writing and editing a skill you own is a search parameter, as it was on Capabilities, so the list
 * stays behind the panel and the form is linkable and closed by Back.
 */
export function SkillsSettingsPage({
  creating,
  editing,
}: {
  creating: boolean;
  /** The slug being edited, or undefined. */
  editing?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const paths = useManagePaths();
  const personal = paths.edition === "personal";
  const plugins = useQuery(pluginsPageQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  const browser = useQuery(browserStateQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = creating;
  const showEdit = !showCreate && editing !== undefined;
  const loaded = !plugins.isPending && !me.isPending;
  const skills = plugins.data?.skills ?? [];
  /*
   * The server has already left out skills this person may not see. Theirs are the ones they own;
   * the ownerless ones are written for every Bot: the admin's in the team edition, and in the
   * personal edition the one person's too.
   */
  const mine = skills.filter((skill) => skill.ownerUserId === me.data?.id);
  const everyBot = skills.filter((skill) => skill.ownerUserId === null);

  const writtenRow = (skill: Skill) => (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconBook />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {skill.title}
          <SkillMark>Written</SkillMark>
        </ItemTitle>
        {/* What it is for, not its command: the `/` menu finds a skill by its name. */}
        {skill.summary ? (
          <ItemDescription>{skill.summary}</ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`More for ${skill.title}`}
                size="icon-sm"
                variant="ghost"
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() =>
                  navigate({
                    to: "/settings/skills",
                    search: { edit: skill.slug },
                  })
                }
              >
                Edit
              </DropdownMenuItem>
              {/* Immediate, with no undo, so it names the skill it deletes. */}
              <DropdownMenuItem
                onClick={() => {
                  setError(null);
                  removeSkill.mutate(skill.slug);
                }}
                variant="destructive"
              >
                Delete {skill.title}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    </Item>
  );

  /** A personal-edition skill written for every Bot: it opens its own page, with a switch per Bot. */
  const everyBotRow = (skill: Skill) => {
    const bots = grantRoster({
      roster: agents ?? [],
      hidden: hiddenAgents ?? [],
      holders: skill.grantedTo,
    });
    const held = bots.filter((bot) => skill.grantedTo.includes(bot.id)).length;
    return (
      // A real link with no children: children passed to `render` replace the row's own.
      <Item render={<Link {...paths.skill(skill.slug)} />} size="sm">
        <ItemMedia variant="icon">
          <IconBook />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {skill.title}
            <SkillMark>Written</SkillMark>
          </ItemTitle>
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
    );
  };

  const written = loaded
    ? [...mine.map(writtenRow), ...(personal ? everyBot.map(everyBotRow) : [])]
    : [];

  return (
    <DetailPanel
      detail={
        showCreate ? (
          <NewSkill />
        ) : editing ? (
          <EditSkill slug={editing} />
        ) : null
      }
      onClose={() => navigate({ to: "/settings/skills", search: {} })}
      open={showCreate || showEdit}
    >
      <PageShell
        className="@container"
        description="Skills are how your Bots do a task your way. Write one, teach a Bot by showing it, or review what OpenBot proposes."
        title="Skills"
      >
        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {loaded && !plugins.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load the skills you wrote. Reload the page.
          </p>
        ) : null}

        <LearningSharing
          action={
            <Button
              render={(props) => (
                <Link {...props} search={{ new: true }} to="/settings/skills" />
              )}
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              New skill
            </Button>
          }
          written={written}
        />

        {/*
         * No menu on these rows: a workspace skill is the admin's, and the person reading this can't
         * edit it, delete it or choose which Bots carry it. Hidden when there are none.
         */}
        {!personal && everyBot.length > 0 ? (
          <PageSection
            description="An admin writes these for everyone and picks which Bots use them."
            title="Workspace skills"
          >
            <PageRows>
              {everyBot.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconBook />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {skill.summary ? (
                        <ItemDescription>{skill.summary}</ItemDescription>
                      ) : null}
                    </ItemContent>
                  </Item>
                  {index !== everyBot.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}

        <LearningReview />

        {/* Only where OpenBot can run a browser for this person, as the sidebar's own link. */}
        {browser.data?.available ? (
          <PageSection title={TEACH_A_BOT}>
            <PageRows>
              <Item render={<Link to="/browser" />} size="sm">
                <ItemMedia variant="icon">
                  <IconChalkboardTeacher />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Record a task</ItemTitle>
                  <ItemDescription>
                    Show a Bot a task once in your browser, and OpenBot turns
                    the steps into a skill.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
          </PageSection>
        ) : null}
      </PageShell>
    </DetailPanel>
  );
}
