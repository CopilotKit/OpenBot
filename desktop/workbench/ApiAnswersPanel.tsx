import { useEffect, useState } from "react";
import {
  type ApiAnswer,
  type ApiControl,
  type ApiRoute,
  isApiRoute,
  parseApiAnswer,
} from "./appContract";

export type ApiAnswersPanelProps = {
  api: ApiControl | null;
  picked: ApiRoute | null;
  onAnswer(route: ApiRoute, answer: ApiAnswer | null): void;
};

type Mode = ApiAnswer["mode"];

const MODES: readonly { mode: Mode; label: string }[] = [
  { mode: "value", label: "Value" },
  { mode: "never", label: "Never" },
  { mode: "fail", label: "Fail" },
  { mode: "delay", label: "Delay" },
  { mode: "offline", label: "Offline" },
];

const ROUTE_ERROR =
  "Write a method and a path, for example GET /api/v2/organizations/:organizationId/bots.";
const BODY_ERROR = "The body is not valid JSON.";
const STATUS_ERROR = "The status must be a whole number from 100 to 599.";
const DELAY_ERROR = "The delay needs a number of milliseconds, 0 or more.";

function hasStatus(mode: Mode): boolean {
  return mode === "value" || mode === "fail" || mode === "delay";
}

function modeLabel(mode: Mode): string {
  return MODES.find((m) => m.mode === mode)?.label ?? mode;
}

/** Turns the fields into an answer, or gives the sentence that says what is wrong. */
function buildAnswer(
  mode: Mode,
  status: number,
  ms: number,
  text: string,
): { answer: ApiAnswer } | { error: string } {
  if (mode === "never" || mode === "offline") return { answer: { mode } };
  let body: unknown;
  const empty = text.trim() === "";
  if (!(mode === "fail" && empty)) {
    try {
      body = JSON.parse(text);
    } catch {
      return { error: BODY_ERROR };
    }
  }
  const raw: Record<string, unknown> = { mode, status };
  if (mode === "delay") raw.ms = ms;
  if (!(mode === "fail" && empty)) raw.body = body;
  const answer = parseApiAnswer(raw);
  if (answer === null) {
    if (mode === "delay" && (!Number.isFinite(ms) || ms < 0)) {
      return { error: DELAY_ERROR };
    }
    return { error: STATUS_ERROR };
  }
  return { answer };
}

/** Sets how the fake API answers one route. */
export function ApiAnswersPanel(props: ApiAnswersPanelProps) {
  const { api, picked, onAnswer } = props;
  const [route, setRoute] = useState<string>(picked ?? "");
  const [mode, setMode] = useState<Mode>("value");
  const [status, setStatus] = useState(200);
  const [ms, setMs] = useState(1000);
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<[ApiRoute, ApiAnswer][]>(() => [
    ...(api?.answers() ?? []),
  ]);

  useEffect(() => {
    if (picked !== null) setRoute(picked);
  }, [picked]);

  useEffect(() => {
    if (api === null) {
      setAnswers([]);
      return;
    }
    setAnswers([...api.answers()]);
    return api.onChange(() => setAnswers([...api.answers()]));
  }, [api]);

  function checkedRoute(): ApiRoute | null {
    const trimmed = route.trim();
    if (!isApiRoute(trimmed)) {
      setError(ROUTE_ERROR);
      return null;
    }
    return trimmed;
  }

  function set() {
    if (api === null) return;
    const target = checkedRoute();
    if (target === null) return;
    const result = buildAnswer(mode, status, ms, text);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    api.setAnswer(target, result.answer);
    onAnswer(target, result.answer);
  }

  function clear(target: ApiRoute) {
    if (api === null) return;
    setError(null);
    api.clearAnswer(target);
    onAnswer(target, null);
  }

  return (
    <section>
      <h3>API answers</h3>
      <label>
        Route
        <input
          aria-label="Route"
          value={route}
          placeholder="GET /api/v2/organizations/:organizationId/bots"
          onChange={(event) => setRoute(event.target.value)}
        />
      </label>
      <label>
        Mode
        <select
          aria-label="Mode"
          value={mode}
          onChange={(event) => {
            const next = event.target.value as Mode;
            setMode(next);
            setStatus(next === "fail" ? 422 : 200);
          }}
        >
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {hasStatus(mode) && (
        <label>
          Status
          <input
            type="number"
            aria-label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.valueAsNumber)}
          />
        </label>
      )}
      {mode === "delay" && (
        <label>
          Delay in ms
          <input
            type="number"
            aria-label="Delay in ms"
            value={ms}
            onChange={(event) => setMs(event.target.valueAsNumber)}
          />
        </label>
      )}
      {hasStatus(mode) && (
        <textarea
          aria-label="Body (JSON)"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" disabled={api === null} onClick={set}>
          Set answer
        </button>
        <button
          type="button"
          disabled={api === null}
          onClick={() => {
            const target = checkedRoute();
            if (target !== null) clear(target);
          }}
        >
          Clear
        </button>
      </div>
      {answers.length === 0 ? (
        <p>No API answers are set.</p>
      ) : (
        <ul>
          {answers.map(([key, answer]) => (
            <li key={key} data-testid="api-answer">
              <code>{key}</code> <span>{modeLabel(answer.mode)}</span>{" "}
              <button
                type="button"
                aria-label={`Clear ${key}`}
                onClick={() => clear(key)}
              >
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
