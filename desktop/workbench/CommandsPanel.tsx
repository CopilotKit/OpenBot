import { useEffect, useState } from "react";
import type { Answer, NativeControl } from "../src/fakeNative/control";
import { COMMANDS } from "../src/fakeNative/registry";
import { parseAnswer } from "./answerEditor";

export type CommandsPanelProps = {
  control: NativeControl | null;
  onAnswer(command: string, answer: Answer): void;
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
    <details data-command={name}>
      <summary>
        {name} ({modeLabel(answer)})
      </summary>
      <select
        aria-label={`Mode for ${name}`}
        value={mode}
        onChange={(e) => {
          setDirty(true);
          setMode(e.target.value as Mode);
        }}
      >
        {MODES.map((m) => (
          <option key={m.mode} value={m.mode}>
            {m.mode}
          </option>
        ))}
      </select>
      <textarea
        aria-label={`Answer for ${name}`}
        rows={4}
        value={text}
        onChange={(e) => {
          setDirty(true);
          setText(e.target.value);
        }}
      />
      {mode === "delay" && (
        <input
          type="number"
          aria-label={`Delay for ${name}`}
          value={ms}
          onChange={(e) => {
            setDirty(true);
            setMs(e.target.valueAsNumber);
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        aria-label={`Apply ${name}`}
        disabled={!control}
        onClick={apply}
      >
        Apply
      </button>
    </details>
  );
}

/** Search the commands and set how each one answers. */
export function CommandsPanel({ control, onAnswer }: CommandsPanelProps) {
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
  const shown = COMMANDS.filter((name) => name.toLowerCase().includes(needle));

  return (
    <section>
      <h3>Commands</h3>
      <input
        aria-label="Search commands"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
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
