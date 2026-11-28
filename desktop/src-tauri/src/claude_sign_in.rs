/*!
Signing in to a Claude plan, so nobody has to hold an API key.

This is the default path on the model screen: anybody with a key and a base URL to hand is a
developer, and everybody else has a plan they already pay for.

THE FLOW IS NATIVE, AND IT FINISHES ON ITS OWN. It is the OAuth `claude setup-token` runs, with
Claude Code's own public client: PKCE, a state, consent at claude.com, and a code exchanged for a
plan token (`sk-ant-oat01-…`) that lasts a year. The browser comes back to a listener on this
computer's loopback (`loopback_redirect`), as it does for Claude Code itself, so the person approves
and is done. Nothing to copy and nothing to paste.

WHY NOT THE CLI ANY MORE. Desktop used to run `claude setup-token` in a container under a pty. The
CLI's loopback server was then inside the container, where no browser can reach it, so the CLI fell
back to its manual flow and the person pasted `code#state` back. A loopback redirect needs a
listener the browser can reach, and only Desktop itself has one. OpenBot Cloud's server already
runs this same client natively (`sign-in-providers.ts`, `startClaude` and `exchangeClaude`), and the
exchange here matches it field for field. No image, no container and no terminal are needed.

THE MANUAL FLOW STAYS, FOR AN OLDER PAGE. The app page inside Desktop can be older than Desktop.
Such a page starts the sign-in, shows a paste box and sends `code#state` back. So every sign-in
also carries a manual URL, with the same verifier and state and Claude's own code page as its
redirect, and a pasted code is exchanged against that redirect once its state is checked.
*/

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::loopback_redirect::{Ended, Listener, Outcome};

/// Claude Code's public client, as `claude setup-token` uses it.
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// Claude's own page that shows `code#state` for the person to paste: the manual flow's redirect.
pub const MANUAL_REDIRECT: &str = "https://platform.claude.com/oauth/code/callback";
/// Where Claude Code sends the browser once a loopback sign-in has its token.
pub const SUCCESS_URL: &str = "https://platform.claude.com/oauth/code/success?app=claude-code";
/// What setup-token asks for.
pub const SCOPE: &str = "user:inference";
/// What setup-token asks for: a token that lasts a year. A number on the wire.
const TOKEN_LIFETIME_S: u64 = 31_536_000;
/// The loopback redirect's path, as Claude Code's own.
const CALLBACK_PATH: &str = "/callback";
/// What Claude Code answers the browser when a sign-in failed.
const FAILED_PAGE: &str = "Sign-in was canceled or failed. You can close this window.";

/// The start of a plan token, which is what tells it apart from an API key. Accepting an API key
/// here would write the one credential the plan path exists to avoid.
const PLAN_TOKEN_PREFIX: &str = concat!("sk", "-ant-oat");

/**
How long a person is given to approve in their browser.

Generous on purpose: this covers finding a password, a second factor, and possibly choosing between
accounts. The failure of being too short is telling somebody who did nothing wrong that it did not
work, and making them start again.
*/
const PATIENCE_FOR_THE_PERSON: Duration = Duration::from_secs(600);

const OTHER_SIGN_IN: &str =
    "That code is from another sign-in. Paste the code from the newest Claude page, or sign in again.";
const REFUSED_CODE: &str = "That code was refused. A code can only be used once and does not last long, so start the sign-in again and bring back a fresh one.";
const REFUSED: &str = "Claude didn't accept the sign-in. Sign in again.";
const LOST: &str =
    "Could not reach Claude to finish signing in. Check your connection and sign in again.";
const UNREADABLE: &str = "Claude returned an unreadable sign-in response. Sign in again.";
const NOT_APPROVED: &str = "The Claude sign-in was not approved. Sign in again.";
const DIDNT_FINISH: &str =
    "That sign-in did not finish. Start it again and approve the request in your browser.";
const STOPPED: &str = "The sign-in was stopped. Start it again.";
const NO_LONGER_RUNNING: &str = "That sign-in is no longer running. Start it again.";

