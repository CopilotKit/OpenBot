/*!
The last screen: a real question, put to the Bot that was just set up.

WHY THE INSTALL DOES NOT END AT "SAVED". Everything before this proves that things started, which
is not the same as proving the configuration works. A wrong key, an expired plan, a model name the
provider does not serve: all of them produce a stack that comes up clean and a Bot that cannot
answer, and the person finds out later, in the product, with no idea which of the choices they made
was the wrong one. So the wizard ends by asking a question and showing the answer. A configuration
that has not answered is not a finished install.

AND THIS SCREEN OWNS THE WORST MESSAGE IN THE PRODUCT. Measured on a deliberately invalid key: the
stream opens, says `RUN_STARTED`, says `STEP_STARTED`, and then simply stops. No error event, no
reason, nothing to show. The whole of `OpenAIAuthenticationError: Error code: 401` went to the
container's log, which is where the framework's own handler put it. Passing that experience through
would leave somebody staring at a screen that stopped, so a run that produces no text is treated as
a failure here, the sentence is OpenBot's own, and the container's log is fetched to fill the
developer half, because otherwise there is no developer half at all.
*/

use std::time::Duration;

use crate::problem::Problem;

/// The header the server puts its token in, and the one every harness checks. One spelling, here,
/// because a second copy of it is a 401 nobody can explain.
pub const AGENT_TOKEN_HEADER: &str = "x-openbot-agent-token";

/// Long enough for a cold model, short enough that a hung run is not mistaken for a slow one.
const PATIENCE: Duration = Duration::from_secs(90);

/// What the screen asks when the person has not typed anything of their own.
///
/// A question with one checkable answer, on purpose. "Tell me about yourself" is answered
/// convincingly by a Bot whose tools are all broken, and the point of this screen is proof.
pub const SUGGESTED: &str = "What is 17 times 23?";

/**
Put a question to the harness and return what it said.

Straight to the harness rather than through the server, because what this screen proves is the
credential and the Bot behind it. The server's own path is proved by the step before it, which
writes the Bot's row; adding a session and a login to this would test the parts that are already
green and hide the part that is not.
*/
pub fn ask(endpoint: &str, token: &str, question: &str) -> Result<String, Problem> {
    let client = reqwest::blocking::Client::builder()
        .timeout(PATIENCE)
        .build()
        .map_err(|error| {
            Problem::plain(format!("This machine cannot make web requests: {error}"))
        })?;

    let body = serde_json::json!({
        // New every time. The harness keeps a thread in memory, and reusing an id would ask the
        // question into a conversation that already has an answer in it.
        "threadId": format!("openbot-setup-{}", moment()),
        "runId": format!("openbot-run-{}", moment()),
        "state": {},
        "messages": [{ "id": "m1", "role": "user", "content": question }],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    });

    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .header(AGENT_TOKEN_HEADER, token)
        .json(&body)
        .send()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not reach the Bot it just set up.",
                error.to_string(),
            )
        })?;

    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        // 401 here is this deployment's own token, not the person's model credential, and saying
        // "check your API key" would send them to fix the wrong thing.
        return Err(Problem::with(
            if status == reqwest::StatusCode::UNAUTHORIZED {
                "The Bot refused OpenBot's own request. Stop OpenBot and start it again."
            } else {
                "The Bot could not answer."
            },
            format!("HTTP {status}\n{text}"),
        ));
    }

    match answer_in(&text) {
        Some(answer) => Ok(answer),
        // Deliberately not a sentence here. The caller has the deployment and can fetch the log
        // that holds the actual cause; see `why_nothing_came_back`.
        None => Err(Problem::plain(String::new())),
    }
}

