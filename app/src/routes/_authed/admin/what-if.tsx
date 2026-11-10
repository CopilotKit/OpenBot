import {
  EMPTY_WHAT_IF_ACTION,
  missingFrom,
  type WhatIfAction,
} from "@openbot/shared/what-if";
import { IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ActionChips } from "@/components/what-if/action-chips";
import { WhatIfResultView } from "@/components/what-if/what-if-result";
import { isComposing } from "@/lib/composing";
import {
  askWhatIf,
  checkWhatIf,
  type WhatIfChecked,
} from "@/lib/what-if/check";
import { whatIfVocabularyQueryOptions } from "@/lib/what-if/queries";

/**
 * `action` is an action to start from, as JSON: what "Try a change" on an Audit row's "Why did this
 * happen?" hands over, so the admin can change one thing and check again.
 */
export const Route = createFileRoute("/_authed/admin/what-if")({
  validateSearch: z.object({ action: z.string().optional() }),
  component: WhatIfPage,
});

/** The longest question the server takes. */
const QUESTION_LIMIT = 500;

/** An action handed over in the address, or none. Only the action's own fields are read. */
function actionFrom(raw: string | undefined): WhatIfAction | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const action = { ...EMPTY_WHAT_IF_ACTION };
    for (const key of Object.keys(action) as (keyof WhatIfAction)[])
      if (typeof parsed[key] === "string")
        (action as Record<string, string>)[key] = parsed[key] as string;
    return action;
  } catch {
    return null;
  }
}

/**
 * "What would happen if…": an admin asks what OpenBot would do with one action. The model only reads
 * the question as the action, shown as chips the admin can change; Check then asks every control in
 * the order OpenBot asks them, and says which one decides.
 *
 * Under What happened in Admin, beside Audit, whose rows answer the same question about the past.
 */
function WhatIfPage() {
  const search = Route.useSearch();
  const vocabulary = useQuery(whatIfVocabularyQueryOptions());
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);
  /** The question the chips were read from, until the admin starts over. */
  const [asked, setAsked] = useState<string | null>(null);
  const [action, setActionState] = useState<WhatIfAction>(
    () => actionFrom(search.action) ?? EMPTY_WHAT_IF_ACTION,
  );
  const [checked, setChecked] = useState<WhatIfChecked | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const question = text.trim();

  const setAction = (next: WhatIfAction) => {
    setActionState(next);
    // The answer below is for the action as it was checked; a change makes it stale.
    setChecked(null);
    setCheckProblem(null);
  };

  const ask = async () => {
    if (!question || asking) return;
    setAskProblem(null);
    setUnclear(null);
    setAsking(true);
    try {
      const reading = await askWhatIf(question);
      if (reading.understood === "no") setUnclear(reading.unclear);
      else {
        setAsked(question);
        setAction(reading.action);
      }
    } catch (thrown) {
      setAskProblem((thrown as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const missing = vocabulary.data
    ? missingFrom(action, vocabulary.data)
    : "Loading this OpenBot's Bots and apps.";

  const check = async () => {
    if (missing || checking) return;
    setCheckProblem(null);
    setChecking(true);
    try {
      setChecked(await checkWhatIf(action, asked ?? undefined));
    } catch (thrown) {
      setCheckProblem((thrown as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <PageShell
      description="Ask what OpenBot would do if a Bot took an action. Every control answers in the order OpenBot checks them, and you see which one decides."
      title="What would happen"
    >
      <form
        className="flex flex-col gap-2"
        data-asking={asking ? "true" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <IconSparkles />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Ask what would happen"
            maxLength={QUESTION_LIMIT}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // A composing IME's Enter picks a word. It doesn't ask.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            placeholder="Could the Sales Bot send email from Gmail when a routine runs it?"
            value={text}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              disabled={!question || asking}
              size="sm"
              type="submit"
              variant="default"
            >
              {asking ? "Reading…" : "Ask"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {askProblem ? (
          <p
            className="text-destructive text-sm"
            data-what-if-problem
            role="alert"
          >
            {askProblem}
          </p>
        ) : unclear ? (
          <p
            className="text-amber-700 text-sm dark:text-amber-500"
            data-what-if-unclear
          >
            {unclear}
          </p>
        ) : null}
      </form>

      <PageSection
        description={
          asked
            ? "This is how OpenBot read your question. Change anything it got wrong, then check it."
            : "Ask a question above, or set the action yourself."
        }
        title="The action"
      >
        <PageCard
          className="mt-4"
          footer={
            <Button
              disabled={Boolean(missing) || checking}
              onClick={() => void check()}
              type="button"
            >
              {checking ? "Checking…" : "Check"}
            </Button>
          }
        >
          {vocabulary.isError ? (
            <p className="text-destructive text-sm" role="alert">
              Couldn't load this OpenBot's Bots and apps. Reload the page.
            </p>
          ) : (
            <ActionChips
              action={action}
              onChange={setAction}
              vocabulary={vocabulary.data}
            />
          )}
          {missing && vocabulary.data ? (
            <p
              className="mt-3 text-muted-foreground text-sm"
              data-what-if-missing
            >
              {missing}
            </p>
          ) : null}
          {checkProblem ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {checkProblem}
            </p>
          ) : null}
        </PageCard>
      </PageSection>

      {checked ? (
        <PageSection
          description="Each control, in the order OpenBot checks them."
          title="What happens"
        >
          <WhatIfResultView result={checked.result} />
        </PageSection>
      ) : null}
    </PageShell>
  );
}
