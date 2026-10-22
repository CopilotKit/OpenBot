import { useState } from "react";
import { asProblem, Failure, type Problem } from "./Problem";
import { StatusLine } from "./SetupProgress";

/**
 * Questions the box starts with: one at random, and the refresh button steps through the rest.
 *
 * Each has an answer somebody can check, or at least an opinion worth reading: "Tell me about
 * yourself" is answered convincingly by a Bot whose model credential is fine and whose everything
 * else is broken, and this screen exists to prove rather than to reassure. The silly ones are on
 * purpose: this is the first thing somebody says to their Bot, and it may as well be fun.
 */
export const PRESET_QUESTIONS = [
  "How many r's are in strawberry?",
  "How many Die Hard movies are there?",
  "Why are frosted strawberry Pop-Tarts better than brown sugar cinnamon?",
  "What is 17 times 23?",
] as const;

/**
 * The last screen: a question, an answer, and only then the handover.
 *
 * The install does not end at "saved". Every step before this proves that something started, which
 * is not the same as proving the choices work: a refused key, a lapsed plan or a model the account
 * cannot use all produce a stack that comes up clean and a Bot that cannot answer. Somebody would
 * find that out later, inside the product, with no idea which answer was the wrong one. So the
 * wizard ends by asking, and the answer on this screen is the proof.
 *
 * A question already in the box, another one a click away, and room to type your own. Asking
 * again with another question is always open, so trying the Bot does not end at the first answer.
 */
export function Ask({
  firstQuestion = Math.floor(Math.random() * PRESET_QUESTIONS.length),
  onAsk,
  onOpen,
  onBack,
  onViewIntelligence,
  local = false,
  stepLabel = "Last step",
}: {
  /** Which of `PRESET_QUESTIONS` the box starts with; one at random unless a test says. */
  firstQuestion?: number;
  onAsk: (question: string) => Promise<string>;
  /** Shows OpenBot in the window; settles once it has, or has failed to. */
  onOpen: () => void | Promise<void>;
  /** Stops OpenBot and returns to the model screen; settles once it has. */
  onBack: () => void | Promise<void>;
  /** Local mode with a recorded stack: opens its Intelligence dashboard, already signed in. */
  onViewIntelligence?: () => Promise<void>;
  /** The local first run's wording: "Test OpenBot", then "Open OpenBot". */
  local?: boolean;
  stepLabel?: string;
}) {
  const [preset, setPreset] = useState(firstQuestion % PRESET_QUESTIONS.length);
  const [question, setQuestion] = useState<string>(PRESET_QUESTIONS[preset]);
  const anotherQuestion = () => {
    const next = (preset + 1) % PRESET_QUESTIONS.length;
    setPreset(next);
    setQuestion(PRESET_QUESTIONS[next]);
  };
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  /*
   * THE FAILURE IS THIS SCREEN'S TO SHOW, and it used to be nobody's.
   *
   * The catch below recorded that something went wrong and threw the problem away, on the belief
   * that the screen around this one would render it. Nothing did. A plan that could not answer
   * produced a "Change the model" button and no sentence at all: the exact silence this screen was
   * built to replace, on the screen built to replace it.
   */
  const [failure, setFailure] = useState<Problem | null>(null);
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState(false);
  const [viewFailure, setViewFailure] = useState<Problem | null>(null);
  // Leaving takes a while: Change the model stops OpenBot first, and showing it can wait on it.
  const [leaving, setLeaving] = useState<"stopping" | "showing" | null>(null);

  async function viewIntelligence() {
    if (!onViewIntelligence) return;
    setOpening(true);
    setOpened(false);
    setViewFailure(null);
    try {
      await onViewIntelligence();
      setOpened(true);
    } catch (error) {
      setViewFailure(asProblem(error));
    } finally {
      setOpening(false);
    }
  }

  async function leave(how: "stopping" | "showing", go: () => unknown) {
    setLeaving(how);
    try {
      await go();
    } finally {
      setLeaving(null);
    }
  }
  const back = () => leave("stopping", onBack);
  const open = () => leave("showing", onOpen);
  const leavingSaid = leaving && (
    <StatusLine>
      {leaving === "stopping" ? "Stopping OpenBot…" : "Opening OpenBot…"}
    </StatusLine>
  );

  async function ask() {
    setAsking(true);
    setFailure(null);
    setAnswer(null);
    try {
      const answer = await onAsk(question);
      setAnswer(answer);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setAsking(false);
    }
  }

  const asked = answer !== null;
  return (
    <div className="sheet">
      <p className="steps-of">{stepLabel}</p>
      <h1>{local ? "Test OpenBot" : "Ask it something."}</h1>
      <p className="lede">
        {local
          ? "Ask your Bot a question to check that it answers. Use this one, try another, or type your own."
          : "Your Bot is set up. This proves it can answer before you start using it."}
      </p>

      <div className="field">
        <label htmlFor="question">Your question</label>
        <div className="field-with-action">
          <input
            id="question"
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            disabled={asking}
            onKeyDown={(event) => {
              // Enter also confirms a character being composed through an input method (Japanese,
              // Chinese, Korean). Asking on that Enter would send the question with its last character
              // still unconfirmed. Chromium marks that keydown `isComposing`; the macOS WebKit webview
              // instead sends it after compositionend with key code 229. Wait for either.
              if (
                event.key === "Enter" &&
                !asking &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                ask();
              }
            }}
          />
          <button
            type="button"
            className="another-question"
            aria-label="Another question"
            title="Another question"
            disabled={asking}
            onClick={anotherQuestion}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-5v5h5" />
              <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 5v-5h-5" />
            </svg>
          </button>
        </div>
      </div>

      {asking && <StatusLine>Asking…</StatusLine>}
      {failure && <Failure problem={failure} />}

      {asked && (
        <div className="answer">
          <p className="answer-from">Your Bot said</p>
          <p className="answer-text">{answer}</p>
        </div>
      )}
      {asked && onViewIntelligence && (
        <>
          <button
            type="button"
            className="text-link"
            disabled={opening}
            onClick={viewIntelligence}
          >
            View in Intelligence
          </button>
          {opening && (
            <StatusLine>Opening the Intelligence dashboard…</StatusLine>
          )}
          {opened && (
            <StatusLine working={false}>Opened in your browser.</StatusLine>
          )}
          {viewFailure && <p className="footnote">{viewFailure.said}</p>}
        </>
      )}

      {leavingSaid}
      <div className="row">
        {asked ? (
          <button type="button" disabled={leaving !== null} onClick={open}>
            {local ? "Open OpenBot" : "Start using OpenBot"}
          </button>
        ) : (
          <button type="button" onClick={ask} disabled={asking}>
            Ask
          </button>
        )}
        {/*
         * Only after something went wrong, and it is the only way back to the answer that caused
         * it. A model screen offered before the failure would be a way to change a choice that was
         * working, which is how somebody breaks a finished install.
         */}
        {failure && (
          <button
            type="button"
            className="quiet"
            disabled={asking || leaving !== null}
            onClick={back}
          >
            Change the model
          </button>
        )}
        {asked && (
          <button
            type="button"
            className="quiet"
            onClick={ask}
            disabled={asking}
          >
            Ask again
          </button>
        )}
      </div>

      <p className="footnote">
        Your question goes to the AI provider you connected.
      </p>
    </div>
  );
}
