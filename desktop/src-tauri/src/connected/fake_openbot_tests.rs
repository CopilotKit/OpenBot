/*!
A stand-in for an OpenBot that runs elsewhere, for this module's tests: a real HTTP server on a
loopback port that answers the addresses the app uses as the real one does.

- the public deployment answer and the authorization server metadata (RFC 8414), at the real paths;
- the authorization endpoint, which accepts only the public client, `response_type=code`, an S256
  challenge and a redirect of exactly `http://127.0.0.1:<port>/callback`, and sends the browser
  back with a code or with `error=access_denied`;
- the token endpoint: form-encoded, the client's id in the body, the verifier really checked
  against the challenge, a code that burns on its first use (right or wrong), and refresh tokens
  that rotate, where one used a second time answers `invalid_grant` and ends the family;
- revocation (RFC 7009);
- `/api/copilotkit/info` and a few `/api/v2` addresses that honour a Bearer access token and nothing else, one
  of them a stream and one a WebSocket.

And a stand-in for the person's browser (`Browser`), which follows the authorization address the
app opens and the redirect back to the app's listener.
*/

use super::address::Metadata;
use super::credentials::Store;
use super::sign_in::{self, Attempt, Session};
use super::CLIENT_ID;
use crate::provider_oauth::{pkce_challenge, random};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What is listening at the address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Shape {
    /// An OpenBot this app can connect to.
    Current,
    /// Some other website: every address answers a page.
    WebPage,
    /// Some other service that answers JSON.
    OtherJson,
    /// An OpenBot somebody is trying on their own computer.
    LocalEvaluation,
    /// The personal edition: one person, no sign-in.
    Personal,
    /// A team's OpenBot from before apps could sign in.
    NoMetadata,
    /// Metadata whose endpoints are on another host.
    MetadataElsewhere,
    /// Every address redirects to the same path at another address.
    RedirectsTo(String),
    /// Signs the app in, and then refuses the token on `/api/copilotkit/info`.
    MeRefuses,
}

const SCOPES: [&str; 4] = ["openid", "profile", "offline_access", "openbot"];

/// One request as the server received it.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

struct Code {
    challenge: String,
    redirect: String,
}

#[derive(Default)]
struct State {
    seen: Vec<Seen>,
    codes: HashMap<String, Code>,
    access: HashSet<String>,
    /// Every refresh token ever issued, and whether it is the current one.
    refresh: HashMap<String, bool>,
    token_requests: Vec<HashMap<String, String>>,
    revoke_requests: Vec<HashMap<String, String>>,
    token_delay: Duration,
}

pub struct FakeOpenBot {
    address: String,
    state: Arc<Mutex<State>>,
    _runtime: tokio::runtime::Runtime,
}

type Body = BoxBody<Bytes, Infallible>;

fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into()).boxed()
}

fn json(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(full(value.to_string()))
        .unwrap()
}

fn oauth_error(error: &str, description: &str) -> Response<Body> {
    json(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "error": error, "error_description": description }),
    )
}

fn form(body: &[u8]) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://form/?{}", String::from_utf8_lossy(body)))
        .map(|url| url.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

fn loopback_callback(redirect: &str) -> bool {
    reqwest::Url::parse(redirect).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/callback"
            && url.query().is_none()
    })
}

impl FakeOpenBot {
    pub fn start(shape: Shape) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (serving_state, serving_address) = (state.clone(), address.clone());
        runtime.spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (state, address, shape) = (
                    serving_state.clone(),
                    serving_address.clone(),
                    shape.clone(),
                );
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(move |request| {
                        answer(request, state.clone(), address.clone(), shape.clone())
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
        Self {
            address,
            state,
            _runtime: runtime,
        }
    }

    pub fn address(&self) -> String {
        self.address.clone()
    }

    /// Every request received, as `GET /path`.
    pub fn requests(&self) -> Vec<String> {
        self.seen()
            .iter()
            .map(|seen| format!("{} {}", seen.method, seen.path))
            .collect()
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.state.lock().unwrap().seen.clone()
    }

    /// The requests received for `path`.
    pub fn seen_at(&self, path: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.path == path)
            .collect()
    }

