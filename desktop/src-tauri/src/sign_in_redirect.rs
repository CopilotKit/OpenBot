/*!
Catching a provider's sign-in redirect for OpenBot's page, while OpenBot Cloud's server runs the
sign-in.

The server starts the OAuth and exchanges the code; the provider sends the person's browser back to
`localhost`, where only this computer can listen. So the page asks Desktop to listen
(`begin`), tells it the state the server's sign-in carries (`wait`), and hands the code it gets on
to the server. Nothing has to be copied and pasted. The code passes through here once, and is never
logged, kept or shown on a page.

- anthropic: any loopback port, path `/callback`, as Claude Code's own client registers.
- openai: port 1455 on both loopbacks, path `/auth/callback`: ChatGPT's client registered exactly
  `http://localhost:1455/auth/callback`. Busy when something else has it (the Codex CLI, or Desktop's
  own ChatGPT plan sign-in), and then the page falls back to the paste.

Desktop's own ChatGPT plan sign-in (`plan`) holds 1455 too. The two never take it from each other
mid-sign-in: a plan sign-in in progress makes `begin` refuse, and the page `plan` leaves on the port
after one (`plan::make_way_for_sign_in_redirect`) gives way. A plan sign-in that starts while a
redirect waits on 1455 stops the wait (`release_port`), as it stops anything else of its own there.
*/

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::loopback_redirect::{BindError, Ended, Listener, Outcome};

/// ChatGPT's registered loopback port and path.
pub const OPENAI_PORT: u16 = 1455;
const OPENAI_PATH: &str = "/auth/callback";
const ANTHROPIC_PATH: &str = "/callback";

/// How long a redirect is waited for.
const PATIENCE: Duration = Duration::from_secs(15 * 60);

/// A listener begun and never waited on goes after this long, so a page that went away doesn't
/// keep a port forever.
const UNCLAIMED_FOR: Duration = Duration::from_secs(20 * 60);

const BUSY: &str =
    "Another ChatGPT sign-in is already waiting on this computer. Finish or close it, then try again.";
const COULDNT_LISTEN: &str = "OpenBot couldn't wait for the sign-in on this computer. Try again.";
const UNKNOWN_PROVIDER: &str = "OpenBot can't wait for that provider's sign-in on this computer.";
const NOT_WAITING: &str = "That sign-in is no longer waiting. Start it again.";
const STOPPED: &str = "The sign-in was stopped. Start it again.";
const TOOK_TOO_LONG: &str = "The sign-in took too long. Start it again.";
const PORT_WANTED: &str = "Another app on this computer took over the sign-in. Start it again.";

/// What `begin` answers: the attempt to wait on, and the port the provider sends the browser to.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub attempt_id: String,
    pub port: u16,
}

/// What `wait` answers: the code or the provider's error, and the state they came back with.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Redirected {
    pub code: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

struct Attempt {
    port: u16,
    fixed: bool,
    begun: Instant,
    listener: Mutex<Option<Listener>>,
    cancelled: AtomicBool,
}

static ATTEMPTS: Mutex<Option<HashMap<String, Arc<Attempt>>>> = Mutex::new(None);

fn with_attempts<T>(change: impl FnOnce(&mut HashMap<String, Arc<Attempt>>) -> T) -> T {
    let mut held = ATTEMPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    change(held.get_or_insert_with(HashMap::new))
}

/// Start listening for `provider`'s redirect.
pub fn begin(provider: &str) -> Result<Begun, String> {
    // Listeners nobody came back for.
    with_attempts(|attempts| {
        attempts.retain(|_, attempt| {
            let keep = attempt.begun.elapsed() < UNCLAIMED_FOR
                || attempt.listener.lock().unwrap().is_none();
            if !keep {
                attempt.cancelled.store(true, Ordering::SeqCst);
            }
            keep
        })
    });
    let (listener, fixed) = match provider {
        "anthropic" => (
            Listener::on_any_port(ANTHROPIC_PATH).map_err(|_| COULDNT_LISTEN.to_string())?,
            false,
        ),
        "openai" => {
            // A redirect this page asked for earlier gives way to the newer one.
            release_port(OPENAI_PORT);
            if crate::plan::make_way_for_sign_in_redirect().is_err() {
                return Err(BUSY.into());
            }
            match Listener::on_port(OPENAI_PORT, OPENAI_PATH) {
                Ok(listener) => (listener, true),
                Err(BindError::Busy) => return Err(BUSY.into()),
                Err(BindError::Failed(_)) => return Err(COULDNT_LISTEN.into()),
            }
        }
        _ => return Err(UNKNOWN_PROVIDER.into()),
    };
    let attempt_id = crate::provider_oauth::random();
    let port = listener.port();
    with_attempts(|attempts| {
        attempts.insert(
            attempt_id.clone(),
            Arc::new(Attempt {
                port,
                fixed,
                begun: Instant::now(),
                listener: Mutex::new(Some(listener)),
                cancelled: AtomicBool::new(false),
            }),
        )
    });
    Ok(Begun { attempt_id, port })
}

