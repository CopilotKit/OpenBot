import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef } from "react";
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
  type LearnedSkillSource,
  learnedSkillQueryOptions,
} from "@/lib/learning/queries";

/** One learned skill, open while `name` is set: its description and every file it contains. */
export function LearnedSkillDialog({
  source,
  name,
  onClose,
  footer,
}: {
  source: LearnedSkillSource;
  name: string | null;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const detail = useQuery({
    ...learnedSkillQueryOptions(source, name ?? ""),
    enabled: name !== null,
  });
  // The dialog animates closed after `name` goes null; keep showing the last skill until it is gone.
  const shown = useRef<{ name: string | null; skill: typeof detail.data }>({
    name,
    skill: detail.data,
  });
  if (name !== null) shown.current = { name, skill: detail.data };
  const skill = shown.current.skill;
  return (
    <Dialog
      onOpenChange={(next) => (next ? undefined : onClose())}
      open={name !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shown.current.name}</DialogTitle>
          {skill && <DialogDescription>{skill.description}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.error ? (
            <p className="text-destructive text-sm" role="alert">
              {detail.error.message}
            </p>
          ) : skill ? (
            <SkillFiles files={skill.files} />
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