    pub fn honours(&self, access: &str) -> bool {
        self.state.lock().unwrap().access.contains(access)
    }

    pub fn token_requests(&self) -> Vec<HashMap<String, String>> {
        self.state.lock().unwrap().token_requests.clone()
    }

    pub fn revoke_requests(&self) -> Vec<HashMap<String, String>> {
        self.state.lock().unwrap().revoke_requests.clone()
    }

    /// Access tokens and current refresh tokens that still work.
    pub fn live_tokens(&self) -> usize {
        let state = self.state.lock().unwrap();
        state.access.len() + state.refresh.values().filter(|current| **current).count()
    }

    /// A code as the authorization endpoint issues one, for a test that exchanges it itself.
    pub fn issue_code(&self, challenge: &str, redirect: &str) -> String {
        let code = random();
        self.state.lock().unwrap().codes.insert(
            code.clone(),
            Code {
                challenge: challenge.into(),
                redirect: redirect.into(),
            },
        );
        code
    }

    /// What the authorization endpoint says to a request with `redirect` as its redirect.
    pub fn authorize_refuses(&self, redirect: &str) -> String {
        let mut url =
            reqwest::Url::parse(&format!("{}/api/auth/oauth2/authorize", self.address)).unwrap();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect),
            ("scope", "openid offline_access"),
            ("state", "state"),
            ("code_challenge", &pkce_challenge("verifier")),
            ("code_challenge_method", "S256"),
        ]);
        let answered = no_redirects()
            .get(url)
            .header("x-fake-person", "approve")
            .send()
            .unwrap();
        assert_eq!(answered.status(), 400);
        answered.text().unwrap()
    }

    /// Every access token stops working, as after its hour. Refresh tokens still work.
    pub fn expire_access_tokens(&self) {
        self.state.lock().unwrap().access.clear();
    }

    /// Signed out elsewhere, or removed: nothing issued so far works any more.
    pub fn end_sessions(&self) {
        let mut state = self.state.lock().unwrap();
        state.access.clear();
        for current in state.refresh.values_mut() {
            *current = false;
        }
    }

    pub fn slow_token_endpoint(&self, delay: Duration) {
        self.state.lock().unwrap().token_delay = delay;
    }

    pub fn metadata(&self) -> Metadata {
        super::address::probe(&self.address).unwrap()
    }

    /// A whole sign-in with a person who approves.
    pub fn sign_in(&self, store: Store) -> Session {
        let browser = Browser::approves();
        let session = sign_in::sign_in(
            &self.address,
            &self.metadata(),
            store,
            &Attempt::default(),
            Duration::from_secs(20),
            browser.opener(),
        )
        .unwrap();
        browser.tab();
        session
    }
}

fn bearer(request: &Request<Incoming>) -> Option<String> {
    request
        .headers()
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_owned)
}