/// Which redirect the browser is sent to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// Back to this computer: it finishes on its own.
    Loopback,
    /// To Claude's code page, for the person to paste. For an app page older than this flow.
    Manual,
}

/// Where the OAuth runs. Claude's own endpoints, unless a test points them at a stand-in.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
}

impl Endpoints {
    /**
    Claude's endpoints, or a stand-in's for driving this client in a test.
    */
    pub fn configured() -> Self {
        let named = |name: &str, default: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        Self {
            authorize: named("OPENBOT_CLAUDE_OAUTH_AUTHORIZE_URL", AUTHORIZE_URL),
            token: named("OPENBOT_CLAUDE_OAUTH_TOKEN_URL", TOKEN_URL),
        }
    }
}

/// One sign-in, from its start to its token.
pub struct SignIn {
    verifier: String,
    state: String,
    loopback_redirect: String,
    loopback_url: String,
    manual_url: String,
    token_url: String,
    listener: Mutex<Option<Listener>>,
    cancelled: AtomicBool,
}

impl SignIn {
    /// PKCE, a state, the loopback listener, and both URLs to approve at.
    pub fn start(endpoints: &Endpoints) -> Result<Self, String> {
        let listener = Listener::on_any_port(CALLBACK_PATH).map_err(|error| {
            format!("OpenBot couldn't start the sign-in on this computer. Try again. ({error})")
        })?;
        let verifier = crate::provider_oauth::random();
        let state = crate::provider_oauth::random();
        let challenge = crate::provider_oauth::pkce_challenge(&verifier);
        let loopback_redirect = listener.redirect_uri();
        let loopback_url =
            authorize_url(&endpoints.authorize, &loopback_redirect, &challenge, &state)?;
        let manual_url = authorize_url(&endpoints.authorize, MANUAL_REDIRECT, &challenge, &state)?;
        Ok(Self {
            verifier,
            state,
            loopback_redirect,
            loopback_url,
            manual_url,
            token_url: endpoints.token.clone(),
            listener: Mutex::new(Some(listener)),
            cancelled: AtomicBool::new(false),
        })
    }

    pub fn url(&self, redirect: Redirect) -> &str {
        match redirect {
            Redirect::Loopback => &self.loopback_url,
            Redirect::Manual => &self.manual_url,
        }
    }

    /// Stop it. A wait for the browser ends within a moment.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /**
    The plan token. With no code, once the browser comes back to this computer. With a code, the
    `code#state` Claude's page showed the person, from the manual flow.
    */
    pub fn finish(&self, code: Option<&str>) -> Result<String, String> {
        match code.map(str::trim).filter(|code| !code.is_empty()) {
            Some(pasted) => self.finish_pasted(pasted),
            None => self.finish_in_the_browser(),
        }
    }

    /// As setup-token reads it: the state is checked before anything is sent to Claude.
    fn finish_pasted(&self, pasted: &str) -> Result<String, String> {
        let (code, state) = match pasted.split_once('#') {
            Some((code, state)) => (code.trim(), Some(state.trim())),
            None => (pasted, None),
        };
        if state.is_some_and(|state| state != self.state) {
            return Err(OTHER_SIGN_IN.into());
        }
        if code.is_empty() {
            return Err(REFUSED_CODE.into());
        }
        // The listener is no longer needed: this sign-in finishes from the paste.
        self.listener.lock().unwrap().take();
        self.exchange(code, MANUAL_REDIRECT)
            .map_err(|failure| match failure {
                Failure::Refused => REFUSED_CODE.into(),
                other => other.said(),
            })
    }

