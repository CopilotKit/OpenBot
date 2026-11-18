/*!
Signing in to an OpenBot that runs elsewhere, and staying signed in.

OAuth 2.1 authorization code with PKCE (S256), as a public client with a loopback redirect
(RFC 8252): a listener on `127.0.0.1` at a port the system picks, the system browser sent to the
OpenBot's authorization endpoint, and the code it sends back to `/callback` exchanged for tokens.
The PKCE verifier, the `state` and the callback's first line are read with what
`provider_oauth` already has; nothing new is done with a hash or a random number here.

A `Session` is what comes out: the access token in memory for its hour, and the refresh token in
the system's credential store (`credentials`). Refresh tokens rotate on every use and an old one
fails if it is used again, so one refresh runs at a time and the new token is stored before the old
one is let go.

Nothing here logs or returns a token, a code or a verifier. A failure's detail is a status, an
OAuth error code or a transport error.
*/

use super::address::Metadata;
use super::credentials::Store;
use super::{host_of, http, kind_of, transport, Kind, CLIENT_ID};
use crate::problem::Problem;
use crate::provider_oauth::{pkce_challenge, random, read_callback_request};
use std::io::Write;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The redirect's path. The OpenBot accepts exactly `http://127.0.0.1:<port>/callback`.
pub const CALLBACK_PATH: &str = "/callback";

/// How long the browser has to come back.
pub const WAIT: Duration = Duration::from_secs(600);

/// An access token this close to its end is replaced before it is used.
const REFRESH_BEFORE_END: Duration = Duration::from_secs(60);

/// An access token the OpenBot refused is replaced at most this often. Without it, an address
/// that answers 401 whatever the token would use a refresh token on every request.
const REFUSED_REFRESH_EVERY: Duration = Duration::from_secs(30);

/// The browser tab's heading once the sign-in has come back.
pub const SIGNED_IN_HEADING: &str = "You're signed in";
/// And its sentence. Windows may keep the browser in front of the app (`come_forward` in the
/// app), so it says where to go next.
pub const SIGNED_IN_PAGE: &str =
    "Go back to the OpenBot app to keep going. You can close this tab.";
/// The heading when the sign-in was refused or was not this app's.
pub const NOT_SIGNED_IN_HEADING: &str = "Sign-in didn't finish";
/// And its sentence.
pub const NOT_SIGNED_IN_PAGE: &str =
    "Go back to the OpenBot app to try again. You can close this tab.";
/// The heading when the person signed in and that OpenBot then refused the app (`access-refused`).
pub const NOT_LET_IN_HEADING: &str = "You signed in, but OpenBot didn't let the app in";
/// And its sentence: the app says the same, with the address.
pub const NOT_LET_IN_PAGE: &str =
    "Ask whoever runs your OpenBot to give you access, then sign in again. You can close this tab.";

/// How the browser tab's page ends the sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// Signed in, and the OpenBot serves the app to the new sign-in.
    SignedIn,
    /// Signed in, and the OpenBot then refused the app.
    NotLetIn,
    /// Refused, cancelled, not this sign-in's answer, or anything else that went wrong.
    NotSignedIn,
}

/// What the tab's answer allows the page to load: its own inline styles, and nothing else.
pub const END_PAGE_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'";

/// A sign-in that is waiting for the browser, so Cancel can end it.
#[derive(Default)]
pub struct Attempt {
    cancelled: AtomicBool,
}

impl Attempt {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// A sign-in to one OpenBot.
pub struct Session {
    address: String,
    host: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    store: Store,
    live: Mutex<Live>,
    /// Held for the whole of a refresh, so two requests that both find the token stale make one.
    refreshing: Mutex<()>,
}

struct Live {
    access: String,
    refresh: String,
    expires: Instant,
    /// When a refused access token last led to a refresh (`REFUSED_REFRESH_EVERY`).
    refreshed_after_refusal: Option<Instant>,
    ended: bool,
}

/// Never the tokens.
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("address", &self.address)
            .finish_non_exhaustive()
    }
}

struct Granted {
    access: String,
    refresh: Option<String>,
    expires_in: u64,
}

enum Refused {
    /// The request never got an answer.
    Transport(String),
    /// The OpenBot answered no: its status and its OAuth error code.
    Answer { status: u16, error: String },
}

impl Refused {
    fn detail(&self, what: &str) -> String {
        match self {
            Refused::Transport(error) => format!("{what}: {error}"),
            Refused::Answer { status, error } => format!("{what} answered {status} {error}"),
        }
    }
}