/**
Wait for the redirect whose state is `state`, and answer the browser: OpenBot has the sign-in, close
the tab. Every other request is answered and the wait goes on. `arrived` runs once the one that
matches is answered, to bring OpenBot forward.
*/
pub fn wait(attempt_id: &str, state: &str, arrived: impl FnOnce()) -> Result<Redirected, String> {
    let attempt = with_attempts(|attempts| attempts.get(attempt_id).cloned())
        .ok_or_else(|| NOT_WAITING.to_string())?;
    let listener = attempt
        .listener
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| NOT_WAITING.to_string())?;
    let waited = listener.wait(state, PATIENCE, &|| {
        attempt.cancelled.load(Ordering::SeqCst)
    });
    // The port goes with the answer: RFC 8252 section 8.3.
    drop(listener);
    with_attempts(|attempts| {
        if attempts
            .get(attempt_id)
            .is_some_and(|held| Arc::ptr_eq(held, &attempt))
        {
            attempts.remove(attempt_id);
        }
    });
    let (outcome, reply) = waited.map_err(|ended| {
        match ended {
            Ended::Cancelled => STOPPED,
            Ended::TimedOut => TOOK_TOO_LONG,
            Ended::PortWanted => PORT_WANTED,
            Ended::Failed(_) => COULDNT_LISTEN,
        }
        .to_string()
    })?;
    let redirected = match outcome {
        Outcome::Code { code, state } => {
            reply.page(
                "200 OK",
                "OpenBot has your sign-in",
                &["You can close this tab and go back to OpenBot."],
            );
            Redirected {
                code: Some(code),
                state,
                error: None,
            }
        }
        Outcome::Error { error, state } => {
            reply.page(
                "200 OK",
                "This sign-in didn't finish",
                &["You can close this tab and go back to OpenBot to try again."],
            );
            Redirected {
                code: None,
                state,
                error: Some(error),
            }
        }
    };
    arrived();
    Ok(redirected)
}

/// Stop waiting. Whoever waits hears it stopped, and the port is given back.
pub fn cancel(attempt_id: &str) {
    if let Some(attempt) = with_attempts(|attempts| attempts.remove(attempt_id)) {
        attempt.cancelled.store(true, Ordering::SeqCst);
        // Not waited on yet: let the port go now.
        attempt.listener.lock().unwrap().take();
    }
}

