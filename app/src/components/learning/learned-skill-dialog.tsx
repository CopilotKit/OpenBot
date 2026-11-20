import type { LearnedSkillRecording } from "@openbot/shared/learning";
import { IconChevronRight, IconVideo } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useRef } from "react";
import { SkillFiles } from "@/components/learning/skill-files";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { skillTitle } from "@/lib/learning/display";
import {
  type LearnedSkillSource,
  learnedSkillQueryOptions,
} from "@/lib/learning/queries";

/**
 * The person's own recordings a skill was learned from. Each opens Your recordings on Teach a Bot, which lists them
 * without opening a browser (`?recordings`); one the back end no longer has says so and opens nothing.
 */
function LearnedFrom({ recordings }: { recordings: LearnedSkillRecording[] }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="font-medium text-sm">Learned from</h3>
      <div className="grid gap-2">
        {recordings.map((recording) => {
          const row = (
            <>
              <ItemMedia variant="icon">
                <IconVideo />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{recording.title ?? "Untitled recording"}</ItemTitle>
                {!recording.available && (
                  <ItemDescription>No longer available.</ItemDescription>
                )}
              </ItemContent>
            </>
          );
          return (
            <Fragment key={recording.id}>
              {recording.available ? (
                <Item
                  render={<Link search={{ recordings: 1 }} to="/browser" />}
                  size="sm"
                  variant="muted"
                >
                  {row}
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ) : (
                <Item size="sm" variant="muted">
                  {row}
                </Item>
              )}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

/**
 * One learned skill, open while `name` is set: its description, its steps, and the recordings it was learned from.
 * `title` is the title its row showed, so the dialog reads the same; without it the title is made from the name.
 */
export function LearnedSkillDialog({
  source,
  name,
  title,
  onClose,
  footer,
}: {
  source: LearnedSkillSource;
  name: string | null;
  title?: string;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const detail = useQuery({
    ...learnedSkillQueryOptions(source, name ?? ""),
    enabled: name !== null,
  });
  // The dialog animates closed after `name` goes null; keep showing the last skill until it is gone.
  const shown = useRef<{
    name: string | null;
    title: string | undefined;
    skill: typeof detail.data;
  }>({ name, title, skill: detail.data });
  if (name !== null) shown.current = { name, title, skill: detail.data };
  const skill = shown.current.skill;
  const heading =
    shown.current.title ??
    (shown.current.name === null
      ? ""
      : skillTitle(shown.current.name, skill?.description));
  return (
    <Dialog
      onOpenChange={(next) => (next ? undefined : onClose())}
      open={name !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          {skill && <DialogDescription>{skill.description}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.error ? (
            <p className="text-destructive text-sm" role="alert">
              {detail.error.message}
            </p>
          ) : skill ? (
            <>
              <SkillFiles files={skill.files} />
              {skill.recordings && skill.recordings.length > 0 && (
                <LearnedFrom recordings={skill.recordings} />
              )}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          {footer ?? (
            <Button onClick={onClose} size="sm" type="button">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