/**
Sign in to the OpenBot at `address` in the person's browser.

`open` is handed the address to open, the system browser in the app. The wait ends when the browser
comes back with a code, when the person refuses, when `attempt` is cancelled, or after `wait`.
Returns once the code is exchanged, the OpenBot has answered `/api/copilotkit/info` with the new
token, and the refresh token is in `store`. The browser tab is answered only then, with the page
for how it ended (`Ending`).
*/
pub fn sign_in(
    address: &str,
    metadata: &Metadata,
    store: Store,
    attempt: &Attempt,
    wait: Duration,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Session, Problem> {
    let host = host_of(address);
    let failed = |detail: String| Kind::SignInFailed.problem(&host, detail);
    // 127.0.0.1 only: the redirect names it, and nothing off this computer can reach it.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
        .map_err(|error| failed(format!("could not listen for the browser: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| failed(error.to_string()))?
        .port();
    let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = random();
    let state = random();
    let challenge = pkce_challenge(&verifier);
    let scope = metadata.scopes.join(" ");
    let mut authorize = reqwest::Url::parse(&metadata.authorization_endpoint)
        .map_err(|error| failed(error.to_string()))?;
    authorize.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect.as_str()),
        ("scope", scope.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    open(authorize.as_str())
        .map_err(|error| failed(format!("could not open the browser: {error}")))?;

    let (code, mut tab) = wait_for_code(&listener, &state, attempt, wait, &host)?;
    drop(listener);

    // The browser's request is held while the code is exchanged and the OpenBot is asked whether
    // it lets the app in, so the tab says what the app is about to say, not "signed in" before
    // the app knows. That takes a moment; the browser shows it as loading.
    let signed_in = finish(address, &host, metadata, store, &code, &redirect, &verifier);
    let ending = match &signed_in {
        Ok(_) => Ending::SignedIn,
        Err(problem) if kind_of(problem) == Some(Kind::AccessRefused) => Ending::NotLetIn,
        Err(_) => Ending::NotSignedIn,
    };
    page(&mut tab, "200 OK", ending);
    signed_in
}

/// The rest of a sign-in once the browser is back with a code: the exchange, the check that the
/// OpenBot serves the app to the new sign-in, and the refresh token kept. Tokens the app will not
/// use are revoked.
fn finish(
    address: &str,
    host: &str,
    metadata: &Metadata,
    store: Store,
    code: &str,
    redirect: &str,
    verifier: &str,
) -> Result<Session, Problem> {
    let host = host.to_owned();
    let failed = |detail: String| Kind::SignInFailed.problem(&host, detail);
    let granted = token_request(
        &metadata.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ],
    )
    .map_err(|refused| match refused {
        Refused::Transport(_) => {
            Kind::Unreachable.problem(&host, refused.detail("the token exchange"))
        }
        Refused::Answer { .. } => failed(refused.detail("the token exchange")),
    })?;
    let Some(refresh) = granted.refresh else {
        return Err(Kind::TooOld.problem(&host, "the token exchange gave no refresh token"));
    };
    let session = Session {
        address: address.to_owned(),
        host: host.clone(),
        token_endpoint: metadata.token_endpoint.clone(),
        revocation_endpoint: metadata.revocation_endpoint.clone(),
        store,
        live: Mutex::new(Live {
            access: granted.access,
            refresh,
            expires: Instant::now() + Duration::from_secs(granted.expires_in),
            refreshed_after_refusal: None,
            ended: false,
        }),
        refreshing: Mutex::new(()),
    };
    // The app's screens start here. An OpenBot that refuses its own new token there does not
    // let the app in (`serves_the_app`).
    if let Err(problem) = session.serves_the_app() {
        session.revoke();
        return Err(problem);
    }
    let kept = {
        let live = session.live.lock().unwrap();
        session.store.set(&session.address, &live.refresh)
    };
    if let Err(problem) = kept {
        session.revoke();
        return Err(problem);
    }
    log::info!("[connect] signed in to {host}");
    Ok(session)
}

/// The saved sign-in for `address`, made current: the stored refresh token exchanged for a new
/// access token. `session-ended` when there is none or the OpenBot no longer takes it.
pub fn resume(address: &str, metadata: &Metadata, store: Store) -> Result<Session, Problem> {
    let host = host_of(address);
    let Some(refresh) = store.get(address)? else {
        return Err(Kind::SessionEnded.problem(&host, "no sign-in is saved for this address"));
    };
    let session = Session {
        address: address.to_owned(),
        host,
        token_endpoint: metadata.token_endpoint.clone(),
        revocation_endpoint: metadata.revocation_endpoint.clone(),
        store,
        live: Mutex::new(Live {
            access: String::new(),
            refresh,
            // Already over, so the first use refreshes.
            expires: Instant::now(),
            refreshed_after_refusal: None,
            ended: false,
        }),
        refreshing: Mutex::new(()),
    };
    session.access()?;
    Ok(session)
}

impl Session {
    /// The normalised address this is a sign-in to.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The address's host, as the sentences name it.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// An access token good for at least the next minute, refreshed first when it is not.
    pub fn access(&self) -> Result<String, Problem> {
        self.current(None)
    }

    /// The OpenBot answered 401 to `used`: a newer access token, from a refresh unless another
    /// request already made one or one was made for a refusal moments ago.
    pub fn after_refused(&self, used: &str) -> Result<String, Problem> {
        self.current(Some(used))
    }

    fn ended(&self, detail: impl Into<String>) -> Problem {
        Kind::SessionEnded.problem(&self.host, detail)
    }

    fn current(&self, refused: Option<&str>) -> Result<String, Problem> {
        // Without waiting for a refresh, when the token in hand is good.
        if let Some(access) = self.usable(refused)? {
            return Ok(access);
        }
        let _one_at_a_time = self.refreshing.lock().unwrap();
        // Whoever held it may have refreshed.
        if let Some(access) = self.usable(refused)? {
            return Ok(access);
        }
        let old = self.live.lock().unwrap().refresh.clone();
        let granted = token_request(
            &self.token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &old),
                ("client_id", CLIENT_ID),
            ],
        );
        let granted = match granted {
            Ok(granted) => granted,
            Err(Refused::Transport(error)) => {
                return Err(Kind::Unreachable.problem(&self.host, format!("the refresh: {error}")))
            }
            // The OpenBot could not answer: the sign-in may still be good.
            Err(Refused::Answer { status, error }) if status >= 500 => {
                return Err(Kind::Unreachable
                    .problem(&self.host, format!("the refresh answered {status} {error}")))
            }
            Err(refused) => {
                // Signed out elsewhere, removed, or expired: this sign-in is over.
                self.live.lock().unwrap().ended = true;
                if let Err(problem) = self.store.forget(&self.address) {
                    log::warn!(
                        "[connect] could not forget the ended sign-in: {}",
                        problem.detail.unwrap_or(problem.said)
                    );
                }
                log::info!("[connect] the sign-in to {} has ended", self.host);
                return Err(self.ended(refused.detail("the refresh")));
            }
        };
        // The new refresh token is kept before the old one is let go: the old one is already
        // dead at the OpenBot, so losing the new one here would lose the sign-in.
        let refresh = granted.refresh.unwrap_or(old);
        if let Err(problem) = self.store.set(&self.address, &refresh) {
            // Still signed in for as long as the app runs; the next launch asks again.
            log::warn!(
                "[connect] could not keep the refreshed sign-in: {}",
                problem.detail.unwrap_or(problem.said)
            );
        }
        let mut live = self.live.lock().unwrap();
        live.access = granted.access.clone();
        live.refresh = refresh;
        live.expires = Instant::now() + Duration::from_secs(granted.expires_in);
        if refused.is_some() {
            live.refreshed_after_refusal = Some(Instant::now());
        }
        Ok(granted.access)
    }

    /// The access token in hand, when it can be used as it is.
    fn usable(&self, refused: Option<&str>) -> Result<Option<String>, Problem> {
        let live = self.live.lock().unwrap();
        if live.ended {
            return Err(self.ended("the sign-in has ended"));
        }
        let fresh = live.expires > Instant::now() + REFRESH_BEFORE_END;
        Ok(match refused {
            None => fresh.then(|| live.access.clone()),
            // Another request has replaced the refused one since.
            Some(used) if live.access != used => Some(live.access.clone()),
            Some(_) => live
                .refreshed_after_refusal
                .is_some_and(|at| at.elapsed() < REFUSED_REFRESH_EVERY)
                .then(|| live.access.clone()),
        })
    }

    /**
    Whether the OpenBot serves the app's screens to this sign-in: `GET /api/copilotkit/info` with
    the token.

    - 401 or 403: the person signed in, and that OpenBot does not let this sign-in in on the app's
      screens (`access-refused`). Updating OpenBot is not the way on, so it is not `too-old`.
    - 404: its release does not serve that address (`too-old`).
    - Anything else that is not a success: `sign-in-failed`.
    */
    fn serves_the_app(&self) -> Result<(), Problem> {
        let access = self.live.lock().unwrap().access.clone();
        let answered = http()
            .map_err(|error| Kind::Unreachable.problem(&self.host, error))?
            .get(format!("{}/api/copilotkit/info", self.address))
            .bearer_auth(access)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|error| Kind::Unreachable.problem(&self.host, transport(error)))?;
        let said = || {
            format!(
                "GET /api/copilotkit/info answered {} to a new sign-in",
                answered.status()
            )
        };
        match answered.status().as_u16() {
            200..=299 => Ok(()),
            401 | 403 => Err(Kind::AccessRefused.problem(&self.host, said())),
            404 => Err(Kind::TooOld.problem(&self.host, said())),
            status => Err(Kind::SignInFailed.problem(
                &self.host,
                format!("GET /api/copilotkit/info answered {status}"),
            )),
        }
    }

    /// Sign out: both tokens revoked at the OpenBot (RFC 7009), as far as it answers, then the
    /// sign-in forgotten on this computer whatever it answered.
    pub fn sign_out(&self) -> Result<(), Problem> {
        let _one_at_a_time = self.refreshing.lock().unwrap();
        self.revoke();
        self.live.lock().unwrap().ended = true;
        log::info!("[connect] signed out of {}", self.host);
        self.store.forget(&self.address)
    }

    /**
    Best effort: a token that could not be revoked ends by itself, the access token within the
    hour.

    The access token first. Revoking the refresh token also ends every access token issued with
    it (RFC 7009 §2.1; OpenBot deletes them), and OpenBot answers 400 `invalid_request` to the
    revocation of a token it no longer has, so the other order always failed on the second one.
    */
    fn revoke(&self) {
        let Some(endpoint) = &self.revocation_endpoint else {
            return;
        };
        let (access, refresh) = {
            let live = self.live.lock().unwrap();
            (live.access.clone(), live.refresh.clone())
        };
        let mut answered = true;
        for (token, hint) in [(access, "access_token"), (refresh, "refresh_token")] {
            if token.is_empty() {
                continue;
            }
            if let Err(error) = revoke_token(endpoint, &token, hint) {
                answered = false;
                log::warn!(
                    "[connect] could not revoke the {hint} at {}: {error}",
                    self.host
                );
            }
        }
        // The host only: never a token.
        if answered {
            log::info!("[connect] revoked the sign-in at {}", self.host);
        }
    }
}

