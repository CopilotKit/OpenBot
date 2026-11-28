import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  IconDeviceDesktop,
  IconPlayerRecord,
  IconPlayerStop,
  IconPointer,
  IconRobot,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { LiveScreen } from "@/components/computer/live-screen";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ConnectWindowsComputer } from "@/components/windows-computer/connect-windows-computer";
import type { WindowsComputerRecording } from "@/lib/api/generated/model";
import {
  releaseWindowsComputerMutationOptions,
  startWindowsComputerRecordingMutationOptions,
  stopWindowsComputerRecordingMutationOptions,
  takeWindowsComputerMutationOptions,
} from "@/lib/windows-computer/mutations";
import {
  holdsWindowsComputer,
  type WindowsComputer,
  windowsComputerQueryOptions,
} from "@/lib/windows-computer/queries";
import { queryClient } from "@/query-client";

const TITLE = "Windows computer";
const DESCRIPTION =
  "Watch your Bot work on your Windows computer. Take it over when you want to, and record how you do a task so your Bots can learn it.";

/** Said above the screen, always: the live view is the whole screen and hides nothing. */
export const NOT_MASKED =
  "Not masked. This shows everything on your Windows computer's screen, including other programs and notifications.";

/** Why the Windows computer can't be used right now, in the person's words. */
export function unavailableWords(reason: string | undefined): string {
  switch (reason) {
    case "locked":
      return "Your Windows computer is locked. Unlock it to keep going.";
    case "secure_desktop":
      return "Windows is asking for permission. Answer it on your Windows computer.";
    case "not_enrolled":
      return "No Windows computer is connected to OpenBot yet. Connect one on the Windows computer page.";
    case "not_connected":
      return "Your Windows computer isn't connected. It connects by itself when it's on and you're signed in to it.";
    default:
      return "Your Windows computer isn't answering right now. It shows here again once it does.";
  }
}

/** Who is using the Windows computer, as its row says it. */
export function controlWords(computer: WindowsComputer): {
  title: string;
  description: string;
  human: boolean;
} {
  const human = computer.control?.holder === "human";
  if (!computer.control)
    return {
      title: "Not answering",
      description: unavailableWords(computer.unavailableReason),
      human: false,
    };
  return human
    ? {
        title: "You're using it",
        description:
          computer.control.reason === "interference"
            ? "Your Bot stopped when you used the mouse or keyboard. Hand it back when you're done."
            : "Click and type on the screen above to use it. Your Bot waits until you hand it back.",
        human: true,
      }
    : {
        title: "Your Bot is using it",
        description:
          computer.control.reason === "idle"
            ? "It went back to your Bot because you hadn't used it for a while. Take over to use it again."
            : "Take over to use it from here. Your Bot stops until you hand it back.",
        human: false,
      };
}

/** What the recording row says. */
export function recordingWords(recording: WindowsComputerRecording): string {
  switch (recording.state) {
    case "starting":
      return "Starting the recording.";
    case "recording":
      return `Recording “${recording.title ?? "a task"}”. Do the task once, then press Stop.`;
    case "stopping":
      return "Saving the recording.";
    case "stopped":
      return recording.outcome === "failed"
        ? `“${recording.title ?? "The task"}” was saved as not working.`
        : `“${recording.title ?? "The task"}” was saved. OpenBot learns from it.`;
    default:
      return "Show your Bots how you do a task. Press Record, name it, and do it once.";
  }
}

/**
 * The Windows computer: its live screen, who is using it, and its recordings
 * (`api/openapi/windows-computer.yaml`, and the `windowsComputerScreen` channel in `api/asyncapi.yaml`).
 *
 * The screen is the whole screen, not masked, and says so above it. Once the person takes over, what they click and
 * type on it goes to the Windows computer; while their Bot has it, the screen only shows it.
 */
