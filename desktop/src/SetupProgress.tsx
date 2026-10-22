import { useEffect, useState } from "react";

/** One setup step, as the native side reports it or the window runs it. */
export type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
};

export function SetupProgress({ steps }: { steps: Progress[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label="Setup progress" aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow key={step.step} step={step} />
      ))}
    </ol>
  );
}

function SetupProgressRow({ step }: { step: Progress }) {
  const [elapsed, setElapsed] = useState(0);
  const running = step.running ?? false;
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span className="step-status">
        {running ? "In progress" : step.ok ? "Complete" : "Failed"}
        {running && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {elapsed < 60
              ? `${elapsed}s`
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}{" "}
            elapsed
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          ` ${formatDownloadBytes(step.downloadBytes)} downloaded.`}
      </span>
    </li>
  );
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
}

function label(step: string): string {
  switch (step) {
    case "engine":
    case "install-engine":
      return "Container engine";
    case "create-machine":
      return "Engine machine";
    case "start-machine":
      return "Starting the machine";
    case "health-gate":
      return "Engine answering";
    case "deployment":
      return "Deployment";
    case "env":
      return "Settings";
    case "ports":
      return "Ports";
    case "dependencies":
      return "Dependencies";
    case "images":
      return "Local software";
    case "installation":
      return "Installation";
    case "answering":
      return "Answering";
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    default:
      return step;
  }
}