/**
The answer, out of an AG-UI stream.

`TEXT_MESSAGE_CONTENT` carries the text a person sees, one delta per event, and everything else on
the wire is either the framework's own trace or protocol bookkeeping. Measured against a live run
rather than read off the spec: the same stream also carries the whole answer inside `RAW` events,
and collecting those instead would double every reply.
*/
pub fn answer_in(body: &str) -> Option<String> {
    let mut answer = String::new();
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
            continue;
        };
        if event.get("type").and_then(|t| t.as_str()) != Some("TEXT_MESSAGE_CONTENT") {
            continue;
        }
        if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
            answer.push_str(delta);
        }
    }
    let answer = answer.trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

/**
Why a run produced no text, said plainly, with the log kept behind it.

The cause is only ever in the harness's log, so this takes the log rather than the stream. The
sentences name the choice the person made that is wrong, because that is the only thing they can
act on: a key they pasted, a plan that has lapsed, a model name nobody serves.
*/
pub fn why_nothing_came_back(log: &str) -> Problem {
    let lower = log.to_lowercase();

    // The likeliest failure in the whole product, and the reason this screen exists.
    if lower.contains("authenticationerror")
        || lower.contains("incorrect api key")
        || lower.contains("invalid_api_key")
        || lower.contains("401")
    {
        return Problem::with(
            "That key was refused. Go back and connect the model again, either by signing in or with a different key.",
            log,
        );
    }
    if lower.contains("insufficient_quota") || lower.contains("exceeded your current quota") {
        return Problem::with(
            "That account has no credit left with the model provider, so the Bot cannot answer yet.",
            log,
        );
    }
    if lower.contains("rate limit") || lower.contains("429") {
        return Problem::with(
            "The model provider is asking OpenBot to slow down. Wait a minute and ask again.",
            log,
        );
    }
    // A model name is only ever wrong on the compatible row, which is the one that asks for one.
    if lower.contains("model_not_found")
        || lower.contains("does not exist or you do not have access")
        || lower.contains("unknown model")
    {
        return Problem::with(
            "That account cannot use the model that was chosen. Go back and choose another one.",
            log,
        );
    }
    if lower.contains("connection") || lower.contains("timed out") || lower.contains("timeout") {
        return Problem::with(
            "The Bot could not reach the model provider. Check this machine's internet connection and ask again.",
            log,
        );
    }
    Problem::with(
        "The Bot started answering and then stopped. Its own record of what happened is below.",
        log,
    )
}

