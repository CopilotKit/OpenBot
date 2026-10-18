import type {
  LearningSpaceState,
  RecorderBot,
} from "@openbot/shared/recorder-api";
import { IconMicrophone } from "@tabler/icons-react";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LEARNING_SENTENCES: Partial<Record<LearningSpaceState["state"], string>> =
  {
    unassigned:
      "Learning will not see this recording: this Bot has no Learning space. It still saves to OpenBot.",
    missing:
      "Learning will not see this recording: this Bot's Learning space does not exist in Intelligence. Ask an administrator to fix it in Admin, Automatic Learning. It still saves to OpenBot.",
    "learning-off":
      "Learning may not see this recording: Intelligence's Learning delivery is off or unavailable, so OpenBot could not check this Bot's Learning space. It still saves to OpenBot.",
    unverified:
      "Learning may not see this recording: OpenBot could not check this Bot's Learning space with Intelligence just now. It still saves to OpenBot.",
  };

/** What the person is told under the Bot picker; assigned (and the pass-only unjoined) say nothing. */
export function learningSentence(learning: LearningSpaceState): string | null {
  return LEARNING_SENTENCES[learning.state] ?? null;
}

export const TITLE_MAX = 120;

/**
 * The Bot, the title and Record. Deviation from openbot-screen-layout: the Bot `Select` and the title `Input` sit
 * in a `Field` stack inside the section rather than as summary rows that open dialogs, because a toolbar popup is
 * one short form whose only job is to pick, name and press Record, and a dialog over a 384px popup would hide the
 * very button it serves.
 */
export function RecordForm({
  bots,
  initialBotId,
  openRecording,
  transcription,
  microphoneGranted,
  busy,
  onRecord,
  onAllowMicrophone,
}: {
  bots: RecorderBot[];
  initialBotId: string | null;
  openRecording: boolean;
  transcription: boolean;
  microphoneGranted: boolean;
  busy: boolean;
  onRecord: (
    botId: string,
    title: string,
    options?: { replaceOpen: true },
  ) => void;
  onAllowMicrophone: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  // Bots arrive after the form mounts: the pick wins, then the last used, then the first.
  const botId =
    [picked, initialBotId].find((id) =>
      bots.some((candidate) => candidate.id === id),
    ) ??
    bots[0]?.id ??
    "";
  const [title, setTitle] = useState("");
  const bot = bots.find((candidate) => candidate.id === botId);
  const sentence = bot ? learningSentence(bot.learning) : null;
  const ready = bot !== undefined && title.trim() !== "" && !busy;
  return (
    <PageSection>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onRecord(botId, title.trim());
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="recorder-bot">Bot</FieldLabel>
            <Select
              value={botId}
              onValueChange={(value) => {
                if (typeof value === "string") setPicked(value);
              }}
            >
              <SelectTrigger
                id="recorder-bot"
                aria-label="Bot"
                className="w-full"
              >
                <SelectValue>{bot?.name ?? "Choose a Bot"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {bots.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sentence ? <FieldDescription>{sentence}</FieldDescription> : null}
          </Field>
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
            <FieldDescription>
              Records this tab's screen, your voice, clicks, typing and the
              network calls behind each page. Passwords and secrets stay in your
              browser.
            </FieldDescription>
            {transcription ? null : (
              <FieldDescription>
                This OpenBot does not transcribe voice. The screen recording
                still keeps the sound.
              </FieldDescription>
            )}
          </Field>
          {microphoneGranted ? null : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0"
              onClick={onAllowMicrophone}
            >
              <IconMicrophone data-icon="inline-start" />
              Allow microphone
            </Button>
          )}
          <Button size="lg" type="submit" disabled={!ready}>
            Record
          </Button>
          {openRecording ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={!ready}
              onClick={() =>
                onRecord(botId, title.trim(), { replaceOpen: true })
              }
            >
              Stop the open recording
            </Button>
          ) : null}
        </FieldGroup>
      </form>
    </PageSection>
  );
}
