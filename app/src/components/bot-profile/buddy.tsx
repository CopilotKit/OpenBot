import {
  IconChevronRight,
  IconPhotoPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BotBuddy, useBotBuddy } from "@/components/agents/bot-buddy";
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
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  automaticBuddy,
  type DrawnBuddy,
  ownBuddy,
  stockBuddy,
} from "@/lib/buddies/buddy";
import {
  chooseBotBuddyMutationOptions,
  createBuddyMutationOptions,
  deleteBuddyMutationOptions,
} from "@/lib/buddies/mutations";
import { type OwnBuddy, ownBuddiesQueryOptions } from "@/lib/buddies/queries";
import { STOCK_BUDDIES } from "@/lib/buddies/stock";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** The largest picture a buddy is made from, as the API takes it. */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/**
 * The "For you" row for a Bot's buddy: the character it is drawn as, for this person only. Opens the
 * picker.
 */
export function BotBuddyRow({
  agent,
}: {
  agent: Pick<AgentProfile, "id" | "name" | "avatarSeed" | "buddy">;
}) {
  const [open, setOpen] = useState(false);
  const buddy = useBotBuddy(agent.avatarSeed);
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia>
          <BotBuddy
            buddy={buddy}
            name={buddy.name}
            seed={agent.avatarSeed}
            size={32}
          />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Buddy</ItemTitle>
          <ItemDescription>
            {agent.buddy
              ? `${buddy.name}. Only you see it.`
              : `${buddy.name}, picked for this Bot. Choose another for yourself.`}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      {open ? (
        <BuddyPicker agent={agent} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function BuddyPicker({
  agent,
  onClose,
}: {
  agent: Pick<AgentProfile, "id" | "name" | "avatarSeed" | "buddy">;
  onClose: () => void;
}) {
  const own = useQuery(ownBuddiesQueryOptions());
  const choose = useMutation(chooseBotBuddyMutationOptions(queryClient));
  const [picked, setPicked] = useState<string | null>(agent.buddy ?? null);
  const automatic = automaticBuddy(agent.avatarSeed);
  const preview = previewOf(picked, automatic, own.data);
  const changed = picked !== (agent.buddy ?? null);

  const save = async () => {
    try {
      await choose.mutateAsync({ botId: agent.id, buddy: picked });
      onClose();
    } catch {
      // The mutation's error is shown below.
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => !next && !choose.isPending && onClose()}
      open
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Buddy</DialogTitle>
          <DialogDescription>
            Choose the character {agent.name} is drawn as. Only you see it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-5">
          <div className="flex items-center gap-4">
            <BotBuddy
              buddy={preview}
              key={preview.key}
              name={preview.name}
              seed={agent.avatarSeed}
              size={96}
            />
            <div className="min-w-0">
              <p className="font-medium">{preview.name}</p>
              <p className="text-muted-foreground text-sm">
                {picked === null
                  ? "Picked for this Bot."
                  : picked.startsWith("own:")
                    ? "Made by you."
                    : "A stock buddy."}
              </p>
            </div>
          </div>

          <fieldset className="grid gap-2" disabled={choose.isPending}>
            <legend className="mb-2 font-medium text-sm">Stock buddies</legend>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              <BuddyOption
                buddy={automatic}
                label="Automatic"
                onPick={() => setPicked(null)}
                picked={picked === null}
                seed={agent.avatarSeed}
              />
              {STOCK_BUDDIES.map((stock) => {
                const buddy = stockBuddy(stock);
                return (
                  <BuddyOption
                    buddy={buddy}
                    key={buddy.key}
                    label={buddy.name}
                    onPick={() => setPicked(buddy.key)}
                    picked={picked === buddy.key}
                    seed={agent.avatarSeed}
                  />
                );
              })}
            </div>
          </fieldset>

          <OwnBuddies
            onPick={setPicked}
            own={own.data}
            ownFailed={own.isError}
            picked={picked}
            seed={agent.avatarSeed}
          />

          <MakeBuddy />

          {choose.error ? (
            <p className="text-destructive text-sm" role="alert">
              {choose.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={choose.isPending}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={choose.isPending || !changed}
            onClick={() => void save()}
            size="sm"
          >
            {choose.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function previewOf(
  picked: string | null,
  automatic: DrawnBuddy,
  own: readonly OwnBuddy[] | undefined,
): DrawnBuddy {
  if (picked === null) return automatic;
  const stock = STOCK_BUDDIES.find((buddy) => `stock:${buddy.id}` === picked);
  if (stock) return stockBuddy(stock);
  const made = own?.find((buddy) => `own:${buddy.id}` === picked);
  return (made && ownBuddy(made)) ?? automatic;
}

function BuddyOption({
  buddy,
  label,
  picked,
  onPick,
  seed,
  disabled = false,
  note,
}: {
  buddy: DrawnBuddy;
  label: string;
  picked: boolean;
  onPick: () => void;
  seed: string;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <button
      aria-pressed={picked}
      className={cn(
        "grid justify-items-center gap-1 rounded-lg border border-transparent p-2 text-center outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
        picked && "border-foreground/40 bg-muted/40",
      )}
      disabled={disabled}
      onClick={onPick}
      type="button"
    >
      <BotBuddy buddy={buddy} name={label} seed={seed} size={48} still />
      <span className="line-clamp-2 text-xs leading-tight">{label}</span>
      {note ? (
        <span className="text-[11px] text-muted-foreground leading-tight">
          {note}
        </span>
      ) : null}
    </button>
  );
}

function OwnBuddies({
  own,
  ownFailed,
  picked,
  onPick,
  seed,
}: {
  own: readonly OwnBuddy[] | undefined;
  ownFailed: boolean;
  picked: string | null;
  onPick: (key: string | null) => void;
  seed: string;
}) {
  const remove = useMutation(deleteBuddyMutationOptions(queryClient));
  if (ownFailed || !own || own.length === 0) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium text-sm">Your buddies</legend>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {own.map((made) => {
          const drawn = ownBuddy(made);
          const key = `own:${made.id}`;
          const note =
            made.status === "generating"
              ? `Making… ${made.progress.done} of ${made.progress.total}`
              : made.status === "failed"
                ? "Couldn't make it"
                : undefined;
          return (
            <div className="relative" key={made.id}>
              {drawn ? (
                <BuddyOption
                  buddy={drawn}
                  disabled={made.status !== "ready"}
                  label={made.name}
                  note={note}
                  onPick={() => onPick(key)}
                  picked={picked === key}
                  seed={seed}
                />
              ) : (
                <div className="grid justify-items-center gap-1 p-2 text-center">
                  <span className="grid size-12 animate-pulse place-items-center rounded-full bg-muted" />
                  <span className="text-xs">{made.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {note ?? "Drawing it…"}
                  </span>
                </div>
              )}
              {made.status !== "generating" ? (
                <button
                  aria-label={`Delete ${made.name}`}
                  className="absolute top-0 right-0 grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (picked === key) onPick(null);
                    remove.mutate(made.id);
                  }}
                  title={made.error ?? `Delete ${made.name}`}
                  type="button"
                >
                  <IconTrash className="size-3.5" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Make a buddy from a picture: a name, the picture, and anything to add about how it looks. */
function MakeBuddy() {
  const make = useMutation(createBuddyMutationOptions(queryClient));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const nameId = useId();
  const fileId = useId();
  const descriptionId = useId();

  const submit = async () => {
    setProblem(null);
    if (!file) return;
    if (file.size > MAX_PICTURE_BYTES) {
      setProblem("That picture is over 8 MB. Choose a smaller one.");
      return;
    }
    try {
      const image = await readAsDataUri(file);
      await make.mutateAsync({
        name: name.trim(),
        image,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName("");
      setDescription("");
      setFile(null);
      setStarted(true);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Couldn't start making that buddy. Try again.",
      );
    }
  };

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <IconPhotoPlus className="size-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Make one from a picture</h3>
      </div>
      <p className="text-muted-foreground text-sm">
        Upload any picture and OpenBot turns it into a buddy. It takes a few
        minutes, and it appears under Your buddies when it's ready.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Biscuit"
            value={name}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={fileId}>Picture</Label>
          <Input
            accept="image/png,image/jpeg,image/webp"
            id={fileId}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={descriptionId}>Anything to add (optional)</Label>
        <Textarea
          id={descriptionId}
          maxLength={500}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="A small brown dog with a red scarf"
          rows={2}
          value={description}
        />
      </div>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : started ? (
        <p className="text-muted-foreground text-sm" role="status">
          Making your buddy. You can close this and come back.
        </p>
      ) : null}
      <div>
        <Button
          disabled={!file || !name.trim() || make.isPending}
          onClick={() => void submit()}
          size="sm"
        >
          {make.isPending ? "Starting…" : "Make buddy"}
        </Button>
      </div>
    </section>
  );
}