    fn finish_in_the_browser(&self) -> Result<String, String> {
        let listener = self
            .listener
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| NO_LONGER_RUNNING.to_string())?;
        let (outcome, reply) = listener
            .wait(&self.state, PATIENCE_FOR_THE_PERSON, &|| {
                self.cancelled.load(Ordering::SeqCst)
            })
            .map_err(|ended| match ended {
                Ended::Cancelled => STOPPED.to_string(),
                Ended::TimedOut | Ended::PortWanted | Ended::Failed(_) => DIDNT_FINISH.to_string(),
            })?;
        match outcome {
            Outcome::Error { error, .. } => {
                reply.text("200 OK", FAILED_PAGE);
                Err(if error == "access_denied" {
                    NOT_APPROVED.into()
                } else {
                    DIDNT_FINISH.into()
                })
            }
            Outcome::Code { code, .. } => match self.exchange(&code, &self.loopback_redirect) {
                Ok(token) => {
                    reply.redirect(SUCCESS_URL);
                    Ok(token)
                }
                Err(failure) => {
                    reply.text("200 OK", FAILED_PAGE);
                    Err(failure.said())
                }
            },
        }
    }

    /// The exchange, exactly as OpenBot Cloud's server and setup-token send it.
    fn exchange(&self, code: &str, redirect_uri: &str) -> Result<String, Failure> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("OpenBot/desktop-claude-sign-in")
            .build()
            .map_err(|_| Failure::Lost)?;
        let response = client
            .post(&self.token_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": CLIENT_ID,
                "code_verifier": self.verifier,
                "state": self.state,
                "expires_in": TOKEN_LIFETIME_S,
            }))
            .send()
            .map_err(|_| Failure::Lost)?;
        if !response.status().is_success() {
            return Err(Failure::Refused);
        }
        let body: serde_json::Value = response.json().map_err(|_| Failure::Unreadable)?;
        body.get("access_token")
            .and_then(|token| token.as_str())
            .map(str::trim)
            .filter(|token| token.starts_with(PLAN_TOKEN_PREFIX) && token.len() > 30)
            .map(str::to_owned)
            .ok_or(Failure::Unreadable)
    }
}

enum Failure {
    Refused,
    Lost,
    Unreadable,
}

impl Failure {
    fn said(self) -> String {
        match self {
            Failure::Refused => REFUSED,
            Failure::Lost => LOST,
            Failure::Unreadable => UNREADABLE,
        }
        .into()
    }
}

/// The authorize URL, its parameters in setup-token's order.
fn authorize_url(
    authorize: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(authorize)
        .map_err(|_| "OpenBot couldn't start the sign-in with Claude.".to_string())?;
    url.query_pairs_mut().extend_pairs([
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPE),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ]);
    Ok(url.into())
}

/// The sign-in in progress on this computer. One at a time: a new one stops the last.
static ACTIVE: Mutex<Option<Arc<SignIn>>> = Mutex::new(None);

fn active() -> std::sync::MutexGuard<'static, Option<Arc<SignIn>>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start a sign-in and return the URL to open: the loopback one, or the manual one for a page that
/// pastes the code.
pub fn begin(redirect: Redirect) -> Result<String, String> {
    begin_with(&Endpoints::configured(), redirect)
}

pub fn begin_with(endpoints: &Endpoints, redirect: Redirect) -> Result<String, String> {
    let signing = Arc::new(SignIn::start(endpoints)?);
    let url = signing.url(redirect).to_owned();
    if let Some(previous) = active().replace(signing) {
        previous.cancel();
    }
    Ok(url)
}

/**
Finish the sign-in in progress and return the plan token.

A pasted code from another sign-in leaves this one running, for the right code. Every other end,
success or not, ends it: a code is single-use.
*/
pub fn finish(code: Option<&str>) -> Result<String, String> {
    let signing = active()
        .clone()
        .ok_or_else(|| NO_LONGER_RUNNING.to_string())?;
    let result = signing.finish(code);
    if result.as_ref().is_err_and(|said| said == OTHER_SIGN_IN) {
        return result;
    }
    let mut current = active();
    if current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &signing))
    {
        current.take();
    }
    result
}

