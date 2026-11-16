import { IconTag } from "@tabler/icons-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { writeBotTags } from "@/lib/agents/roster-tags";

/** A sibling of the Bot link: editing personal tags never navigates or changes the Bot itself. */
export function RosterTagEditor({
  userId,
  botId,
  name,
  tags,
  onSaved,
}: {
  userId: string;
  botId: string;
  name: string;
  tags: readonly string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(tags.join(", "));
          setError("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit tags for ${name}`}
          />
        }
      >
        <IconTag />
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              writeBotTags(userId, botId, draft.split(","));
              onSaved();
              setOpen(false);
            } catch (cause) {
              setError(
                cause instanceof Error && /tag|Sign in/.test(cause.message)
                  ? cause.message
                  : "Couldn't save tags in this browser. Check your browser storage settings and try again.",
              );
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Tags for {name}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <p id={`${id}-help`} className="text-muted-foreground text-sm">
              Saved only for you in this browser. Use up to 20 tags, 40
              characters each. Clear the field to remove all tags.
            </p>
            <label htmlFor={id} className="block text-sm font-medium">
              Tags, separated by commas
            </label>
            <Input
              id={id}
              name="tags"
              value={draft}
              autoComplete="off"
              aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
              aria-invalid={!!error}
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
            {error ? (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-destructive text-sm"
              >
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save tags</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
