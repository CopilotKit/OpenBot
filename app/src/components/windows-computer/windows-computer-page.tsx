import {
  IconDeviceDesktop,
  IconPlayerRecord,
  IconPlayerStop,
  IconPointer,
  IconRobot,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
          "Take over to use it from here. Your Bot stops until you hand it back.",
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
  return <WindowsComputerView computer={computer.data} />;
}

function WindowsComputerView({ computer }: { computer: WindowsComputer }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const take = useMutation(takeWindowsComputerMutationOptions(queryClient));
  const release = useMutation(
    releaseWindowsComputerMutationOptions(queryClient),
  );
  const control = controlWords(computer);
  const changing = take.isPending || release.isPending;
  const changeError = take.error ?? release.error;

  return (
    <PageShell description={DESCRIPTION} title={TITLE}>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{NOT_MASKED}</p>
        <div className="relative min-h-48 w-full overflow-hidden rounded-lg border border-border bg-muted">
          <LiveScreen
            computerId="windows-computer"
            driving={control.human}
            label="Your Windows computer's screen. You have control. Click and type here."
            onProblem={setProblem}
            onReconnecting={setReconnecting}
            ownership={holdsWindowsComputer}
            retryKey={retryKey}
            socketPath="/windows-computer/screen"
          />
        </div>
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

      <PageSection title="Who's using it">
        <PageRows>
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
                    onClick={() => take.mutate()}
                    size="sm"
                  >
                    {take.isPending ? "Taking over…" : "Take over"}
                  </Button>
                )}
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      </PageSection>

      <PageSection title="Recording">
        <RecordingRow computer={computer} />
      </PageSection>
    </PageShell>
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
