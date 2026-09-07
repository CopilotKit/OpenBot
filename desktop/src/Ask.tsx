import { useState } from "react";

/**
 * The last screen: a question, an answer, and only then the handover.
 *
 * The install does not end at "saved". Every step before this proves that something started, which
 * is not the same as proving the choices work: a refused key, a lapsed plan or a model the account
 * cannot use all produce a stack that comes up clean and a Bot that cannot answer. Somebody would
 * find that out later, inside the product, with no idea which answer was the wrong one. So the
 * wizard ends by asking, and the answer on this screen is the proof.
 *
 * One suggested question, already filled in, with one right answer. "Tell me about yourself" is
 * answered convincingly by a Bot whose model credential is fine and whose everything else is
 * broken, and this screen exists to prove rather than to reassure.
 */
export function Ask({
  suggestion,
  onAsk,
  onOpen,
  onBack,
}: {
  suggestion: string;
  onAsk: (question: string) => Promise<string>;
  onOpen: () => void;
  onBack: () => void;
}) {
  const [question, setQuestion] = useState(suggestion);
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function ask() {
    setAsking(true);
    setFailed(false);
    setAnswer(null);
    try {
      setAnswer(await onAsk(question));
    } catch {
      // The sentence is shown by the screen around this one, which already renders a problem in
      // both registers. Recording only that it failed keeps one failure in one place.
      setFailed(true);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="sheet">
      <p className="steps-of">Last step</p>
      <h1>Ask it something.</h1>
      <p className="lede">
        Your Bot is set up. This proves it can answer before you start using it.
      </p>

      <div className="field">
        <label htmlFor="question">Your question</label>
        <input
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={asking}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !asking) {
              ask();
            }
          }}
        />
      </div>

      {answer !== null && (
        <div className="answer">
          <p className="answer-from">Your Bot said</p>
          <p className="answer-text">{answer}</p>
        </div>
      )}

      <div className="row">
        {answer === null ? (
          <button type="button" onClick={ask} disabled={asking}>
            {asking ? "Asking…" : "Ask"}
          </button>
        ) : (
          <button type="button" onClick={onOpen}>
            Start using OpenBot
          </button>
        )}
        {/*
         * Only after something went wrong, and it is the only way back to the answer that caused
         * it. A model screen offered before the failure would be a way to change a choice that was
         * working, which is how somebody breaks a finished install.
         */}
        {failed && (
          <button type="button" className="secondary" onClick={onBack}>
            Change the model
          </button>
        )}
        {answer !== null && (
          <button
            type="button"
            className="secondary"
            onClick={ask}
            disabled={asking}
          >
            Ask again
          </button>
        )}
      </div>

      <p className="footnote">
        Nothing here leaves this computer except the question, which goes to the
        AI provider you connected.
      </p>
    </div>
  );
}