/// Revoke a saved sign-in with no session around it: the stored refresh token, when the OpenBot
/// can be asked, and then forgotten either way.
pub fn sign_out_saved(
    address: &str,
    metadata: Option<&Metadata>,
    store: &Store,
) -> Result<(), Problem> {
    if let (Some(endpoint), Ok(Some(refresh))) = (
        metadata.and_then(|metadata| metadata.revocation_endpoint.as_deref()),
        store.get(address),
    ) {
        match revoke_token(endpoint, &refresh, "refresh_token") {
            Ok(()) => log::info!("[connect] revoked the sign-in at {}", host_of(address)),
            Err(error) => log::warn!(
                "[connect] could not revoke the saved sign-in at {}: {error}",
                host_of(address)
            ),
        }
    }
    store.forget(address)
}

/// One revocation (RFC 7009): form-encoded, `client_id` in the body as a public client sends it.
/// A failure says the status and the OAuth error code, and nothing the request carried.
fn revoke_token(endpoint: &str, token: &str, hint: &str) -> Result<(), String> {
    let answered = http()?
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .map_err(transport)?;
    let status = answered.status();
    if status.is_success() {
        return Ok(());
    }
    let body: serde_json::Value = answered.json().unwrap_or(serde_json::Value::Null);
    // The error code only, and only its own characters: a description may quote what was sent.
    let code: String = body
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(64)
        .collect();
    Err(if code.is_empty() {
        format!("it answered {status}")
    } else {
        format!("it answered {status} {code}")
    })
}

