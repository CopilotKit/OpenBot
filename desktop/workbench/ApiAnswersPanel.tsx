import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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

/** The routes to offer: the set answers' routes and the routes the window asked for. */
function knownRoutes(api: ApiControl | null): ApiRoute[] {
  if (api === null) return [];
  const routes = new Set<ApiRoute>(api.answers().keys());
  for (const record of api.requests()) {
    if (record.route !== null) routes.add(record.route);
  }
  return [...routes].sort();
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
  const [routes, setRoutes] = useState<ApiRoute[]>(() => knownRoutes(api));
  const id = useId();

  useEffect(() => {
    if (picked !== null) setRoute(picked);
  }, [picked]);

  useEffect(() => {
    if (api === null) {
      setAnswers([]);
      setRoutes([]);
      return;
    }
    const update = () => {
      setAnswers([...api.answers()]);
      setRoutes(knownRoutes(api));
    };
    update();
    return api.onChange(update);
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
    <section className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-route`}>Route</FieldLabel>
        {/* The text is the route: a route not in the list is kept as typed. */}
        <Combobox
          items={routes}
          value={route}
          inputValue={route}
          onInputValueChange={(next) => setRoute(next)}
          onValueChange={(next) => {
            if (typeof next === "string") setRoute(next);
          }}
        >
          <ComboboxInput
            id={`${id}-route`}
            aria-label="Route"
            className="w-full font-mono text-xs"
            placeholder="GET /api/v2/organizations/:organizationId/bots"
          />
          <ComboboxContent>
            <ComboboxEmpty>No matches.</ComboboxEmpty>
            <ComboboxList>
              {(item: ApiRoute) => (
                <ComboboxItem
                  key={item}
                  value={item}
                  className="font-mono text-xs"
                >
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-mode`}>Mode</FieldLabel>
        <Select
          value={mode}
          onValueChange={(value) => {
            const next = value as Mode;
            setMode(next);
            setStatus(next === "fail" ? 422 : 200);
          }}
        >
          <SelectTrigger id={`${id}-mode`} size="sm" aria-label="Mode">
            <SelectValue>{modeLabel(mode)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.mode} value={m.mode}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {hasStatus(mode) && (
        <Field>
          <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
          <Input
            id={`${id}-status`}
            type="number"
            aria-label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.valueAsNumber)}
          />
        </Field>
      )}
      {mode === "delay" && (
        <Field>
          <FieldLabel htmlFor={`${id}-ms`}>Delay in ms</FieldLabel>
          <Input
            id={`${id}-ms`}
            type="number"
            aria-label="Delay in ms"
            value={ms}
            onChange={(event) => setMs(event.target.valueAsNumber)}
          />
        </Field>
      )}
      {hasStatus(mode) && (
        <Textarea
          aria-label="Body (JSON)"
          rows={6}
          className="font-mono text-xs"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={api === null} onClick={set}>
          Set answer
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={api === null}
          onClick={() => {
            const target = checkedRoute();
            if (target !== null) clear(target);
          }}
        >
          Clear
        </Button>
      </div>
      {answers.length === 0 ? (
        <Empty className="p-3">
          <EmptyDescription>No API answers are set.</EmptyDescription>
        </Empty>
      ) : (
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-1.5">Route</TableHead>
              <TableHead className="h-8 w-16 px-1.5">Mode</TableHead>
              <TableHead className="h-8 w-16 px-1.5">
                <span className="sr-only">Clear</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {answers.map(([key, answer]) => (
              <TableRow key={key} data-testid="api-answer">
                <TableCell className="truncate px-1.5 py-1 font-mono">
                  <code title={key}>{key}</code>
                </TableCell>
                <TableCell className="px-1.5 py-1 text-muted-foreground">
                  {modeLabel(answer.mode)}
                </TableCell>
                <TableCell className="px-1.5 py-1 text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Clear ${key}`}
                    onClick={() => clear(key)}
                  >
                    Clear
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