async fn answer(
    request: Request<Incoming>,
    state: Arc<Mutex<State>>,
    address: String,
    shape: Shape,
) -> Result<Response<Body>, Infallible> {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                value.to_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    state.lock().unwrap().seen.push(Seen {
        method: method.clone(),
        path: path.clone(),
        headers: headers.clone(),
    });

    match &shape {
        Shape::WebPage => {
            return Ok(Response::builder()
                .header("content-type", "text/html")
                .body(full("<!doctype html><title>A website</title>"))
                .unwrap())
        }
        Shape::OtherJson => {
            return Ok(json(
                StatusCode::OK,
                serde_json::json!({ "name": "some other service", "version": 3 }),
            ))
        }
        Shape::RedirectsTo(other) => {
            return Ok(Response::builder()
                .status(StatusCode::FOUND)
                .header("location", format!("{other}{path}"))
                .body(full(""))
                .unwrap())
        }
        _ => {}
    }

    let authorized = bearer(&request).filter(|token| state.lock().unwrap().access.contains(token));
    let refused = || {
        json(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "unauthorized" }),
        )
    };
    Ok(match (method.as_str(), path.as_str()) {
        ("GET", "/api/v2/organizations/default/deployment") => json(
            StatusCode::OK,
            serde_json::json!({
                "edition": if shape == Shape::Personal { "personal" } else { "team" },
                "localEvaluation": shape == Shape::LocalEvaluation,
                "generativeUi": true,
                "authProviders": ["google"],
                "ssoConfigured": false,
                "ssoRequired": false,
            }),
        ),
        ("GET", "/.well-known/oauth-authorization-server/api/auth") => {
            if matches!(
                shape,
                Shape::NoMetadata | Shape::Personal | Shape::LocalEvaluation
            ) {
                return Ok(json(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "not_found" }),
                ));
            }
            let home = if shape == Shape::MetadataElsewhere {
                "https://elsewhere.example".to_owned()
            } else {
                address.clone()
            };
            json(
                StatusCode::OK,
                serde_json::json!({
                    "issuer": format!("{address}/api/auth"),
                    "authorization_endpoint": format!("{home}/api/auth/oauth2/authorize"),
                    "token_endpoint": format!("{home}/api/auth/oauth2/token"),
                    "revocation_endpoint": format!("{home}/api/auth/oauth2/revoke"),
                    "scopes_supported": SCOPES,
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                }),
            )
        }
        ("GET", "/api/auth/oauth2/authorize") => {
            let asked = form(query.as_bytes());
            let get = |name: &str| asked.get(name).map(String::as_str).unwrap_or("");
            let redirect = get("redirect_uri");
            if get("client_id") != CLIENT_ID {
                return Ok(oauth_error("invalid_client", "unknown client_id"));
            }
            if !loopback_callback(redirect) {
                return Ok(oauth_error(
                    "invalid_request",
                    "redirect_uri must be http://127.0.0.1:<port>/callback",
                ));
            }
            if get("response_type") != "code"
                || get("code_challenge").is_empty()
                || get("code_challenge_method") != "S256"
                || get("state").is_empty()
            {
                return Ok(oauth_error(
                    "invalid_request",
                    "code, S256 and state are required",
                ));
            }
            if !get("scope").split(' ').all(|scope| SCOPES.contains(&scope)) {
                return Ok(oauth_error("invalid_scope", "unknown scope"));
            }
            // The person, signed in to OpenBot in their browser, answering the consent screen.
            let approves = headers
                .iter()
                .any(|(name, value)| name == "x-fake-person" && value == "approve");
            let mut back = reqwest::Url::parse(redirect).unwrap();
            if approves {
                let code = random();
                state.lock().unwrap().codes.insert(
                    code.clone(),
                    Code {
                        challenge: get("code_challenge").into(),
                        redirect: redirect.into(),
                    },
                );
                back.query_pairs_mut().append_pair("code", &code);
            } else {
                back.query_pairs_mut().append_pair("error", "access_denied");
            }
            back.query_pairs_mut().append_pair("state", get("state"));
            Response::builder()
                .status(StatusCode::FOUND)
                .header("location", back.as_str())
                .body(full(""))
                .unwrap()
        }
        ("POST", "/api/auth/oauth2/token") => {
            let encoded = headers.iter().any(|(name, value)| {
                name == "content-type" && value.starts_with("application/x-www-form-urlencoded")
            });
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let sent = form(&body);
            let delay = {
                let mut state = state.lock().unwrap();
                state.token_requests.push(sent.clone());
                state.token_delay
            };
            tokio::time::sleep(delay).await;
            if !encoded {
                return Ok(oauth_error("invalid_request", "the body must be a form"));
            }
            let get = |name: &str| sent.get(name).map(String::as_str).unwrap_or("");
            if get("client_id") != CLIENT_ID {
                return Ok(oauth_error(
                    "invalid_client",
                    "client_id is required in the body",
                ));
            }
            let mut state = state.lock().unwrap();
            let granted = match get("grant_type") {
                "authorization_code" => {
                    // Burned whatever comes next: a code is good for one try.
                    let code = state.codes.remove(get("code"));
                    code.is_some_and(|code| {
                        code.redirect == get("redirect_uri")
                            && code.challenge == pkce_challenge(get("code_verifier"))
                    })
                }
                "refresh_token" => match state.refresh.get(get("refresh_token")).copied() {
                    Some(true) => {
                        state.refresh.insert(get("refresh_token").to_owned(), false);
                        true
                    }
                    // Used a second time: the whole family ends.
                    Some(false) => {
                        state.access.clear();
                        for current in state.refresh.values_mut() {
                            *current = false;
                        }
                        false
                    }
                    None => false,
                },
                _ => return Ok(oauth_error("unsupported_grant_type", "unknown grant")),
            };
            if !granted {
                return Ok(oauth_error("invalid_grant", "the grant is not valid"));
            }
            let access = format!("oba_{}", random());
            let refresh = format!("obr_{}", random());
            state.access.insert(access.clone());
            state.refresh.insert(refresh.clone(), true);
            json(
                StatusCode::OK,
                serde_json::json!({
                    "access_token": access,
                    "refresh_token": refresh,
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": SCOPES.join(" "),
                }),
            )
        }
        ("POST", "/api/auth/oauth2/revoke") => {
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let sent = form(&body);
            let mut state = state.lock().unwrap();
            state.revoke_requests.push(sent.clone());
            if sent.get("client_id").map(String::as_str) != Some(CLIENT_ID) {
                return Ok(oauth_error(
                    "invalid_client",
                    "client_id is required in the body",
                ));
            }
            if let Some(token) = sent.get("token") {
                state.access.remove(token);
                if let Some(current) = state.refresh.get_mut(token) {
                    *current = false;
                }
            }
            // RFC 7009 §2.2: 200 whether or not the token was known.
            json(StatusCode::OK, serde_json::json!({}))
        }
        ("GET", "/api/copilotkit/info") => match authorized {
            Some(_) if shape != Shape::MeRefuses => {
                json(StatusCode::OK, serde_json::json!({ "id": "person-1" }))
            }
            _ => refused(),
        },
        (_, "/api/v2/echo") => {
            if authorized.is_none() {
                return Ok(refused());
            }
            let body = request.into_body().collect().await.unwrap().to_bytes();
            json(
                StatusCode::OK,
                serde_json::json!({
                    "method": method,
                    "query": query,
                    "headers": headers.iter().cloned().collect::<HashMap<_, _>>(),
                    "body": String::from_utf8_lossy(&body),
                }),
            )
        }
        ("GET", "/api/v2/stream") => {
            if authorized.is_none() {
                return Ok(refused());
            }
            // Three events, a moment apart, as a chat answer arrives.
            let events = futures_util::stream::unfold(0u8, |sent| async move {
                if sent == 3 {
                    return None;
                }
                if sent > 0 {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
                let event = Bytes::from(format!("data: {sent}\n\n"));
                Some((Ok::<_, Infallible>(Frame::data(event)), sent + 1))
            });
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(BodyExt::boxed(StreamBody::new(events)))
                .unwrap()
        }
        ("GET", "/api/v2/cookie") => Response::builder()
            .header("set-cookie", "better-auth.session_token=upstream; Path=/")
            .header("content-type", "text/plain")
            .body(full("ok"))
            .unwrap(),
        ("GET", "/api/v2/home") => Response::builder()
            .status(StatusCode::FOUND)
            .header("location", format!("{address}/landing?from=home#top"))
            .body(full(""))
            .unwrap(),
        ("GET", "/api/v2/away") => Response::builder()
            .status(StatusCode::FOUND)
            .header("location", "https://elsewhere.example/page")
            .body(full(""))
            .unwrap(),
        // OpenBot's own socket takes an app's token. The other is not OpenBot's: on a company's
        // cluster the same host name hands that path straight to another service, which checks a
        // join token of its own and has no business seeing the person's OpenBot sign-in.
        ("GET", "/api/v2/socket" | "/client/websocket") => {
            let key = headers
                .iter()
                .find(|(name, _)| name == "sec-websocket-key")
                .map(|(_, value)| value.clone());
            let allowed = authorized.is_some() || path == "/client/websocket";
            let (true, Some(key)) = (allowed, key) else {
                return Ok(refused());
            };
            let accept =
                tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
            tokio::spawn(async move {
                let Ok(upgraded) = hyper::upgrade::on(request).await else {
                    return;
                };
                let mut socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded),
                    tokio_tungstenite::tungstenite::protocol::Role::Server,
                    None,
                )
                .await;
                while let Some(Ok(message)) = socket.next().await {
                    if message.is_text() || message.is_binary() {
                        let echoed = format!("echo: {}", message.to_text().unwrap_or(""));
                        if socket.send(echoed.into()).await.is_err() {
                            return;
                        }
                    }
                }
            });
            Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-accept", accept)
                .body(full(""))
                .unwrap()
        }
        // Something else behind the same host name, refusing for reasons of its own.
        ("GET", "/client/needs-its-own-token") => refused(),
        ("GET", "/assets/app.js") => Response::builder()
            .header("content-type", "text/javascript")
            .body(full("console.log('OpenBot');"))
            .unwrap(),
        ("GET", "/" | "/landing") => Response::builder()
            .header("content-type", "text/html")
            .body(full("<!doctype html><title>OpenBot</title>"))
            .unwrap(),
        _ => json(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not_found" }),
        ),
    })
}