/// One request to the token endpoint: form-encoded, with the client's id in the body.
fn token_request(endpoint: &str, form: &[(&str, &str)]) -> Result<Granted, Refused> {
    let answered = http()
        .map_err(Refused::Transport)?
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .map_err(|error| Refused::Transport(transport(error)))?;
    let status = answered.status();
    let body: serde_json::Value = answered.json().unwrap_or(serde_json::Value::Null);
    let text = |name: &str| {
        body.get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    if !status.is_success() {
        return Err(Refused::Answer {
            status: status.as_u16(),
            // The error code only (RFC 6749 §5.2): a description may quote what was sent.
            error: text("error").unwrap_or_else(|| "with no error code".into()),
        });
    }
    let Some(access) = text("access_token") else {
        return Err(Refused::Answer {
            status: status.as_u16(),
            error: "with no access token".into(),
        });
    };
    Ok(Granted {
        access,
        refresh: text("refresh_token"),
        expires_in: body
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .filter(|seconds| *seconds > 0)
            .unwrap_or(3600),
    })
}

/// Wait for the browser to come back to the listener with this sign-in's code. The code comes
/// with the browser's request, still unanswered: the tab's page is chosen once the app knows how
/// the sign-in ended.
fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    attempt: &Attempt,
    wait: Duration,
    host: &str,
) -> Result<(String, TcpStream), Problem> {
    let deadline = Instant::now() + wait;
    loop {
        if attempt.cancelled() {
            return Err(Kind::SignInCancelled.problem(host, "cancelled in the app"));
        }
        if Instant::now() >= deadline {
            return Err(
                Kind::SignInCancelled.problem(host, "the browser did not come back in time")
            );
        }
        match listener.accept() {
            Ok((mut stream, _)) => match callback(&mut stream, state) {
                Callback::Code(code) => return Ok((code, stream)),
                Callback::Refused(error) if error == "access_denied" => {
                    return Err(Kind::SignInCancelled.problem(host, "consent was not given"))
                }
                Callback::Refused(error) => {
                    return Err(Kind::SignInFailed
                        .problem(host, format!("the sign-in came back with {error}")))
                }
                // Not this sign-in's answer. Whoever sent it does not get to end the wait.
                Callback::NotOurs => {}
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(Kind::SignInFailed
                    .problem(host, format!("could not hear from the browser: {error}")))
            }
        }
    }
}

enum Callback {
    /// This sign-in's code. The browser's request is not answered yet.
    Code(String),
    /// The OpenBot sent the browser back with an OAuth error code.
    Refused(String),
    NotOurs,
}

/// Read one request to the listener, and answer the browser tab unless it brought this sign-in's
/// code (`sign_in` answers that one).
fn callback(stream: &mut TcpStream, state: &str) -> Callback {
    let Ok(request) = read_callback_request(stream, Duration::from_secs(2)) else {
        return Callback::NotOurs;
    };
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok();
    let Some(parsed) = parsed.filter(|url| method == "GET" && url.path() == CALLBACK_PATH) else {
        page(stream, "404 Not Found", Ending::NotSignedIn);
        return Callback::NotOurs;
    };
    let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(state) {
        page(stream, "400 Bad Request", Ending::NotSignedIn);
        return Callback::NotOurs;
    }
    if let Some(error) = query.get("error") {
        page(stream, "200 OK", Ending::NotSignedIn);
        // Only the code's own characters: it goes into the log.
        return Callback::Refused(
            error
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(64)
                .collect(),
        );
    }
    match query.get("code").filter(|code| !code.is_empty()) {
        Some(code) => Callback::Code(code.clone()),
        None => {
            page(stream, "400 Bad Request", Ending::NotSignedIn);
            Callback::NotOurs
        }
    }
}

/// The browser tab's page for how the sign-in ended (`end_page`).
pub fn end_page_for(ending: Ending) -> String {
    match ending {
        Ending::SignedIn => end_page(SIGNED_IN_HEADING, SIGNED_IN_PAGE),
        Ending::NotLetIn => end_page(NOT_LET_IN_HEADING, NOT_LET_IN_PAGE),
        Ending::NotSignedIn => end_page(NOT_SIGNED_IN_HEADING, NOT_SIGNED_IN_PAGE),
    }
}

/**
The styles of the tab's page, inline: it is served by this app from 127.0.0.1 and loads nothing.
OpenBot's own tokens (`app/src/styles.css`, as the setup window copies them in `desktop/src/styles.css`):
the frame's lavender ground with a card on it, its type, its 10px radius, and the orb, OpenBot's
mark, as the setup window draws it. Light and dark follow the system, as the setup window does.
Inter when the computer has it, the system's own face otherwise: a font is a file, and this page
fetches none.
*/
const END_PAGE_STYLE: &str = r#"
:root {
  --background: oklch(0.983 0.003 286.4);
  --foreground: oklch(0.108 0.015 220.9);
  --card: oklch(1 0 0);
  --muted-foreground: oklch(0.506 0.013 285.9);
  --border: oklch(0.894 0.014 286.1);
  --sidebar: oklch(0.948 0.011 286.2);
  --radius: 0.625rem;
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.182 0.023 296.6);
    --foreground: oklch(0.956 0.005 286.3);
    --card: oklch(0.212 0.028 297.1);
    --muted-foreground: oklch(0.69 0.017 285.9);
    --border: oklch(0.28 0.035 298.6);
    --sidebar: oklch(0.156 0.017 295.8);
    --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.4), 0 1px 2px -1px rgb(0 0 0 / 0.4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--sidebar);
  color: var(--foreground);
  font-family: "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
