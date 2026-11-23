import { IconChevronRight } from "@tabler/icons-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseTroubleshooting, toScene } from "./logImport";
import type { Scene } from "./scenes/types";

type Start = "first-run" | "relaunch";

const STARTS: readonly { start: Start; label: string }[] = [
  { start: "first-run", label: "First run" },
  { start: "relaunch", label: "Relaunch" },
];

export type ImportLogPanelProps = {
  /** The scenes imported in this browser tab. */
  scenes: readonly Scene[];
  current: string;
  onImport(scene: Scene): void;
  onPick(id: string): void;
};

/** A scene from the text of a troubleshooting file, or a problem to show. */
export function sceneFromLog(
  text: string,
  start: Start,
): { scene: Scene } | { problem: string } {
  const parsed = parseTroubleshooting(text);
  if (parsed.sessions.length === 0)
    return {
      problem:
        "This file has no OpenBot Desktop log. Use the troubleshooting file that OpenBot Desktop saves.",
    };
  return { scene: toScene(parsed, { start }) };
}

/** The command that saves a scene from a log as a file, for agents and the shot CLI. */
export function importCommand(start: Start): string {
  return `bun run workbench:import <file>${start === "relaunch" ? " --start relaunch" : ""}`;
}

/** "Import a log": makes a scene from a troubleshooting file, in the browser. */
export function ImportLogPanel({
  scenes,
  current,
  onImport,
  onPick,
}: ImportLogPanelProps) {
  const [start, setStart] = useState<Start>("first-run");
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  const read = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!file) return;
    // The same file can be chosen again.
    input.value = "";
    let text: string;
    try {
      text = await file.text();
    } catch {
      setProblem(`Cannot read ${file.name}.`);
      return;
    }
    const result = sceneFromLog(text, start);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    onImport(result.scene);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Import a log">
      <Field orientation="horizontal">
        <FieldLabel htmlFor={`${id}-start`}>Start</FieldLabel>
        <Select
          value={start}
          onValueChange={(value) => setStart(value as Start)}
        >
          <SelectTrigger id={`${id}-start`} size="sm" aria-label="Start">
            <SelectValue>
              {STARTS.find((s) => s.start === start)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STARTS.map((s) => (
              <SelectItem key={s.start} value={s.start}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Input
        type="file"
        accept=".txt,.md"
        aria-label="Troubleshooting file"
        onChange={(event) => {
          void read(event.currentTarget);
        }}
      />
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Collapsible>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="group/save -ml-2 justify-start"
            />
          }
        >
          <IconChevronRight
            aria-hidden
            className="transition-transform group-data-panel-open/save:rotate-90"
          />
          Save for agents
        </CollapsibleTrigger>
        <CollapsibleContent
          keepMounted
          className="flex flex-col gap-2 pt-1 text-sm text-muted-foreground"
        >
          <p>
            The browser cannot write files. A scene you import here stays only
            in this browser tab. To save it for agents and the shot CLI, run
            this in the desktop folder:
          </p>
          <code className="block rounded-md bg-muted p-2 font-mono text-xs break-all text-foreground">
            {importCommand(start)}
          </code>
          <p>It writes the scene to workbench/scenes/imported/.</p>
        </CollapsibleContent>
      </Collapsible>
      {scenes.length > 0 && (
        <nav aria-label="Imported scenes" className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Imported</h3>
          {scenes.map((scene) => {
            const isCurrent = scene.id === current;
            return (
              <Button
                key={scene.id}
                variant="ghost"
                size="sm"
                title={scene.id}
                aria-current={isCurrent ? "true" : undefined}
                // "wb-scene": the page's Space key plays on a scene row instead of pressing it.
                className="wb-scene justify-start truncate aria-[current=true]:bg-muted aria-[current=true]:font-medium"
                onClick={() => onPick(scene.id)}
              >
                {scene.title}
              </Button>
            );
          })}
        </nav>
      )}
    </section>
  );
}
