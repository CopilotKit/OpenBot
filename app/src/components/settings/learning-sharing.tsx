import type {
  LearningSharingMode,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import {
  IconCheck,
  IconChevronRight,
  IconListCheck,
  IconLock,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { skillTitle } from "@/lib/learning/display";
import {
  requestSkillSharingMutationOptions,
  setLearnedSkillOpenMutationOptions,
  setLearningSharingModeMutationOptions,
} from "@/lib/learning/mutations";
import { personalLearningQueryOptions } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

/** The three choices, each with the one plain line that says who sees what. */
export const SHARING_CHOICES: {
  mode: LearningSharingMode;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}[] = [
  {
    mode: "closed",
    icon: IconLock,
    title: "Only my Bots",
    description: "Only the Bots you use draw on your skills.",
  },
  {
    mode: "open",
    icon: IconUsersGroup,
    title: "Everyone's Bots",
    description: "Every Bot on OpenBot draws on all of your skills.",
  },
  {
    mode: "choose",
    icon: IconListCheck,
    title: "The skills I choose",
    description:
      "Every Bot draws on the skills you open below; your own Bots use all of them.",
  },
];

/**
 * What the choice says above its rows. While an administrator has not turned on Skill sharing, plainly that, and, when
 * the person chose to share before it was turned off, that their choice is kept for when it is on again.
 */
function choiceSentence(data: PersonalLearningSharing): string {
  if (data.sharingAllowed)
    return "Your own Bots always use every skill learned from your recordings.";
  const off =
    "An admin hasn't turned on sharing skills with every Bot, so only the Bots you use draw on yours.";
  return data.mode === "closed"
    ? off
    : `${off} Your choice below applies again if an admin turns it on.`;
}

/** What the Skills list says when it has none to show. */
function emptySentence(
  data: PersonalLearningSharing,
  mode: LearningSharingMode,
  personal: boolean,
): string {
  if (personal) {
    return data.skills === null
      ? "Couldn't read your Skills from the backend just now. Reload the page to try again."
      : "No skills learned from your recordings and conversations yet. Once there are, they show up here.";
  }
  if (data.unavailable === "off")
    return "An admin has turned off automatic learning, so no skills are learned from your recordings.";
  if (data.skills === null)
    return "Couldn't read your Skills from the backend just now. Your choice above still applies to them.";
  return mode === "choose"
    ? "No Skills learned from your recordings yet. Once there are, each one you open here reaches every Bot."
    : "No Skills learned from your recordings yet. Once there are, they show up here.";
}

/** What the Your Skills section says about who draws on them, in the mode chosen. */
const SKILLS_DESCRIPTION: Record<LearningSharingMode, string> = {
  closed: "Only the Bots you use draw on these skills.",
  open: "Every Bot on OpenBot draws on these skills.",
  choose: "Open a skill to let every Bot on OpenBot use it.",
};

/**
 * Settings, Learning: every recording a person makes goes into their own Learning space, and the Skills learned there
 * reach every Bot they use. Here they choose who else's Bots may draw on them: none (the default), all, or the Skills
 * they open one by one. Each change takes effect when it is made; there is no save. Sharing waits for an administrator
 * (Admin, Automatic learning, Skill sharing): until then nothing can be opened, and what was opened can still be closed.
 */
export function LearningSharing() {
  const sharing = useQuery(personalLearningQueryOptions());
  const setMode = useMutation(
    setLearningSharingModeMutationOptions(queryClient),
  );
  const setOpen = useMutation(setLearnedSkillOpenMutationOptions(queryClient));
  const requestShare = useMutation(
    requestSkillSharingMutationOptions(queryClient),
  );
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const [reading, setReading] = React.useState<string | null>(null);
  // Which edition decides the layout, so nothing draws until it is known. A failed read counts as the team edition.
  if (sharing.isPending || capabilities.isPending) return null;
  const personal = capabilities.data?.edition === "personal";
  if (sharing.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {sharing.error.message}
      </p>
    );
  }
  const data = sharing.data;
  // Shown at once while the save is on its way, as a switch is.
  const mode = (setMode.isPending ? setMode.variables : undefined) ?? data.mode;
  const failure = setMode.error ?? setOpen.error ?? requestShare.error;
  // The dialog shows the title its row did.
  const readingSkill = data.skills?.find((skill) => skill.name === reading);
  const readingTitle = readingSkill
    ? skillTitle(readingSkill.name, readingSkill.description)
    : undefined;

  if (personal) {
    // One person, one computer: nobody to share with, so every row simply opens its Skill.
    const none = data.skills === null || data.skills.length === 0;
    return (
      <PageSection
        title="Your skills"
        // Said only over skills to open: above the empty state it would point at nothing.
        description={none ? undefined : "Open a skill to read what it does."}
      >
        {data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, true)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => (
              <React.Fragment key={skill.name}>
                {index > 0 ? <Separator /> : null}
                <Item
                  size="sm"
                  render={
                    <button
                      onClick={() => setReading(skill.name)}
                      type="button"
                    />
                  }
                >
                  <ItemMedia variant="icon">
                    <IconSparkles />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {skillTitle(skill.name, skill.description)}
                    </ItemTitle>
                    <ItemDescription>{skill.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </React.Fragment>
            ))}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
    );
  }

  return (
    <>
      <PageSection
        title="Who else's Bots use your skills"
        description={choiceSentence(data)}
      >
        <PageRows>
          {/* One pressed button of three, as Admin, Boundaries draws its enforcement choice. */}
          {SHARING_CHOICES.map((choice, index) => (
            <React.Fragment key={choice.mode}>
              {index > 0 ? <Separator /> : null}
              <Item
                size="sm"
                render={
                  <button
                    aria-pressed={mode === choice.mode}
                    disabled={
                      setMode.isPending ||
                      (!data.sharingAllowed && choice.mode !== "closed")
                    }
                    onClick={() => {
                      if (mode !== choice.mode) setMode.mutate(choice.mode);
                    }}
                    type="button"
                  />
                }
              >
                <ItemMedia variant="icon">
                  <choice.icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{choice.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {choice.description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {mode === choice.mode ? (
                    <IconCheck
                      aria-hidden="true"
                      className="size-4 text-foreground"
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
      <PageSection
        title="Your skills"
        description={SKILLS_DESCRIPTION[data.sharingAllowed ? mode : "closed"]}
      >
        {data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, false)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => {
              const open =
                (setOpen.isPending && setOpen.variables?.name === skill.name
                  ? setOpen.variables.open
                  : undefined) ?? skill.open;
              // A skill the person approved reaches other Bots only once an admin approves sharing it.
              const needsAdmin =
                mode !== "closed" &&
                skill.approvedBy === "person" &&
                skill.sharing !== "approved";
              return (
                <React.Fragment key={skill.name}>
                  {index > 0 ? <Separator /> : null}
                  {mode === "choose" || needsAdmin ? (
                    // The row opens the Skill; the Switch sits beside that button, not inside it.
                    <Item size="sm">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setReading(skill.name)}
                        type="button"
                      >
                        <ItemMedia variant="icon">
                          <IconSparkles />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            {skillTitle(skill.name, skill.description)}
                          </ItemTitle>
                          <ItemDescription>
                            {[
                              needsAdmin ||
                              (mode === "choose" &&
                                !(open && data.sharingAllowed))
                                ? "Only your Bots use it."
                                : mode === "choose"
                                  ? "Every Bot may use it."
                                  : null,
                              skill.description,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </ItemDescription>
                        </ItemContent>
                      </button>
                      <ItemActions>
                        {mode === "choose" ? (
                          <>
                            {needsAdmin && skill.sharing === "requested" ? (
                              <span className="text-muted-foreground text-sm">
                                Asked to share
                              </span>
                            ) : null}
                            <Switch
                              aria-label={`Open ${skillTitle(skill.name, skill.description)} to everyone`}
                              checked={open}
                              // An open Skill can always be closed; opening one waits for an admin.
                              disabled={
                                setOpen.isPending ||
                                requestShare.isPending ||
                                (!data.sharingAllowed && !open)
                              }
                              onCheckedChange={(checked) => {
                                if (
                                  checked &&
                                  needsAdmin &&
                                  skill.sharing !== "requested"
                                ) {
                                  // Switching on a skill an admin has yet to approve also asks for that approval.
                                  setOpen
                                    .mutateAsync({
                                      name: skill.name,
                                      open: true,
                                    })
                                    .then(() => requestShare.mutate(skill.name))
                                    .catch(() => {});
                                  return;
                                }
                                setOpen.mutate({
                                  name: skill.name,
                                  open: checked,
                                });
                              }}
                            />
                          </>
                        ) : skill.sharing === "requested" ? (
                          <span className="text-muted-foreground text-sm">
                            Asked to share
                          </span>
                        ) : (
                          <Button
                            disabled={requestShare.isPending}
                            onClick={() => requestShare.mutate(skill.name)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Ask to share
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                  ) : (
                    // No switch here, so the whole row opens the Skill.
                    <Item
                      size="sm"
                      render={
                        <button
                          onClick={() => setReading(skill.name)}
                          type="button"
                        />
                      }
                    >
                      <ItemMedia variant="icon">
                        <IconSparkles />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {skillTitle(skill.name, skill.description)}
                        </ItemTitle>
                        <ItemDescription>{skill.description}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <IconChevronRight className="size-4 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  )}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
    </>
  );
}