export function WindowsComputerPage() {
  const computer = useQuery(windowsComputerQueryOptions());

  if (computer.isPending) return <PageShell title={TITLE}>{null}</PageShell>;
  if (computer.error)
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        <p className="text-destructive text-sm" role="alert">
          Couldn't load your Windows computer. Try again in a moment.
        </p>
      </PageShell>
    );
  if (!computer.data)
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        <PageEmpty icon={IconDeviceDesktop} title="No Windows computer">
          There's no Windows computer set up for you.
        </PageEmpty>
      </PageShell>
    );
  return (
    <PageShell description={DESCRIPTION} title={TITLE}>
      {computer.data.connected === false ? (
        <ConnectWindowsComputer computer={computer.data} />
      ) : (
        <WindowsComputerView computer={computer.data} />
      )}
    </PageShell>
  );
}

/**
 * The Windows computer's screen, who is using it and its recording, without a page around it: the
 * page above, and a conversation's computer panel for a Bot that works on it (computer-panel.tsx).
 *
 * In the panel (`compact`) the screen is a tile, as a Bot's browser is (computer-view.tsx): too small
 * to work in, so pressing it, or Take over, opens it full size over the window. The Windows computer
 * shows its screen to one viewer at a time and a newer one replaces the older, so the tile lets go of
 * its stream while the full-size view has it, and takes it back when that closes.
 */