main {
  width: 100%;
  max-width: 26rem;
  padding: 36px 32px 32px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 1.4);
  box-shadow: var(--shadow);
  text-align: center;
}
.orb {
  --c1: oklch(68% 0.21 350);
  --c2: oklch(70% 0.18 210);
  --c3: oklch(66% 0.2 285);
  --c4: oklch(72% 0.19 325);
  width: 56px;
  height: 56px;
  margin: 0 auto 20px;
  border-radius: 50%;
  position: relative;
  isolation: isolate;
  overflow: hidden;
  flex: none;
  background:
    radial-gradient(circle at 78% 22%, var(--c1), transparent 58%),
    radial-gradient(circle at 26% 72%, var(--c3), transparent 60%),
    radial-gradient(circle at 46% 78%, var(--c2), transparent 55%),
    radial-gradient(circle at 62% 38%, var(--c4), transparent 62%);
  filter: saturate(0.9);
}
.orb::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle at 30% 24%, hsl(0 0% 100% / 0.32), transparent 34%),
    radial-gradient(circle at 72% 80%, hsl(0 0% 100% / 0.07), transparent 48%);
  mix-blend-mode: screen;
}
.orb::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 0 0 1px hsl(0 0% 100% / 0.16),
    inset 0 2px 4px hsl(0 0% 100% / 0.22);
}
h1 {
  margin: 0 0 8px;
  font-size: 1.40625rem;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.015em;
}
p {
  margin: 0;
  color: var(--muted-foreground);
}
"#;

/// The tab's page: OpenBot's orb on a card, a heading, and a sentence. No script, and
/// nothing loaded from anywhere (`END_PAGE_STYLE`, `END_PAGE_POLICY`).
pub fn end_page(heading: &str, sentence: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"color-scheme\" content=\"light dark\"><title>OpenBot</title>\
         <style>{END_PAGE_STYLE}</style></head><body><main>\
         <div class=\"orb\" aria-hidden=\"true\"></div>\
         <h1>{heading}</h1><p>{sentence}</p></main></body></html>"
    )
}