/// Stop every redirect held on `port`, and return once the port is free. For a newer sign-in that
/// needs it: another redirect, or Desktop's own ChatGPT plan sign-in.
pub fn release_port(port: u16) {
    let held: Vec<Arc<Attempt>> = with_attempts(|attempts| {
        let ids: Vec<String> = attempts
            .iter()
            .filter(|(_, attempt)| attempt.fixed && attempt.port == port)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| attempts.remove(id)).collect()
    });
    for attempt in held {
        attempt.cancelled.store(true, Ordering::SeqCst);
        attempt.listener.lock().unwrap().take();
        // A wait in progress holds the listener itself, and lets go within a poll.
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(2)
            && std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
        {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loopback_redirect::tests::browser_get;

    /// Port 1455 is one port on the whole machine: the tests that use it take turns, with every
    /// other test that binds ports.
    fn hold_1455() -> (
        std::sync::MutexGuard<'static, ()>,
        std::sync::MutexGuard<'static, ()>,
    ) {
        (
            crate::plan::tests::CALLBACK_PORT
                .lock()
                .unwrap_or_else(|held| held.into_inner()),
            crate::test_support::hold_ports(),
        )
    }

    #[test]
    fn an_anthropic_redirect_is_caught_on_a_random_port_and_the_page_says_openbot_has_it() {
        let begun = begin("anthropic").unwrap();
        assert_ne!(begun.port, 0);
        let port = begun.port;
        let browser = std::thread::spawn(move || {
            let stale = browser_get(port, "/callback?code=ac.stale&state=earlier");
            let ours = browser_get(port, "/callback?code=ac.ours&state=the-state");
            (stale, ours)
        });
        let mut came_forward = false;
        let redirected = wait(&begun.attempt_id, "the-state", || came_forward = true).unwrap();
        assert_eq!(
            redirected,
            Redirected {
                code: Some("ac.ours".into()),
                state: "the-state".into(),
                error: None
            }
        );
        assert!(came_forward);
        let (stale, ours) = browser.join().unwrap();
        assert!(stale.starts_with("HTTP/1.1 400"), "{stale}");
        assert!(stale.contains("This sign-in link is out of date"));
        assert!(ours.starts_with("HTTP/1.1 200"), "{ours}");
        assert!(ours.contains("OpenBot has your sign-in"));
        assert!(!ours.contains("ac.ours"), "a page must never echo a code");
        // Answered, and the port given back.
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert_eq!(
            wait(&begun.attempt_id, "the-state", || {}),
            Err(NOT_WAITING.to_string())
        );
    }

    #[test]
    fn a_provider_error_comes_back_with_its_state() {
        let begun = begin("anthropic").unwrap();
        let port = begun.port;
        let browser =
            std::thread::spawn(move || browser_get(port, "/callback?error=access_denied&state=s1"));
        let redirected = wait(&begun.attempt_id, "s1", || {}).unwrap();
        assert_eq!(redirected.code, None);
        assert_eq!(redirected.error.as_deref(), Some("access_denied"));
        assert_eq!(redirected.state, "s1");
        assert!(browser
            .join()
            .unwrap()
            .contains("This sign-in didn't finish"));
    }

    #[test]
    fn a_cancel_ends_the_wait() {
        let begun = begin("anthropic").unwrap();
        let id = begun.attempt_id.clone();
        let waiting = std::thread::spawn(move || wait(&id, "s", || {}));
        std::thread::sleep(Duration::from_millis(200));
        cancel(&begun.attempt_id);
        assert_eq!(waiting.join().unwrap(), Err(STOPPED.to_string()));
    }

    #[test]
    fn an_unknown_provider_is_refused() {
        assert_eq!(begin("google").unwrap_err(), UNKNOWN_PROVIDER);
    }

    /**
    ChatGPT's redirect on 1455, over real TCP: caught on the registered path. While something else
    holds the port, `begin` refuses with a sentence and the page falls back to the paste.
    */
    #[test]
    fn an_openai_redirect_is_caught_on_1455_and_a_busy_port_is_refused() {
        let _port = hold_1455();
        let begun = begin("openai").unwrap();
        assert_eq!(begun.port, OPENAI_PORT);
        let browser = std::thread::spawn(|| {
            browser_get(
                OPENAI_PORT,
                "/auth/callback?code=ac.chatgpt&scope=openid&state=st",
            )
        });
        let redirected = wait(&begun.attempt_id, "st", || {}).unwrap();
        assert_eq!(redirected.code.as_deref(), Some("ac.chatgpt"));
        assert!(browser.join().unwrap().contains("OpenBot has your sign-in"));

        // The Codex CLI, or another sign-in, on the port.
        let codex = std::net::TcpListener::bind(("127.0.0.1", OPENAI_PORT)).unwrap();
        assert_eq!(begin("openai").unwrap_err(), BUSY);
        drop(codex);

        // A newer redirect for the same page takes the port from the older one.
        let older = begin("openai").unwrap();
        let older_id = older.attempt_id.clone();
        let older_waiting = std::thread::spawn(move || wait(&older_id, "old", || {}));
        std::thread::sleep(Duration::from_millis(200));
        let newer = begin("openai").unwrap();
        assert_eq!(older_waiting.join().unwrap(), Err(STOPPED.to_string()));
        cancel(&newer.attempt_id);
    }

    /// The Codex CLI asks for 1455 back with GET /cancel. It gets it, and the wait says so.
    #[test]
    fn the_codex_cli_can_ask_for_1455_back() {
        let _port = hold_1455();
        let begun = begin("openai").unwrap();
        let browser = std::thread::spawn(|| browser_get(OPENAI_PORT, "/cancel"));
        assert_eq!(
            wait(&begun.attempt_id, "st", || {}),
            Err(PORT_WANTED.to_string())
        );
        assert!(browser.join().unwrap().starts_with("HTTP/1.1 200"));
        std::net::TcpListener::bind(("127.0.0.1", OPENAI_PORT)).expect("the port was given back");
    }
}