export function WindowsComputerView({
  computer,
  compact = false,
}: {
  computer: WindowsComputer;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const tile = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const control = controlWords(computer);
  const openExpanded = () => {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setExpanded(true);
  };
  /** Back to what opened it, or to the tile that opens it when that has gone. */
  const focusAfterClose = () =>
    opener.current?.isConnected
      ? opener.current
      : tile.current?.isConnected
        ? tile.current
        : true;

  if (!compact)
    return (
      <>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">{NOT_MASKED}</p>
          <WindowsScreen driving={control.human} />
        </div>
        <PageSection title="Who's using it">
          <PageRows>
            <ControlRow computer={computer} />
          </PageRows>
        </PageSection>
        <PageSection title="Recording">
          <RecordingRow computer={computer} />
        </PageSection>
      </>
    );

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{NOT_MASKED}</p>
        {expanded ? (
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-border bg-muted p-4 text-center text-muted-foreground text-sm">
            Showing full size.
          </div>
        ) : (
          <WindowsScreen
            driving={false}
            frame={(screen) => (
              <button
                aria-label="Open your Windows computer's screen full size"
                className="relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted"
                onClick={openExpanded}
                ref={tile}
                type="button"
              >
                {screen}
              </button>
            )}
          />
        )}
      </div>

      <PageSection title="Who's using it">
        <PageRows>
          <ControlRow computer={computer} onTakeOver={openExpanded} />
        </PageRows>
      </PageSection>

      <PageSection title="Recording">
        <RecordingRow computer={computer} />
      </PageSection>

      {/*
        As a Bot's browser opens full size (computer-view.tsx): portalled to the body, so it covers the window and not
        the panel; Escape and Close close it and never hand control back; the backdrop closes it only while the person
        is not driving, so a click beside the screen does not throw them out of it.
      */}
      <DialogPrimitive.Root
        onOpenChange={(next) => {
          if (!next) setExpanded(false);
        }}
        open={expanded}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            aria-label="Your Windows computer's screen"
            className="fixed inset-0 z-50 flex flex-col overflow-y-auto p-2 outline-none sm:p-4"
            finalFocus={focusAfterClose}
            initialFocus={closeButton}
          >
            <button
              aria-hidden
              className={`fixed inset-0 bg-black/80 ${control.human ? "cursor-default" : "cursor-zoom-out"}`}
              onClick={() => !control.human && setExpanded(false)}
              tabIndex={-1}
              type="button"
            />
            {/*
              The screen takes everything but a column beside it for who is using it (under it in a narrow window),
              as large as the window allows at a desktop's shape; in a short window the card grows and scrolls.
            */}
            <div className="relative m-auto flex min-h-[calc(100svh-1rem)] w-full min-w-0 shrink-0 flex-col gap-4 rounded-2xl bg-background p-3 shadow-2xl ring-1 ring-black/5 sm:min-h-[calc(100svh-2rem)] lg:h-[calc(100svh-2rem)] lg:flex-row dark:ring-white/10">
              <div className="flex justify-end lg:absolute lg:top-3 lg:right-3 lg:z-10">
                <button
                  aria-label="Close your Windows computer's screen"
                  className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setExpanded(false)}
                  ref={closeButton}
                  title="Close (Esc)"
                  type="button"
                >
                  <IconX aria-hidden className="size-5" />
                </button>
              </div>
              {/* A height of its own, so the screen fits it both ways whatever the desktop's shape. */}
              <div className="flex h-[calc(100svh-14rem)] min-h-64 min-w-0 flex-1 lg:h-auto lg:min-h-0">
                <WindowsScreen
                  autoFocus={control.human}
                  driving={control.human}
                  fill
                />
              </div>
              <div className="flex w-full shrink-0 flex-col gap-4 lg:w-80 lg:pt-10">
                <p className="text-muted-foreground text-sm">{NOT_MASKED}</p>
                <PageRows>
                  <ControlRow computer={computer} />
                </PageRows>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

/**
 * The Windows computer's live screen and what is wrong with it, with Retry. `frame` wraps the screen alone, for the
 * panel's tile, whose button cannot hold the Retry button.
 */
function WindowsScreen({
  driving,
  autoFocus,
  frame,
  fill = false,
}: {
  driving: boolean;
  autoFocus?: boolean;
  frame?: (screen: ReactNode) => ReactNode;
  /** As large as its container both ways, at the screen's own shape: the full-size view. */
  fill?: boolean;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const screen = (
    <LiveScreen
      autoFocus={autoFocus}
      computerId="windows-computer"
      fit={fill ? "contain" : "width"}
      driving={driving}
      label="Your Windows computer's screen. You have control. Click and type here."
      onProblem={setProblem}
      onReconnecting={setReconnecting}
      ownership={holdsWindowsComputer}
      retryKey={retryKey}
      socketPath="/windows-computer/screen"
    />
  );
  return (
    <div
      className={`flex flex-col gap-3 ${fill ? "h-full min-h-0 w-full" : ""}`}
    >
      {frame ? (
        frame(screen)
      ) : fill ? (
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {screen}
        </div>
      ) : (
        <div className="relative min-h-48 w-full overflow-hidden rounded-lg border border-border bg-muted">
          {screen}
        </div>
      )}
      {problem ? (
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground text-sm" role="status">
            {problem}
          </p>
          <Button
            onClick={() => {
              setProblem(null);
              setRetryKey((key) => key + 1);
            }}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : reconnecting ? (
        <p className="text-muted-foreground text-sm" role="status">
          Reconnecting to the screen.
        </p>
      ) : null}
    </div>
  );
}

/** Who is using the Windows computer, with Take over or Hand back. `onTakeOver` also runs when it is taken. */
function ControlRow({
  computer,
  onTakeOver,
}: {
  computer: WindowsComputer;
  onTakeOver?: () => void;
}) {
  const take = useMutation(takeWindowsComputerMutationOptions(queryClient));
  const release = useMutation(
    releaseWindowsComputerMutationOptions(queryClient),
  );
  const control = controlWords(computer);
  const changing = take.isPending || release.isPending;
  const changeError = take.error ?? release.error;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {control.human ? <IconPointer /> : <IconRobot />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{control.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {changeError ? changeError.message : control.description}
        </ItemDescription>
      </ItemContent>
      {computer.control ? (
        <ItemActions>
          {control.human ? (
            <Button
              disabled={changing}
              onClick={() => release.mutate()}
              size="sm"
              variant="outline"
            >
              {release.isPending ? "Handing back…" : "Hand back"}
            </Button>
          ) : (
            <Button
              disabled={changing || !computer.available}
              onClick={() => {
                take.mutate();
                onTakeOver?.();
              }}
              size="sm"
            >
              {take.isPending ? "Taking over…" : "Take over"}
            </Button>
          )}
        </ItemActions>
      ) : null}
    </Item>
  );
}

function RecordingRow({ computer }: { computer: WindowsComputer }) {
  const recording = computer.recording;
  const active =
    recording.state === "recording" || recording.state === "starting";
  const [recordOpen, setRecordOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  return (
    <PageRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          {active ? <IconPlayerStop /> : <IconPlayerRecord />}
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{active ? "Recording" : "Record a task"}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {recording.problem ?? recordingWords(recording)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {active ? (
            <Button
              onClick={() => setStopOpen(true)}
              size="sm"
              variant="outline"
            >
              Stop
            </Button>
          ) : (
            <Button
              disabled={!computer.available || recording.state === "stopping"}
              onClick={() => setRecordOpen(true)}
              size="sm"
            >
              Record
            </Button>
          )}
        </ItemActions>
      </Item>
      {recording.gaps > 0 && recording.state !== "idle" ? (
        <>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemDescription className="line-clamp-none">
                {recording.gaps === 1
                  ? "One moment wasn't recorded, such as another program in front or a locked screen."
                  : `${recording.gaps} moments weren't recorded, such as another program in front or a locked screen.`}
              </ItemDescription>
            </ItemContent>
          </Item>
        </>
      ) : null}
      <RecordDialog onOpenChange={setRecordOpen} open={recordOpen} />
      <StopDialog onOpenChange={setStopOpen} open={stopOpen} />
    </PageRows>
  );
}

/** The programs a recording names, from what the person typed: "notepad.exe, excel.exe". */
export function programsFrom(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((program) => program.trim())
    .filter((program) => program.length > 0);
}

function RecordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [narration, setNarration] = useState("");
  const [programs, setPrograms] = useState("");
  const start = useMutation(
    startWindowsComputerRecordingMutationOptions(queryClient),
  );
  const apps = programsFrom(programs);
  const ready = title.trim().length > 0 && apps.length > 0;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a task</DialogTitle>
          <DialogDescription>
            Only the programs you name are recorded. What you type into a
            password field is never recorded.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            start.mutate(
              {
                title: title.trim(),
                apps,
                ...(narration.trim() ? { narration: narration.trim() } : {}),
              },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="windows-recording-title">Task</FieldLabel>
              <Input
                id="windows-recording-title"
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Save a meeting note"
                value={title}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="windows-recording-programs">
                Programs
              </FieldLabel>
              <Input
                id="windows-recording-programs"
                onChange={(event) => setPrograms(event.target.value)}
                placeholder="notepad.exe"
                value={programs}
              />
              <FieldDescription>
                The program names to record, separated by commas.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="windows-recording-narration">
                What you're showing
              </FieldLabel>
              <Textarea
                id="windows-recording-narration"
                maxLength={2000}
                onChange={(event) => setNarration(event.target.value)}
                placeholder="I open Notepad, type the note and save it under the meeting's date."
                value={narration}
              />
              <FieldDescription>
                Say what you do and when to do it this way. OpenBot learns most
                from this.
              </FieldDescription>
            </Field>
            {start.error ? (
              <p className="text-destructive text-sm" role="alert">
                {start.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!ready || start.isPending}
              size="sm"
              type="submit"
            >
              {start.isPending ? "Starting…" : "Start recording"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StopDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stop = useMutation(
    stopWindowsComputerRecordingMutationOptions(queryClient),
  );
  const finish = (outcome: "succeeded" | "failed") =>
    stop.mutate({ outcome }, { onSuccess: () => onOpenChange(false) });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Did it work?</DialogTitle>
          <DialogDescription>
            OpenBot learns from both. Say whether the task worked this time.
          </DialogDescription>
        </DialogHeader>
        {stop.error ? (
          <DialogBody className="mt-4">
            <p className="text-destructive text-sm" role="alert">
              {stop.error.message}
            </p>
          </DialogBody>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            disabled={stop.isPending}
            onClick={() => finish("failed")}
            size="sm"
            variant="outline"
          >
            It didn't work
          </Button>
          <Button
            disabled={stop.isPending}
            onClick={() => finish("succeeded")}
            size="sm"
          >
            {stop.isPending ? "Saving…" : "It worked"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
