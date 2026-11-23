import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Answer, NativeControl } from "../src/fakeNative/control";
import { COMMANDS } from "../src/fakeNative/registry";
import { parseAnswer } from "./answerEditor";

export type CommandsPanelProps = {
  control: NativeControl | null;
  onAnswer(command: string, answer: Answer): void;
  /** The commands to list. Default: the setup window's commands. */
  commands?: readonly string[];
};

type Mode = Exclude<Answer["mode"], "script">;

const MODES: readonly { mode: Mode; label: string }[] = [
  { mode: "value", label: "Value" },
  { mode: "never", label: "Never answers" },
  { mode: "fail", label: "Fails" },
  { mode: "delay", label: "Delay" },
];

function modeLabel(answer: Answer | undefined): string {
  if (!answer) return "Default";
  if (answer.mode === "script") return "Script";
  return MODES.find((m) => m.mode === answer.mode)?.label ?? "Default";
}

function initialText(answer: Answer | undefined): string {
  if (!answer) return "null";
  if (answer.mode === "value" || answer.mode === "delay")
    return JSON.stringify(answer.value) ?? "null";
  if (answer.mode === "fail") return JSON.stringify(answer.problem) ?? "null";
  return "null";
}

function CommandRow({
  name,
  answer,
  control,
  onAnswer,
}: {
  name: string;
  answer: Answer | undefined;
  control: NativeControl | null;
  onAnswer(command: string, answer: Answer): void;
}) {
  const [mode, setMode] = useState<Mode>(
    answer && answer.mode !== "script" ? answer.mode : "value",
  );
  const [text, setText] = useState(initialText(answer));
  const [ms, setMs] = useState(answer?.mode === "delay" ? answer.ms : 1000);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setMode(answer && answer.mode !== "script" ? answer.mode : "value");
    setText(initialText(answer));
    setMs(answer?.mode === "delay" ? answer.ms : 1000);
  }, [answer, dirty]);

  function apply() {
    if (!control) return;
    const result = parseAnswer(mode, text, ms);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setDirty(false);
    control.setAnswer(name, result.answer);
    onAnswer(name, result.answer);
  }

  return (
    <Collapsible data-command={name}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="group/command w-full justify-start font-mono text-xs"
          />
        }
      >
        <IconChevronRight
          aria-hidden
          className="transition-transform group-data-panel-open/command:rotate-90"
        />
        <span className="truncate">
          {name} ({modeLabel(answer)})
        </span>
      </CollapsibleTrigger>
      {/* Kept mounted: a folded row keeps what the person typed. */}
      <CollapsibleContent keepMounted className="flex flex-col gap-2 py-2 pl-6">
        <Select
          value={mode}
          onValueChange={(value) => {
            setDirty(true);
            setMode(value as Mode);
          }}
        >
          <SelectTrigger size="sm" aria-label={`Mode for ${name}`}>
            <SelectValue>{mode}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.mode} value={m.mode}>
                {m.mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          aria-label={`Answer for ${name}`}
          rows={4}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => {
            setDirty(true);
            setText(e.target.value);
          }}
        />
        {mode === "delay" && (
          <Input
            type="number"
            aria-label={`Delay for ${name}`}
            value={ms}
            onChange={(e) => {
              setDirty(true);
              setMs(e.target.valueAsNumber);
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          size="sm"
          className="self-start"
          aria-label={`Apply ${name}`}
          disabled={!control}
          onClick={apply}
        >
          Apply
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Search the commands and set how each one answers. */
export function CommandsPanel({
  control,
  onAnswer,
  commands = COMMANDS,
}: CommandsPanelProps) {
  const [query, setQuery] = useState("");
  const [answers, setAnswers] = useState<Map<string, Answer>>(
    () => new Map(control?.answers() ?? []),
  );

  useEffect(() => {
    if (!control) {
      setAnswers(new Map());
      return;
    }
    setAnswers(new Map(control.answers()));
    return control.onChange((change) => {
      if (change.kind === "answer") setAnswers(new Map(control.answers()));
    });
  }, [control]);

  const needle = query.toLowerCase();
  const shown = commands.filter((name) => name.toLowerCase().includes(needle));

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">Commands</h3>
      <InputGroup className="mb-1">
        <InputGroupAddon>
          <IconSearch aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </InputGroup>
      {shown.map((name) => (
        <CommandRow
          key={name}
          name={name}
          answer={answers.get(name)}
          control={control}
          onAnswer={onAnswer}
        />
      ))}
    </section>
  );
}