/// Enough to tell two runs apart, which is all an id on a throwaway thread has to do.
fn moment() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a live run, trimmed. The shape is the contract this screen depends on.
    const REAL_STREAM: &str = concat!(
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"RAW\",\"event\":{\"data\":{\"chunk\":{\"content\":\"391\"}}}}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"a\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"a\",\"delta\":\"3\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"a\",\"delta\":\"91\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"a\"}\n\n",
    );

    #[test]
    fn the_answer_is_the_deltas_joined() {
        assert_eq!(answer_in(REAL_STREAM).as_deref(), Some("391"));
    }

    /// The same answer rides inside `RAW` as well. Counting those would say "391391".
    #[test]
    fn the_framework_trace_is_not_counted_as_the_answer() {
        assert_eq!(answer_in(REAL_STREAM).as_deref(), Some("391"));
        assert!(
            REAL_STREAM.contains("\"type\":\"RAW\""),
            "the fixture must carry the trap"
        );
    }

    /// Measured: a rejected key ends the stream after STEP_STARTED and says nothing at all.
    #[test]
    fn a_stream_that_stops_is_not_an_empty_answer() {
        let stopped = concat!(
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
            "data: {\"type\":\"STEP_STARTED\",\"stepName\":\"answer\"}\n\n",
        );
        assert_eq!(answer_in(stopped), None);
    }

    #[test]
    fn junk_on_the_wire_does_not_stop_the_answer_being_read() {
        let messy = concat!(
            "data: not json at all\n",
            ": a comment\n",
            "\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"delta\":\"fine\"}\n",
        );
        assert_eq!(answer_in(messy).as_deref(), Some("fine"));
    }

    /// The sentence names the choice to change, and the log is kept rather than shown as the point.
    #[test]
    fn a_refused_key_is_named_as_a_key_and_not_as_a_stack_trace() {
        let log = "langchain_openai.chat_models.base.OpenAIAuthenticationError: Error code: 401";
        let problem = why_nothing_came_back(log);
        assert!(problem.said.contains("refused"), "{}", problem.said);
        assert!(
            !problem.said.contains("401"),
            "the sentence leaked the trace"
        );
        assert_eq!(problem.detail.as_deref(), Some(log));
    }

    /// Each cause the person can act on gets its own sentence, and no two are the same.
    #[test]
    fn the_causes_worth_telling_apart_are_told_apart() {
        let said = |log: &str| why_nothing_came_back(log).said;
        let quota = said("Error code: 429 - insufficient_quota");
        let model = said("The model `gpt-9` does not exist or you do not have access to it");
        let offline = said("Connection error while reaching the provider");
        let unknown = said("Traceback (most recent call last): RuntimeError: something else");
        let all = [&quota, &model, &offline, &unknown];
        for (i, one) in all.iter().enumerate() {
            for other in all.iter().skip(i + 1) {
                assert_ne!(one, other, "two causes share a sentence");
            }
        }
    }

    /// Every sentence is for the person: no jargon, and always something to do next.
    #[test]
    fn no_sentence_asks_anybody_to_read_a_log() {
        for log in [
            "401 unauthorized",
            "insufficient_quota",
            "rate limit",
            "model_not_found",
            "connection refused",
            "something nobody has seen",
        ] {
            let said = why_nothing_came_back(log).said;
            let lower = said.to_lowercase();
            for forbidden in ["stack trace", "see the logs", "server logs", "traceback"] {
                assert!(!lower.contains(forbidden), "{said}");
            }
            assert!(said.ends_with('.'), "{said}");
        }
    }

    /**
    The whole path against a running harness, which is the only thing that proves the wire format.

    Ignored, because it needs a harness and a real model credential and neither belongs in CI. Run
    it against one by hand:

    ```text
    OPENBOT_ASK_ENDPOINT=http://127.0.0.1:4288/ OPENBOT_ASK_TOKEN=... \
      cargo test --lib live_harness -- --ignored --nocapture
    ```

    Kept rather than deleted after it passed: the fixtures above are transcriptions, and a vendor
    who changes the events they emit breaks this and nothing else.
    */
    #[test]
    #[ignore = "needs a running harness and a real model credential"]
    fn live_harness_answers_the_suggested_question() {
        let endpoint = std::env::var("OPENBOT_ASK_ENDPOINT").expect("OPENBOT_ASK_ENDPOINT");
        let token = std::env::var("OPENBOT_ASK_TOKEN").expect("OPENBOT_ASK_TOKEN");
        let answer = ask(&endpoint, &token, SUGGESTED).expect("the harness did not answer");
        println!("the Bot said: {answer}");
        assert!(
            answer.contains("391"),
            "answered {answer:?}, which is not 17 x 23"
        );
    }

    /// The same path with a credential the provider refuses, which is the failure this screen owns.
    #[test]
    #[ignore = "needs a running harness holding a deliberately invalid credential"]
    fn live_harness_that_cannot_answer_produces_a_sentence_not_a_silence() {
        let endpoint = std::env::var("OPENBOT_ASK_BAD_ENDPOINT").expect("OPENBOT_ASK_BAD_ENDPOINT");
        let token = std::env::var("OPENBOT_ASK_TOKEN").expect("OPENBOT_ASK_TOKEN");
        let problem = ask(&endpoint, &token, SUGGESTED).expect_err("it answered on a bad key");
        // An empty sentence is this module saying the reason is in the log, not in the stream.
        assert!(problem.said.is_empty(), "got {problem:?}");
    }

    /// The default question has one right answer, which is the only reason it proves anything.
    #[test]
    fn the_suggested_question_is_checkable() {
        assert!(SUGGESTED.contains("17") && SUGGESTED.contains("23"));
    }
}
