import type {
  LearningSharingMode,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import {
  IconCheck,
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
import {
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
    description: "Only the Bots you use draw on your Skills.",
  },
  {
    mode: "open",
    icon: IconUsersGroup,
    title: "Everyone's Bots",
    description: "Every Bot on OpenBot draws on all of your Skills.",
  },
  {
    mode: "choose",
    icon: IconListCheck,
    title: "The Skills I choose",
    description:
      "Every Bot draws on the Skills you open below; your own Bots use all of them.",
  },
];

/**
 * What the choice says above its rows. While an administrator has not turned on Skill sharing, plainly that, and, when
 * the person chose to share before it was turned off, that their choice is kept for when it is on again.
 */
function choiceSentence(data: PersonalLearningSharing): string {
  if (data.sharingAllowed)
    return "Your own Bots always use every Skill learned from your recordings.";
  const off =
    "An admin hasn't turned on sharing Skills with every Bot, so only the Bots you use draw on yours.";
  return data.mode === "closed"
    ? off
    : `${off} Your choice below applies again if an admin turns it on.`;
}

/** What the Skills list says when it has none to show. */
function emptySentence(data: PersonalLearningSharing): string {
  if (data.unavailable === "off")
    return "An admin has turned off Automatic Learning, so no Skills are learned from your recordings.";
  if (data.skills === null)
    return "Couldn't read your Skills from Intelligence just now. Your choice above still applies to them.";
  return "No Skills learned from your recordings yet. Once there are, each one you open here reaches every Bot.";
}

/**
 * Settings, Learning: every recording a person makes goes into their own Learning space, and the Skills learned there
 * reach every Bot they use. Here they choose who else's Bots may draw on them: none (the default), all, or the Skills
 * they open one by one. Each change takes effect when it is made; there is no save. Sharing waits for an administrator
 * (Admin, Enterprise controls, Skill sharing): until then nothing can be opened, and what was opened can still be closed.
 */
export function LearningSharing() {
  const sharing = useQuery(personalLearningQueryOptions());
  const setMode = useMutation(
    setLearningSharingModeMutationOptions(queryClient),
  );
  const setOpen = useMutation(setLearnedSkillOpenMutationOptions(queryClient));
  if (sharing.isPending) return null;
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
  const failure = setMode.error ?? setOpen.error;

  return (
    <>
      <PageSection
        title="Who else's Bots use your Skills"
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
      {mode === "choose" ? (
        <PageSection
          title="Your Skills"
          description="Open a Skill to let every Bot on OpenBot use it."
        >
          {data.skills === null || data.skills.length === 0 ? (
            <PageEmpty>{emptySentence(data)}</PageEmpty>
          ) : (
            <PageRows>
              {data.skills.map((skill, index) => {
                const open =
                  (setOpen.isPending && setOpen.variables?.name === skill.name
                    ? setOpen.variables.open
                    : undefined) ?? skill.open;
                return (
                  <React.Fragment key={skill.name}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconSparkles />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{skill.name}</ItemTitle>
                        <ItemDescription>
                          {open
                            ? "Every Bot may use it."
                            : "Only your Bots use it."}
                          {skill.description ? ` ${skill.description}` : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={`Open ${skill.name} to everyone`}
                          checked={open}
                          // An open Skill can always be closed; opening one waits for an admin.
                          disabled={
                            setOpen.isPending || (!data.sharingAllowed && !open)
                          }
                          onCheckedChange={(checked) =>
                            setOpen.mutate({ name: skill.name, open: checked })
                          }
                        />
                      </ItemActions>
                    </Item>
                  </React.Fragment>
                );
              })}
            </PageRows>
          )}
        </PageSection>
      ) : null}
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
    </>
  );
}