fn no_redirects() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

/// One plain request over a socket, and everything that came back, status line and all.
pub fn raw_request(to: &str, request: &str) -> String {
    let mut stream = std::net::TcpStream::connect(to).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    String::from_utf8_lossy(&answer).into_owned()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Person {
    Approves,
    Denies,
    /// Something else on this computer answers the listener first, with a `state` it made up.
    ForgedStateFirst,
}

#[derive(Default)]
struct Visit {
    asked: HashMap<String, String>,
    tab: String,
    forged: String,
}

/// The person's browser: opens the authorization address, lets the person answer, and follows
/// the redirect back to the app's listener.
pub struct Browser {
    person: Person,
    visit: Arc<Mutex<Visit>>,
    done: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl Browser {
    fn with(person: Person) -> Self {
        Self {
            person,
            visit: Arc::default(),
            done: Arc::default(),
        }
    }

    pub fn approves() -> Self {
        Self::with(Person::Approves)
    }

    pub fn denies() -> Self {
        Self::with(Person::Denies)
    }

    pub fn forges_state_first() -> Self {
        Self::with(Person::ForgedStateFirst)
    }

    /// What the app hands the system: the address to open.
    pub fn opener(&self) -> impl FnOnce(&str) -> Result<(), String> + 'static {
        let (person, visit, done) = (self.person, self.visit.clone(), self.done.clone());
        move |address: &str| {
            let address = reqwest::Url::parse(address).map_err(|error| error.to_string())?;
            let finished = done.clone();
            *finished.lock().unwrap() = Some(std::thread::spawn(move || {
                let asked: HashMap<String, String> = address.query_pairs().into_owned().collect();
                let listener = reqwest::Url::parse(&asked["redirect_uri"]).unwrap();
                let listener = format!("127.0.0.1:{}", listener.port().unwrap());
                visit.lock().unwrap().asked = asked;
                let get = |target: &str| {
                    raw_request(
                        &listener,
                        &format!("GET {target} HTTP/1.1\r\nHost: {listener}\r\n\r\n"),
                    )
                };
                if person == Person::ForgedStateFirst {
                    let forged = get("/callback?code=forged-code&state=made-up");
                    visit.lock().unwrap().forged = forged;
                }
                let sent_back = no_redirects()
                    .get(address)
                    .header(
                        "x-fake-person",
                        if person == Person::Denies {
                            "deny"
                        } else {
                            "approve"
                        },
                    )
                    .send()
                    .unwrap();
                assert_eq!(sent_back.status(), 302, "{:?}", sent_back.text());
                let back =
                    reqwest::Url::parse(sent_back.headers()["location"].to_str().unwrap()).unwrap();
                let tab = get(&format!("{}?{}", back.path(), back.query().unwrap_or("")));
                visit.lock().unwrap().tab = tab;
            }));
            Ok(())
        }
    }

    fn finish(&self) {
        if let Some(visit) = self.done.lock().unwrap().take() {
            visit.join().unwrap();
        }
    }

    /// The authorization request's parameters.
    pub fn asked(&self) -> HashMap<String, String> {
        self.finish();
        self.visit.lock().unwrap().asked.clone()
    }

    /// What the tab showed at the end.
    pub fn tab(&self) -> String {
        self.finish();
        self.visit.lock().unwrap().tab.clone()
    }

    /// What the forged callback was answered.
    pub fn forged_answer(&self) -> String {
        self.finish();
        self.visit.lock().unwrap().forged.clone()
    }
}