/// Answer the browser tab with its page, which loads nothing (`END_PAGE_POLICY`).
fn page(stream: &mut TcpStream, status: &str, ending: Ending) {
    let body = end_page_for(ending);
    // A tab closed meanwhile does not hold the app up.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
             Content-Security-Policy: {END_PAGE_POLICY}\r\n\
             Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::super::credentials::in_memory;
    use super::super::fake_openbot::{Browser, FakeOpenBot, Shape};
    use super::super::kind_of;
    use super::*;
    use std::sync::Arc;

    fn check(openbot: &FakeOpenBot) -> (String, Metadata) {
        super::super::address::check(&openbot.address()).unwrap()
    }

    /// The whole sign-in, as a person does it: the browser goes to the OpenBot, they approve,
    /// the tab says they are signed in, and the app holds a sign-in that OpenBot honours.
    #[test]
    fn a_full_sign_in_ends_with_a_session_and_the_refresh_token_in_the_store() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (address, metadata) = check(&openbot);
        let store = in_memory();
        let browser = Browser::approves();
        let session = sign_in(
            &address,
            &metadata,
            store.clone(),
            &Attempt::default(),
            Duration::from_secs(20),
            browser.opener(),
        )
        .unwrap();

        // What the browser was sent to ask for.
        let asked = browser.asked();
        assert_eq!(asked["client_id"], "openbot-desktop-oauth");
        assert_eq!(asked["response_type"], "code");
        assert_eq!(asked["code_challenge_method"], "S256");
        assert!(asked["state"].len() >= 32);
        let redirect = reqwest::Url::parse(&asked["redirect_uri"]).unwrap();
        assert_eq!(redirect.host_str(), Some("127.0.0.1"));
        assert_eq!(redirect.path(), "/callback");
        assert!(redirect.port().is_some());
        let scopes: Vec<&str> = asked["scope"].split(' ').collect();
        assert_eq!(scopes, metadata.scopes);
        assert!(scopes.contains(&"offline_access"));
        // What the tab said, on a page that may load nothing but its own styles.
        let tab = browser.tab();
        assert!(tab.contains(SIGNED_IN_PAGE), "{tab}");
        assert!(
            tab.contains(&format!("<h1>{SIGNED_IN_HEADING}</h1>")),
            "{tab}"
        );
        assert!(
            tab.contains(&format!(
                "\r\nContent-Security-Policy: {END_PAGE_POLICY}\r\n"
            )),
            "{tab}"
        );

        // The access token is one that OpenBot honours, and only the refresh token is stored.
        let access = session.access().unwrap();
        assert!(access.starts_with("oba_"));
        assert!(openbot.honours(&access));
        let stored = store.get(&address).unwrap().unwrap();
        assert!(stored.starts_with("obr_"));
        assert_ne!(stored, access);
        // The exchange was form-encoded with the client's id in the body, and no secret.
        let exchange = openbot.token_requests().remove(0);
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["client_id"], "openbot-desktop-oauth");
        assert_eq!(exchange["redirect_uri"], asked["redirect_uri"]);
        assert!(!exchange.contains_key("client_secret"));
    }

    /// A request to the listener with another `state` is not this sign-in's answer: it is refused,
    /// no code is exchanged for it, and the real answer still completes the sign-in.
    #[test]
    fn a_callback_with_the_wrong_state_is_refused_and_exchanges_nothing() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (address, metadata) = check(&openbot);
        let browser = Browser::forges_state_first();
        let session = sign_in(
            &address,
            &metadata,
            in_memory(),
            &Attempt::default(),
            Duration::from_secs(20),
            browser.opener(),
        )
        .unwrap();
        let forged = browser.forged_answer();
        assert!(forged.starts_with("HTTP/1.1 400"), "{forged}");
        assert!(forged.contains(NOT_SIGNED_IN_PAGE), "{forged}");
        // One exchange, for the real code; the forged one never reached the token endpoint.
        assert_eq!(openbot.token_requests().len(), 1);
        assert!(openbot.honours(&session.access().unwrap()));
    }

    /// The tab's pages are OpenBot's: its orb and name on a card, in light and dark as the
    /// system is, saying what happened and what to do next. Served by this app from
    /// 127.0.0.1, so everything is inline: no script, no stylesheet, font or image from anywhere.
    #[test]
    fn the_tabs_pages_look_like_openbot_and_load_nothing_from_anywhere() {
        for (ending, heading, sentence) in [
            (Ending::SignedIn, SIGNED_IN_HEADING, SIGNED_IN_PAGE),
            (Ending::NotLetIn, NOT_LET_IN_HEADING, NOT_LET_IN_PAGE),
            (
                Ending::NotSignedIn,
                NOT_SIGNED_IN_HEADING,
                NOT_SIGNED_IN_PAGE,
            ),
        ] {
            let html = end_page_for(ending);
            assert!(html.starts_with("<!doctype html>"), "{html}");
            assert!(html.contains(&format!("<h1>{heading}</h1>")), "{html}");
            assert!(html.contains(&format!("<p>{sentence}</p>")), "{html}");
            if ending != Ending::NotLetIn {
                assert!(
                    sentence.contains("Go back to the OpenBot app"),
                    "{sentence}"
                );
            }
            assert!(!heading.contains('\u{2014}') && !sentence.contains('\u{2014}'));
            assert!(html.contains("<title>OpenBot</title>"), "{html}");
            assert!(html.contains("class=\"orb\""), "{html}");
            assert!(
                html.contains("@media (prefers-color-scheme: dark)"),
                "{html}"
            );
            for outside in [
                "<script", "src=", "href=", "url(", "@import", "http:", "https:", "<link",
            ] {
                assert!(!html.contains(outside), "{outside} in {html}");
            }
        }
    }

    /// Writes the tab's pages, exactly as `page` serves them, under the build folder
    /// (`target/end-pages`) for a look in a browser. Run on purpose: `--ignored`.
    #[test]
    #[ignore]
    fn write_the_tabs_pages_for_a_look() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/end-pages");
        std::fs::create_dir_all(&folder).unwrap();
        for (name, ending) in [
            ("signed-in.html", Ending::SignedIn),
            ("not-let-in.html", Ending::NotLetIn),
            ("not-signed-in.html", Ending::NotSignedIn),
        ] {
            std::fs::write(folder.join(name), end_page_for(ending)).unwrap();
        }
    }

    #[test]
    fn consent_denied_reads_as_a_sign_in_that_did_not_finish() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (address, metadata) = check(&openbot);
        let store = in_memory();
        let browser = Browser::denies();
        let problem = sign_in(
            &address,
            &metadata,
            store.clone(),
            &Attempt::default(),
            Duration::from_secs(20),
            browser.opener(),
        )
        .expect_err("consent was denied");
        assert_eq!(kind_of(&problem), Some(Kind::SignInCancelled));
        assert_eq!(
            problem.said,
            "Sign-in didn't finish. Try again when you're ready."
        );
        assert!(browser.tab().contains(NOT_SIGNED_IN_PAGE));
        assert_eq!(openbot.token_requests().len(), 0);
        assert_eq!(store.get(&address).unwrap(), None);
    }

    #[test]
    fn cancel_and_a_browser_that_never_comes_back_both_end_the_wait() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (address, metadata) = check(&openbot);
        // Cancel, while the browser is open and nothing has come back.
        let attempt = Arc::new(Attempt::default());
        let cancelling = attempt.clone();
        let started = Instant::now();
        let problem = sign_in(
            &address,
            &metadata,
            in_memory(),
            &attempt,
            Duration::from_secs(30),
            move |_| {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    cancelling.cancel();
                });
                Ok(())
            },
        )
        .expect_err("cancelled");
        assert_eq!(kind_of(&problem), Some(Kind::SignInCancelled));
        assert!(started.elapsed() < Duration::from_secs(10));

        // The wait running out, here after a moment in place of ten minutes.
        let problem = sign_in(
            &address,
            &metadata,
            in_memory(),
            &Attempt::default(),
            Duration::from_millis(300),
            |_| Ok(()),
        )
        .expect_err("timed out");
        assert_eq!(kind_of(&problem), Some(Kind::SignInCancelled));
        assert_eq!(WAIT, Duration::from_secs(600));
    }

    /// The OpenBot signs the person in, and then the app's first call with the new token
    /// (`/api/copilotkit/info`) is refused. 401 and 403 are that OpenBot not letting this sign-in
    /// in: the person is told so, with who to ask. Only 404, an address its release does not serve,
    /// is a release this app cannot connect to. Either way the browser tab says the same as the
    /// app, both tokens are revoked while they still work, and nothing is kept.
    #[test]
    fn a_new_sign_in_refused_on_the_first_call_says_why_in_the_app_and_the_tab() {
        for (status, kind, ending) in [
            (401, Kind::AccessRefused, Ending::NotLetIn),
            (403, Kind::AccessRefused, Ending::NotLetIn),
            (404, Kind::TooOld, Ending::NotSignedIn),
        ] {
            let openbot = FakeOpenBot::start(Shape::InfoAnswers(status));
            let (address, metadata) = check(&openbot);
            let store = in_memory();
            let browser = Browser::approves();
            let problem = sign_in(
                &address,
                &metadata,
                store.clone(),
                &Attempt::default(),
                Duration::from_secs(20),
                browser.opener(),
            )
            .expect_err("refused");
            assert_eq!(kind_of(&problem), Some(kind), "{status}");
            assert_eq!(problem.said, kind.said(&host_of(&address)), "{status}");
            assert!(
                problem
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains(&status.to_string())),
                "{status}: {:?}",
                problem.detail
            );

            // The tab was answered once the app knew, and says what the app says.
            let tab = browser.tab();
            assert!(tab.starts_with("HTTP/1.1 200"), "{tab}");
            assert!(tab.contains(&end_page_for(ending)), "{status}: {tab}");
            assert!(!tab.contains(SIGNED_IN_HEADING), "{status}: {tab}");

            assert_eq!(store.get(&address).unwrap(), None);
            assert_eq!(openbot.live_tokens(), 0, "the unused sign-in was revoked");
            assert_eq!(
                openbot.revoke_ended(),
                [true, true],
                "{status}: each revocation ended a token that still worked"
            );
        }
    }

    /// Sign-out against an OpenBot whose revocation fails: the failure is only logged, and the
    /// sign-in is still forgotten on this computer.
    #[test]
    fn sign_out_forgets_the_sign_in_when_the_openbot_cannot_revoke_it() {
        let openbot = FakeOpenBot::start(Shape::RevokeBroken);
        let store = in_memory();
        let session = openbot.sign_in(store.clone());
        assert!(store.get(&openbot.address()).unwrap().is_some());
        session.sign_out().unwrap();
        assert_eq!(openbot.revoke_requests().len(), 2);
        assert_eq!(store.get(&openbot.address()).unwrap(), None);
        assert!(session.access().is_err());
    }

    /// The fake checks S256 as the real one does: a code presented with another verifier is
    /// refused and burns, so the exchange that follows with the right one fails too.
    #[test]
    fn the_fake_openbot_really_checks_the_verifier_and_burns_the_code() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (_, metadata) = check(&openbot);
        let verifier = random();
        let redirect = "http://127.0.0.1:49152/callback";
        let code = openbot.issue_code(&pkce_challenge(&verifier), redirect);
        let exchange = |verifier: &str, redirect: &str| {
            token_request(
                &metadata.token_endpoint,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("redirect_uri", redirect),
                    ("client_id", CLIENT_ID),
                    ("code_verifier", verifier),
                ],
            )
        };
        let refused = |result: Result<Granted, Refused>| match result {
            Err(Refused::Answer { status, error }) => (status, error),
            _ => panic!("the exchange was not refused"),
        };
        assert_eq!(
            refused(exchange(&random(), redirect)),
            (400, "invalid_grant".into())
        );
        assert_eq!(
            refused(exchange(&verifier, redirect)),
            (400, "invalid_grant".into()),
            "the code burned on the wrong verifier"
        );
        // Another redirect than the one the code was issued for, and a redirect by name.
        let code = openbot.issue_code(&pkce_challenge(&verifier), redirect);
        let other = token_request(
            &metadata.token_endpoint,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", "http://127.0.0.1:49153/callback"),
                ("client_id", CLIENT_ID),
                ("code_verifier", &verifier),
            ],
        );
        assert_eq!(refused(other), (400, "invalid_grant".into()));
        assert!(openbot
            .authorize_refuses("http://localhost:49152/callback")
            .contains("redirect_uri"));
        assert!(openbot
            .authorize_refuses("http://127.0.0.1:49152/oauth/callback")
            .contains("redirect_uri"));
    }

    /// Refresh tokens rotate: after a refresh the store holds the new one, the old one no longer
    /// works, and OpenBot honours the new access token.
    #[test]
    fn a_refresh_rotates_and_the_store_holds_the_new_token() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let session = openbot.sign_in(store.clone());
        let address = openbot.address();
        let first_access = session.access().unwrap();
        let first_refresh = store.get(&address).unwrap().unwrap();

        openbot.expire_access_tokens();
        let second_access = session.after_refused(&first_access).unwrap();
        assert_ne!(second_access, first_access);
        assert!(openbot.honours(&second_access));
        let second_refresh = store.get(&address).unwrap().unwrap();
        assert_ne!(second_refresh, first_refresh);
        assert!(second_refresh.starts_with("obr_"));

        // The next launch picks the sign-in up from the store alone.
        let (_, metadata) = check(&openbot);
        let resumed = resume(&address, &metadata, store.clone()).unwrap();
        assert!(openbot.honours(&resumed.access().unwrap()));

        // The old refresh token, used again, is refused as the real OpenBot refuses it.
        let replayed = token_request(
            &metadata.token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_refresh),
                ("client_id", CLIENT_ID),
            ],
        );
        assert!(matches!(
            replayed,
            Err(Refused::Answer { status: 400, ref error }) if error == "invalid_grant"
        ));
    }

    /// Two requests find the same token refused at the same moment. One refresh is made: a second
    /// would present a refresh token the first already used up, and end the sign-in.
    #[test]
    fn two_refreshes_at_once_make_one_request() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let session = Arc::new(openbot.sign_in(in_memory()));
        let stale = session.access().unwrap();
        openbot.expire_access_tokens();
        openbot.slow_token_endpoint(Duration::from_millis(300));
        let before = openbot.token_requests().len();

        let together = Arc::new(std::sync::Barrier::new(2));
        let refreshes: Vec<_> = (0..2)
            .map(|_| {
                let (session, stale, together) = (session.clone(), stale.clone(), together.clone());
                std::thread::spawn(move || {
                    together.wait();
                    session.after_refused(&stale).unwrap()
                })
            })
            .collect();
        let tokens: Vec<String> = refreshes
            .into_iter()
            .map(|refresh| refresh.join().unwrap())
            .collect();
        assert_eq!(tokens[0], tokens[1]);
        assert_ne!(tokens[0], stale);
        assert_eq!(openbot.token_requests().len() - before, 1);
        assert!(openbot.honours(&tokens[0]));
    }

    /// A refresh the OpenBot refuses ends the sign-in: the problem says so, and the stored token
    /// is forgotten, so the next launch asks the person to sign in.
    #[test]
    fn a_refused_refresh_ends_the_session_and_forgets_it() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let session = openbot.sign_in(store.clone());
        let access = session.access().unwrap();
        openbot.end_sessions();
        let problem = session.after_refused(&access).expect_err("ended");
        assert_eq!(kind_of(&problem), Some(Kind::SessionEnded));
        assert_eq!(
            problem.said,
            format!(
                "Your sign-in to {} has ended. Sign in again to keep going.",
                session.host()
            )
        );
        assert_eq!(store.get(&openbot.address()).unwrap(), None);
        assert_eq!(
            kind_of(&session.access().expect_err("still ended")),
            Some(Kind::SessionEnded)
        );
    }

    /// Sign-out revokes both tokens at the OpenBot, then forgets the sign-in here. The access
    /// token goes first: revoking the refresh token also ends the access tokens issued with it,
    /// and the OpenBot answers 400 to a revocation of a token it no longer has.
    #[test]
    fn sign_out_revokes_each_token_while_it_still_works_then_forgets() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let session = openbot.sign_in(store.clone());
        let access = session.access().unwrap();
        let refresh = store.get(&openbot.address()).unwrap().unwrap();
        assert_eq!(openbot.live_tokens(), 2);

        session.sign_out().unwrap();

        let revoked = openbot.revoke_requests();
        assert_eq!(revoked.len(), 2);
        assert_eq!(revoked[0]["token"], access);
        assert_eq!(revoked[0]["token_type_hint"], "access_token");
        assert_eq!(revoked[1]["token"], refresh);
        assert_eq!(revoked[1]["token_type_hint"], "refresh_token");
        assert_eq!(openbot.revoke_ended(), [true, true]);
        assert!(revoked
            .iter()
            .all(|request| request["client_id"] == "openbot-desktop-oauth"));
        assert_eq!(openbot.live_tokens(), 0);
        assert!(!openbot.honours(&access));
        assert_eq!(store.get(&openbot.address()).unwrap(), None);
        assert!(session.access().is_err());
    }

    /// Nothing shaped like a token reaches a file under the app's configuration folder or a line
    /// of the log, through a sign-in, a refresh, a refused refresh and a sign-out.
    #[test]
    fn no_token_is_written_to_the_configuration_folder_or_the_log() {
        if crate::test_support::isolated_process(
            "connected::sign_in::tests::no_token_is_written_to_the_configuration_folder_or_the_log",
        ) {
            return;
        }
        // Every line any crate logs in this process, as written, before any scrubbing.
        struct Captured(Mutex<Vec<String>>);
        impl log::Log for Captured {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, record: &log::Record) {
                self.0.lock().unwrap().push(record.args().to_string());
            }
            fn flush(&self) {}
        }
        let captured: &'static Captured = Box::leak(Box::new(Captured(Mutex::new(Vec::new()))));
        log::set_logger(captured).expect("nothing else logs in this process");
        log::set_max_level(log::LevelFilter::Trace);

        let config = crate::test_support::temp_root("connected-no-token");
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let session = openbot.sign_in(store.clone());
        let address = openbot.address();
        super::super::choice::write(
            &config,
            &super::super::choice::Choice {
                mode: super::super::choice::Mode::Connected,
                address: Some(address.clone()),
                organization_id: None,
            },
        )
        .unwrap();
        let mut tokens = vec![
            session.access().unwrap(),
            store.get(&address).unwrap().unwrap(),
        ];
        openbot.expire_access_tokens();
        tokens.push(session.after_refused(&tokens[0]).unwrap());
        tokens.push(store.get(&address).unwrap().unwrap());
        session.sign_out().unwrap();
        // And a sign-in that ends by being refused.
        let session = openbot.sign_in(store.clone());
        tokens.push(session.access().unwrap());
        tokens.push(store.get(&address).unwrap().unwrap());
        openbot.end_sessions();
        session.after_refused(&tokens[4]).expect_err("ended");
        // And a saved sign-in revoked with no session around it, as sign-out at launch does.
        let saved = openbot.sign_in(store.clone());
        tokens.push(saved.access().unwrap());
        tokens.push(store.get(&address).unwrap().unwrap());
        sign_out_saved(&address, Some(&openbot.metadata()), &store).unwrap();

        let lines = captured.0.lock().unwrap().join("\n");
        assert!(lines.contains("[connect] signed in to"), "{lines}");
        // Each revocation the OpenBot answered says so, once: the sign-out and the saved one.
        let revoked = format!("[connect] revoked the sign-in at {}", host_of(&address));
        assert_eq!(lines.matches(revoked.as_str()).count(), 2, "{lines}");
        for token in &tokens {
            assert!(!lines.contains(token.as_str()), "a token was logged");
        }
        assert!(
            !lines.contains("oba_") && !lines.contains("obr_"),
            "{lines}"
        );
        let mut files = 0;
        for entry in std::fs::read_dir(&config).unwrap() {
            let written = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            files += 1;
            assert!(
                !written.contains("oba_") && !written.contains("obr_"),
                "{written}"
            );
        }
        assert_eq!(files, 1, "only connection.json is written");
        let _ = std::fs::remove_dir_all(config);
    }
}
