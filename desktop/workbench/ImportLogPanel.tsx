import { useState } from "react";
import { parseTroubleshooting, toScene } from "./logImport";
import type { Scene } from "./scenes/types";

type Start = "first-run" | "relaunch";

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
    <section className="wb-import" aria-label="Import a log">
      <label className="wb-prop">
        <span>Start</span>
        <select
          value={start}
          onChange={(event) => setStart(event.target.value as Start)}
        >
          <option value="first-run">First run</option>
          <option value="relaunch">Relaunch</option>
        </select>
      </label>
      <input
        type="file"
        accept=".txt,.md"
        aria-label="Troubleshooting file"
        onChange={(event) => {
          void read(event.currentTarget);
        }}
      />
      {problem && <p role="alert">{problem}</p>}
      <details className="wb-import-save">
        <summary>Save for agents</summary>
        <p>
          The browser cannot write files. A scene you import here stays only in
          this browser tab. To save it for agents and the shot CLI, run this in
          the desktop folder:
        </p>
        <code>{importCommand(start)}</code>
        <p>It writes the scene to workbench/scenes/imported/.</p>
      </details>
      {scenes.length > 0 && (
        <nav aria-label="Imported scenes">
          <h3>Imported</h3>
          {scenes.map((scene) => {
            const isCurrent = scene.id === current;
            return (
              <button
                key={scene.id}
                type="button"
                title={scene.id}
                aria-current={isCurrent ? "true" : undefined}
                className={isCurrent ? "wb-scene wb-scene-current" : "wb-scene"}
                onClick={() => onPick(scene.id)}
              >
                {scene.title}
              </button>
            );
          })}
        </nav>
      )}
    </section>
  );
}
