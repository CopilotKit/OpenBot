import {
  joinedLearningContainer,
  type LearningSpaceState,
} from "@openbot/shared/recorder-api";
import { IconMicrophone } from "@tabler/icons-react";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DISCLOSURE_SHORT } from "../ui/disclosure";

const LEARNING_SENTENCES: Partial<Record<LearningSpaceState["state"], string>> =
  {
    unassigned:
      "Learning will not see this recording: Automatic Learning is off in this OpenBot. It still goes to Intelligence.",
    missing:
      "Learning will not see this recording: your Learning space could not be made in Intelligence. Ask an admin to check Admin, Automatic Learning. It still goes to Intelligence.",
    // OpenBot could not read its Learning settings, or your space was still being made, so it named none.
    unverified:
      "Learning may not see this recording: OpenBot could not reach your Learning space just now. It still goes to Intelligence.",
  };

/**
 * What the person is told under the title: a warning only when the capture pass joins none of their own Learning space
 * (Automatic Learning is off, the space could not be made, or OpenBot could not reach it). A space OpenBot could not
 * check with Intelligence (its Learning delivery off, or Intelligence not answering) says nothing, because the pass
 * still joins it.
 */
export function learningSentence(learning: LearningSpaceState): string | null {
  if (joinedLearningContainer(learning) !== null) return null;
  return LEARNING_SENTENCES[learning.state] ?? null;
}

const TITLE_MAX = 120;

/**
 * The title, narration and Record. Every recording goes into the person's own Learning space, so there is nothing to
 * pick. Narration is the person's own choice, made once and kept: until they made it (on the setup page, or here) the
 * form asks before its first recording, and the Recorder opens no microphone; after, a switch shows it and changes it.
 * Deviation from openbot-screen-layout: the title `Input` sits in a `Field` inside the section rather than as a summary
 * row that opens a dialog, because a toolbar popup is one short form whose only job is to name and press Record, and a
 * dialog over a 384px popup would hide the very button it serves.
 */
export function RecordForm({
  learning = null,
  busy,
  onRecord,
  learningShown = null,
  microphoneBlocked = false,
  onAllowMicrophone,
  narration = null,
  onNarration,
}: {
  /** The person's own Learning space, once OpenBot said; null until then, and nothing is warned about. */
  learning?: LearningSpaceState | null;
  busy: boolean;
  onRecord: (title: string) => void;
  /** A Learning sentence the popup already shows above the form (about the recording just stopped): not repeated. */
  learningShown?: string | null;
  /** The browser has not given the Recorder a lasting microphone grant (refused, or never answered): the form offers
   * the setup page, since a recording would go on without narration. */
  microphoneBlocked?: boolean;
  onAllowMicrophone?: () => void;
  /** Whether the person narrates their recordings; null until they chose. */
  narration?: "on" | "off" | null;
  /** The person's choice, on their click. */
  onNarration?: (on: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const warning = learning ? learningSentence(learning) : null;
  const sentence = warning === learningShown ? null : warning;
  // Nothing records before the person said whether it may listen to them.
  const ready = title.trim() !== "" && !busy && narration !== null;
  return (
    <PageSection>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onRecord(title.trim());
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="recorder-title">
              What are you about to do?
            </FieldLabel>
            <Input
              id="recorder-title"
              value={title}
              maxLength={TITLE_MAX}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
            {/* The store's prominent disclosure, read before Record collects anything (ui/disclosure.ts). */}
            <FieldDescription>{DISCLOSURE_SHORT}</FieldDescription>
            {sentence ? (
              <FieldDescription role="status">{sentence}</FieldDescription>
            ) : null}
          </Field>
          {narration === null ? (
            <Field>
              <FieldLabel>Narrate while you record?</FieldLabel>
              <FieldDescription>
                The Recorder listens to you and adds what you say to your steps
                as text, turned into text on your own computer. You choose once,
                and can change it before any recording.
              </FieldDescription>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onNarration?.(false)}
                >
                  Don't narrate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onNarration?.(true)}
                >
                  <IconMicrophone data-icon="inline-start" />
                  Narrate
                </Button>
              </div>
            </Field>
          ) : (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="recorder-narration">Narration</FieldLabel>
                <FieldDescription>
                  {narration === "on"
                    ? "The Recorder listens while you record."
                    : "Off. The Recorder does not open your microphone."}
                </FieldDescription>
              </FieldContent>
              {/* Named by its label's text too: the switch is a span with role="switch", which `htmlFor` cannot name. */}
              <Switch
                aria-label="Narration"
                id="recorder-narration"
                checked={narration === "on"}
                onCheckedChange={(on) => onNarration?.(on)}
              />
            </Field>
          )}
          {narration === "on" && microphoneBlocked && onAllowMicrophone ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="-ml-px self-start px-0 has-data-[icon=inline-start]:pl-0"
              onClick={onAllowMicrophone}
            >
              <IconMicrophone data-icon="inline-start" />
              Allow microphone
            </Button>
          ) : null}
          <Button size="lg" type="submit" disabled={!ready}>
            Record
          </Button>
        </FieldGroup>
      </form>
    </PageSection>
  );
}