/// Stop the sign-in in progress, if any. Whoever waits in `finish` hears it stopped.
pub fn cancel() {
    if let Some(signing) = active().take() {
        signing.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    /// Every test here goes through the one sign-in slot, which is process-wide.
    static SLOT: Mutex<()> = Mutex::new(());

    fn slot() -> std::sync::MutexGuard<'static, ()> {
        SLOT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn plan_token() -> String {
        format!("{PLAN_TOKEN_PREFIX}01-{}", "AbCdEf0123456789".repeat(5))
    }

    /// What the stand-in remembers of each code it issued.
    #[derive(Clone)]
    struct Issued {
        challenge: String,
        redirect_uri: String,
        state: String,
    }

    /**
    A stand-in for Anthropic's OAuth server, acting as it does where this client meets it.

    `GET /cai/oauth/authorize` checks the client, the response type, PKCE's method and the shape of
    the redirect (Claude's code page, or `http://localhost:<port>/callback` exactly), then sends the
    browser to that redirect with a code and the state. `POST /v1/oauth/token` takes the JSON body
    setup-token sends, checks the verifier against the challenge and the redirect against the one the
    code was issued for, and answers a plan token. A code is good once.
    */
    struct Anthropic {
        base: String,
        exchanges: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    impl Anthropic {
        fn endpoints(&self) -> Endpoints {
            Endpoints {
                authorize: format!("{}/cai/oauth/authorize", self.base),
                token: format!("{}/v1/oauth/token", self.base),
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut bytes = Vec::new();
        let mut chunk = [0; 4096];
        let end = loop {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
        };
        let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
        let mut line = head.lines().next()?.split_whitespace();
        let method = line.next()?.to_owned();
        let target = line.next()?.to_owned();
        let length: usize = head
            .lines()
            .filter_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().to_owned())
            })
            .next()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while bytes.len() < end + length {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        Some((
            method,
            target,
            String::from_utf8_lossy(&bytes[end..]).into_owned(),
        ))
    }

    fn answer(stream: &mut TcpStream, status: &str, headers: &str, body: &str) {
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }

    fn loopback_shaped(redirect: &str) -> bool {
        redirect
            .strip_prefix("http://localhost:")
            .and_then(|rest| rest.strip_suffix("/callback"))
            .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
    }

    fn anthropic() -> Anthropic {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let exchanges = Arc::new(Mutex::new(Vec::new()));
        let seen = exchanges.clone();
        std::thread::spawn(move || {
            let mut issued: HashMap<String, Issued> = HashMap::new();
            let mut next = 0;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let Some((method, target, body)) = read_request(&mut stream) else {
                    continue;
                };
                let url = reqwest::Url::parse(&format!("http://anthropic{target}")).unwrap();
                match (method.as_str(), url.path()) {
                    ("GET", "/cai/oauth/authorize") => {
                        let query: HashMap<String, String> =
                            url.query_pairs().into_owned().collect();
                        let get = |name: &str| query.get(name).cloned().unwrap_or_default();
                        let redirect = get("redirect_uri");
                        let valid = get("client_id") == CLIENT_ID
                            && get("response_type") == "code"
                            && get("code") == "true"
                            && get("code_challenge_method") == "S256"
                            && get("scope") == SCOPE
                            && !get("code_challenge").is_empty()
                            && !get("state").is_empty()
                            && (redirect == MANUAL_REDIRECT || loopback_shaped(&redirect));
                        if !valid {
                            answer(&mut stream, "400 Bad Request", "", "invalid_request");
                            continue;
                        }
                        next += 1;
                        let code = format!("ac-{next}");
                        issued.insert(
                            code.clone(),
                            Issued {
                                challenge: get("code_challenge"),
                                redirect_uri: redirect.clone(),
                                state: get("state"),
                            },
                        );
                        let mut location = reqwest::Url::parse(&redirect).unwrap();
                        location
                            .query_pairs_mut()
                            .append_pair("code", &code)
                            .append_pair("state", &get("state"));
                        answer(
                            &mut stream,
                            "302 Found",
                            &format!("Location: {location}\r\n"),
                            "",
                        );
                    }
                    ("POST", "/v1/oauth/token") => {
                        let json: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or_default();
                        seen.lock().unwrap().push(json.clone());
                        let text = |name: &str| json[name].as_str().unwrap_or("").to_owned();
                        let granted = issued.remove(&text("code")).filter(|issued| {
                            text("grant_type") == "authorization_code"
                                && text("client_id") == CLIENT_ID
                                && text("redirect_uri") == issued.redirect_uri
                                && text("state") == issued.state
                                && json["expires_in"].as_u64() == Some(TOKEN_LIFETIME_S)
                                && crate::provider_oauth::pkce_challenge(&text("code_verifier"))
                                    == issued.challenge
                        });
                        if granted.is_some() {
                            let body = serde_json::json!({
                                "access_token": plan_token(),
                                "token_type": "Bearer",
                                "expires_in": TOKEN_LIFETIME_S,
                                "scope": SCOPE,
                            })
                            .to_string();
                            answer(
                                &mut stream,
                                "200 OK",
                                "Content-Type: application/json\r\n",
                                &body,
                            );
                        } else {
                            answer(
                                &mut stream,
                                "400 Bad Request",
                                "Content-Type: application/json\r\n",
                                r#"{"error":"invalid_grant"}"#,
                            );
                        }
                    }
                    _ => answer(&mut stream, "404 Not Found", "", ""),
                }
            }
        });
        Anthropic { base, exchanges }
    }

    fn no_redirects() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap()
    }

    /// The person approving at Anthropic: where Anthropic sends the browser next.
    fn approve(url: &str) -> String {
        let response = no_redirects().get(url).send().unwrap();
        assert_eq!(response.status().as_u16(), 302, "Anthropic refused {url}");
        response.headers()["location"].to_str().unwrap().to_owned()
    }

    fn query_of(url: &str) -> HashMap<String, String> {
        reqwest::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    /// The browser landing on `location`, over real HTTP: its status and its Location, if any.
    fn land(location: &str) -> (u16, Option<String>, String) {
        let response = no_redirects().get(location).send().unwrap();
        let status = response.status().as_u16();
        let next = response
            .headers()
            .get("location")
            .map(|value| value.to_str().unwrap().to_owned());
        (status, next, response.text().unwrap_or_default())
    }

    /// THE WHOLE SIGN-IN, WITH NOTHING PASTED. The browser goes from Anthropic to this computer and
    /// on to Claude's success page, and the flow returns the plan token.
    #[test]
    fn a_claude_sign_in_finishes_on_its_own_through_the_loopback() {
        let _slot = slot();
        let anthropic = anthropic();
        let url = begin_with(&anthropic.endpoints(), Redirect::Loopback).unwrap();
        let query = query_of(&url);
        let redirect = query["redirect_uri"].clone();
        assert!(loopback_shaped(&redirect), "{redirect}");
        // In setup-token's order.
        let keys: Vec<String> = reqwest::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .map(|(key, _)| key.into_owned())
            .collect();
        assert_eq!(
            keys,
            [
                "code",
                "client_id",
                "response_type",
                "redirect_uri",
                "scope",
                "code_challenge",
                "code_challenge_method",
                "state"
            ]
        );

        let waiting = std::thread::spawn(|| finish(None));
        let location = approve(&url);
        assert!(location.starts_with(&redirect), "{location}");
        let (status, next, _) = land(&location);
        assert_eq!(status, 302);
        assert_eq!(next.as_deref(), Some(SUCCESS_URL));
        assert_eq!(waiting.join().unwrap(), Ok(plan_token()));

        let exchanges = anthropic.exchanges.lock().unwrap();
        assert_eq!(exchanges.len(), 1);
        assert_eq!(exchanges[0]["redirect_uri"], serde_json::json!(redirect));
        assert_eq!(exchanges[0]["expires_in"], serde_json::json!(31_536_000));
        assert!(active().is_none(), "a finished sign-in stayed active");
    }

    /// A tab from an earlier sign-in is told so, and the sign-in in progress still finishes.
    #[test]
    fn a_redirect_with_another_state_is_turned_away_and_the_wait_goes_on() {
        let _slot = slot();
        let anthropic = anthropic();
        let url = begin_with(&anthropic.endpoints(), Redirect::Loopback).unwrap();
        let redirect = query_of(&url)["redirect_uri"].clone();
        let waiting = std::thread::spawn(|| finish(None));

        let (status, _, page) = land(&format!("{redirect}?code=ac-stale&state=earlier"));
        assert_eq!(status, 400);
        assert!(page.contains("This sign-in link is out of date"), "{page}");
        assert!(!page.contains("ac-stale"), "a page must never echo a code");

        let (status, next, _) = land(&approve(&url));
        assert_eq!(status, 302);
        assert_eq!(next.as_deref(), Some(SUCCESS_URL));
        assert_eq!(waiting.join().unwrap(), Ok(plan_token()));
    }

    /// Deny at Claude: the browser is told as Claude Code tells it, and the flow ends with a sentence.
    #[test]
    fn an_error_callback_ends_the_sign_in_with_a_sentence() {
        let _slot = slot();
        let anthropic = anthropic();
        let url = begin_with(&anthropic.endpoints(), Redirect::Loopback).unwrap();
        let query = query_of(&url);
        let waiting = std::thread::spawn(|| finish(None));
        let (status, _, page) = land(&format!(
            "{}?error=access_denied&state={}",
            query["redirect_uri"], query["state"]
        ));
        assert_eq!(status, 200);
        assert_eq!(page, FAILED_PAGE);
        assert_eq!(waiting.join().unwrap(), Err(NOT_APPROVED.to_string()));
        assert!(anthropic.exchanges.lock().unwrap().is_empty());
        assert!(active().is_none());
    }

    /**
    The manual flow, for an app page older than this one: the person pastes the `code#state` Claude's
    page shows. A code from another sign-in is refused before anything reaches Claude, and the right
    one still finishes it.
    */
    #[test]
    fn a_pasted_code_and_state_from_the_manual_flow_finishes_the_sign_in() {
        let _slot = slot();
        let anthropic = anthropic();
        let url = begin_with(&anthropic.endpoints(), Redirect::Manual).unwrap();
        assert_eq!(query_of(&url)["redirect_uri"], MANUAL_REDIRECT);
        let shown = query_of(&approve(&url));
        let pasted = format!("{}#{}", shown["code"], shown["state"]);

        assert_eq!(
            finish(Some(&format!("{}#another-sign-in", shown["code"]))),
            Err(OTHER_SIGN_IN.to_string())
        );
        assert!(anthropic.exchanges.lock().unwrap().is_empty());

        assert_eq!(finish(Some(&format!("  {pasted}\n"))), Ok(plan_token()));
        let exchanges = anthropic.exchanges.lock().unwrap();
        assert_eq!(
            exchanges[0]["redirect_uri"],
            serde_json::json!(MANUAL_REDIRECT)
        );
        assert!(active().is_none());
    }

    /// Leaving the sign-in stops the wait at once, and its port is given back.
    #[test]
    fn a_cancel_stops_the_wait_for_the_browser() {
        let _slot = slot();
        let anthropic = anthropic();
        let url = begin_with(&anthropic.endpoints(), Redirect::Loopback).unwrap();
        let redirect = query_of(&url)["redirect_uri"].clone();
        let waiting = std::thread::spawn(|| finish(None));
        std::thread::sleep(Duration::from_millis(200));
        cancel();
        assert_eq!(waiting.join().unwrap(), Err(STOPPED.to_string()));
        let port: u16 = redirect
            .trim_start_matches("http://localhost:")
            .trim_end_matches("/callback")
            .parse()
            .unwrap();
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the listener outlived its sign-in"
        );
    }

    #[test]
    fn the_real_endpoints_are_the_default() {
        let endpoints = Endpoints::configured();
        assert_eq!(endpoints.authorize, AUTHORIZE_URL);
        assert_eq!(endpoints.token, TOKEN_URL);
    }
}
