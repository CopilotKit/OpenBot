/*!
The relay between the window and an OpenBot that runs elsewhere.

The window's page cannot hold a token, and that OpenBot sends no CORS headers, so the window loads
the app from `http://127.0.0.1:<port>/` and this server passes each request on to the one address
the person typed. Requests for OpenBot's API (`/api`, `/api/...` and `/.well-known/...`) go with
`Authorization: Bearer <access token>` added, and the organisation the person picked. The page
never sees the token, and nothing but OpenBot's API is sent it: the app's pages and files, and
anything else the same host name serves (on a company's cluster, another service's socket), are
passed on without either.

What keeps it to that:

- It listens on `127.0.0.1` only, at a port the system picks. Never `0.0.0.0`, never `[::1]`.
- A request whose `Host` is not exactly its own `127.0.0.1:<port>` is refused (421): a name that
  resolves here (DNS rebinding) is not this relay.
- A request from another site is refused (403): an `Origin` other than its own, or
  `Sec-Fetch-Site: cross-site` or `same-site`.
- Every request needs a secret only the window has. The shell makes one per run and opens the
  window at `ENTER_PATH` with it; the relay answers with a cookie (`HttpOnly`, `SameSite=Strict`)
  and from then on refuses (403) anything that does not carry it. A page in the person's browser,
  or another program on this computer, has no way to learn it.
- It forwards to the typed address and nowhere else: only origin-form request targets (no absolute
  URL, no CONNECT), and a redirect is handed back to the page, never followed.
- On the way out it drops `Origin`, `Cookie`, `Referer`, `Forwarded` and `X-Forwarded-*`, and any
  `Authorization` the page sent. On the way back it drops `Set-Cookie`.

It adds this app to the `OpenBot-Client` header the page sent, or sends this app's alone, so the
OpenBot knows which apps a request came through (`client_version`).

Bodies are passed on as they arrive, both ways, so a chat answer streams. A WebSocket upgrade is
passed on and the two connections are joined.

Connections to OpenBot are kept open between requests for `KEPT_OPEN_FOR`, less than the idle
timeout of a load balancer or an ingress in front of it. When one still closes just as a request
goes out on it, a request that is safe to send twice is sent once more on a new connection, and
the page sees only the answer (`Forward::send`).

The access token is replaced shortly before it ends, and when that OpenBot answers 401 to a request
with no body the request is sent once more with a new one. When the refresh itself is refused the
sign-in is over: the relay says so once (`Ended::SessionEnded`) and stops answering.
*/

use super::sign_in::Session;
use super::{kind_of, Kind};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where the window first goes, with the run's secret as `key`. Nothing under this prefix is ever
/// forwarded.
pub const ENTER_PATH: &str = "/.openbot-relay/enter";
const OWN_PREFIX: &str = "/.openbot-relay/";
/// The cookie that carries the run's secret from the window.
pub const COOKIE: &str = "openbot-relay";

/// The request header that names the organisation the person is working in. A token carries no
/// session, and a person can belong to several, so every request says which. Set by the shell
/// from the person's choice (`choice::Choice::organization_id`), never taken from the page.
pub const ORGANIZATION_HEADER: &str = "OpenBot-Organization";

fn organization_header(organization: Option<&str>) -> Option<HeaderValue> {
    organization
        .filter(|id| super::choice::valid_organization(id))
        .and_then(|id| HeaderValue::from_str(id).ok())
}

/// Why the connection stopped working, told to the shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The refresh was refused. The relay has stopped answering.
    SessionEnded,
    /// The OpenBot did not answer. The relay keeps going; said at most once in a while.
    Unreachable,
}

/// How often `Ended::Unreachable` is said while the OpenBot stays unreachable.
const UNREACHABLE_SAID_EVERY: Duration = Duration::from_secs(30);

/// How long a connection to OpenBot is kept open, idle, for the next request. A load balancer or
/// an ingress in front of OpenBot closes an idle connection on a timer of its own (AWS's load
/// balancer after 60 s, nginx after 75 s), and a request sent at the moment it does so is lost.
/// Shorter than those, the relay lets the connection go first. Left alone, reqwest keeps one 90 s.
const KEPT_OPEN_FOR: Duration = Duration::from_secs(30);

/// The largest body the relay holds whole, so that the request can be sent again. A larger one,
/// or one of no stated length, is passed on as it arrives and is sent once at most.
const WHOLE_BODY_AT_MOST: usize = 1024 * 1024;

/// The header the API's writes carry so that OpenBot does a write sent twice only once.
const IDEMPOTENCY_KEY: &str = "idempotency-key";

type Body = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;
type OnEnded = dyn Fn(Ended) + Send + Sync;

struct Shared {
    session: Arc<Session>,
    /// `127.0.0.1:<port>`, the only `Host` answered.
    host: String,
    /// `http://127.0.0.1:<port>`, the only `Origin` answered.
    origin: String,
    upstream: reqwest::Url,
    secret: String,
    client: reqwest::Client,
    /// Keeps no connection open: a request sent again goes on a new connection, never on another
    /// kept-open one the same proxy may have closed at the same moment.
    fresh: reqwest::Client,
    organization: Arc<Mutex<Option<HeaderValue>>>,
    on_ended: Box<OnEnded>,
    session_ended: AtomicBool,
    unreachable_said: Mutex<Option<Instant>>,
    stop: tokio::sync::watch::Sender<bool>,
}

/// A running relay. Dropping it stops it.
pub struct Relay {
    address: SocketAddr,
    secret: String,
    organization: Arc<Mutex<Option<HeaderValue>>>,
    stop: tokio::sync::watch::Sender<bool>,
    runtime: Option<tokio::runtime::Runtime>,
}

impl Relay {
    /// Start a relay for `session`, on `127.0.0.1` at a port the system picks, naming
    /// `organization` on every request when there is one.
    pub fn start(
        session: Arc<Session>,
        organization: Option<&str>,
        on_ended: impl Fn(Ended) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let organization = Arc::new(Mutex::new(organization_header(organization)));
        let upstream = reqwest::Url::parse(session.address()).map_err(|error| error.to_string())?;
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
            .map_err(|error| format!("could not listen on 127.0.0.1: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        // No whole-request timeout: a chat answer and a socket stay open for as long as they do.
        let client = |keeps_open: bool| {
            let builder = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .http1_only()
                .user_agent("OpenBot/desktop");
            let builder = if keeps_open {
                builder.pool_idle_timeout(KEPT_OPEN_FOR)
            } else {
                builder.pool_max_idle_per_host(0)
            };
            builder.build().map_err(|error| error.to_string())
        };
        let (client, fresh) = (client(true)?, client(false)?);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("openbot-relay")
            .enable_all()
            .build()
            .map_err(|error| format!("could not start the relay: {error}"))?;
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let secret = crate::provider_oauth::random();
        let shared = Arc::new(Shared {
            session,
            host: address.to_string(),
            origin: format!("http://{address}"),
            upstream,
            secret: secret.clone(),
            client,
            fresh,
            organization: organization.clone(),
            on_ended: Box::new(on_ended),
            session_ended: AtomicBool::new(false),
            unreachable_said: Mutex::new(None),
            stop: stop.clone(),
        });
        runtime.spawn(serve(listener, shared, stopped));
        log::info!("[relay] listening on {address}");
        Ok(Self {
            address,
            secret,
            organization,
            stop,
            runtime: Some(runtime),
        })
    }

    /// The organisation named on every request from now on, or none.
    pub fn set_organization(&self, organization: Option<&str>) {
        *self.organization.lock().unwrap() = organization_header(organization);
    }

    /// The address it listens on: always `127.0.0.1`, and a port.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// `http://127.0.0.1:<port>`: the origin of the app's pages in the window.
    pub fn origin(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Where the window goes first: the address that gives it this run's cookie and sends it on
    /// to the app. It holds the secret, so it is never logged.
    pub fn entry(&self) -> String {
        format!("{}{ENTER_PATH}?key={}", self.origin(), self.secret)
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(runtime) = self.runtime.take() {
            // Not waited for: a stream that is open would hold the wait, and this may run on a
            // thread that must not block.
            runtime.shutdown_background();
        }
        log::info!("[relay] stopped");
    }
}

async fn serve(
    listener: std::net::TcpListener,
    shared: Arc<Shared>,
    mut stopped: tokio::sync::watch::Receiver<bool>,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = stopped.wait_for(|stopped| *stopped) => return,
        };
        let Ok((stream, _)) = accepted else {
            continue;
        };
        let shared = shared.clone();
        let mut stopped = stopped.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let shared = shared.clone();
                async move { Ok::<_, std::convert::Infallible>(answer(request, shared).await) }
            });
            let connection = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::select! {
                _ = connection => {}
                _ = stopped.wait_for(|stopped| *stopped) => {}
            }
        });
    }
}

fn plain(status: StatusCode, said: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(
            Full::new(Bytes::from_static(said.as_bytes()))
                .map_err(|never| match never {})
                .boxed(),
        )
        .expect("a plain response")
}

/// Equal, in time that does not depend on where they differ.
fn same_secret(given: &str, secret: &str) -> bool {
    given.len() == secret.len()
        && given
            .bytes()
            .zip(secret.bytes())
            .fold(0u8, |differences, (a, b)| differences | (a ^ b))
            == 0
}

/// Whether the request carries the run's cookie.
fn has_cookie(headers: &HeaderMap, secret: &str) -> bool {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .any(|(name, value)| name == COOKIE && same_secret(value, secret))
}

/// Headers that belong to one connection, not to the request (RFC 9110 §7.6.1).
fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// Headers of the page's request that are not passed on: where it came from, what the browser
/// keeps for this origin, and anything that claims to speak for another proxy.
fn dropped_on_the_way_out(name: &HeaderName) -> bool {
    let name = name.as_str();
    matches!(
        name,
        "host" | "origin" | "cookie" | "referer" | "forwarded" | "authorization"
    ) || name.starts_with("x-forwarded-")
        || name.starts_with("sec-fetch-")
        // The shell names the organisation, not the page.
        || name.eq_ignore_ascii_case(ORGANIZATION_HEADER)
        // Passed on with this app added after it (`client_version::added_to`).
        || name.eq_ignore_ascii_case(crate::client_version::HEADER)
}

/// Whether a request for `path` is one of OpenBot's own that takes the person's sign-in: its API,
/// and the well-known documents beside it. Everything else behind the same host name (the app's
/// pages and files, another service's socket) is passed on without the token or the organisation:
/// the sign-in is OpenBot's to see and nobody else's.
fn carries_the_sign_in(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/") || path.starts_with("/.well-known/")
}

async fn answer(mut request: Request<Incoming>, shared: Arc<Shared>) -> Response<Body> {
    // Only `GET /path`: an absolute address or a CONNECT names somewhere else to go.
    let target = request.uri();
    if request.method() == Method::CONNECT
        || target.scheme().is_some()
        || target.authority().is_some()
        || !target.path().starts_with('/')
    {
        return plain(
            StatusCode::FORBIDDEN,
            "This relay only serves its own pages.",
        );
    }
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host_is_ours = hosts
        .next()
        .is_some_and(|host| host == shared.host.as_str())
        && hosts.next().is_none();
    if !host_is_ours {
        return plain(
            StatusCode::MISDIRECTED_REQUEST,
            "This relay answers only at its own address.",
        );
    }

    // The window arriving with the run's secret. The key is the guard here, so this is answered
    // before the checks below: the window's first navigation carries no cookie yet.
    if request.uri().path() == ENTER_PATH {
        let key = request
            .uri()
            .query()
            .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("key=")));
        if request.method() != Method::GET
            || !key.is_some_and(|key| same_secret(key, &shared.secret))
        {
            return plain(
                StatusCode::FORBIDDEN,
                "This relay is for the OpenBot window.",
            );
        }
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, "/")
            .header(
                header::SET_COOKIE,
                format!(
                    "{COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
                    shared.secret
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(Empty::new().map_err(|never| match never {}).boxed())
            .expect("the entry response");
    }

    let foreign_origin = request
        .headers()
        .get_all(header::ORIGIN)
        .iter()
        .any(|origin| origin != shared.origin.as_str());
    let from_another_site = request
        .headers()
        .get_all("sec-fetch-site")
        .iter()
        .any(|site| site == "cross-site" || site == "same-site");
    if foreign_origin || from_another_site || !has_cookie(request.headers(), &shared.secret) {
        return plain(
            StatusCode::FORBIDDEN,
            "This relay is for the OpenBot window.",
        );
    }
    if request.uri().path().starts_with(OWN_PREFIX) {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    }
    if shared.session_ended.load(Ordering::SeqCst) {
        return plain(StatusCode::UNAUTHORIZED, "The sign-in has ended.");
    }

    // The typed address with this request's path and query, and nothing else of the request.
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str());
    let address = format!("{}{path}", shared.session.address());
    let destination = reqwest::Url::parse(&address).ok().filter(|url| {
        url.scheme() == shared.upstream.scheme()
            && url.host_str() == shared.upstream.host_str()
            && url.port_or_known_default() == shared.upstream.port_or_known_default()
    });
    let Some(destination) = destination else {
        return plain(
            StatusCode::FORBIDDEN,
            "This relay only serves its own pages.",
        );
    };

    let upgrading = request.headers().contains_key(header::UPGRADE);
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers() {
        if dropped_on_the_way_out(name) || hop_by_hop(name) {
            continue;
        }
        headers.append(name.clone(), value.clone());
    }
    // Which apps the request came through: the page's own name, then this app's. On everything it
    // passes on, so OpenBot knows this app is asking whatever the page is.
    if let (Ok(name), Some(named)) = (
        HeaderName::from_bytes(crate::client_version::HEADER.as_bytes()),
        crate::client_version::added_to(request.headers()),
    ) {
        headers.insert(name, named);
    }
    // The person's sign-in and their organisation, for OpenBot's own API only.
    let signed_in = carries_the_sign_in(request.uri().path());
    let organization = shared
        .organization
        .lock()
        .unwrap()
        .clone()
        .filter(|_| signed_in);
    if let (Some(organization), Ok(name)) = (
        organization,
        HeaderName::from_bytes(ORGANIZATION_HEADER.as_bytes()),
    ) {
        headers.insert(name, organization);
    }
    if upgrading {
        if let Some(protocol) = request.headers().get(header::UPGRADE) {
            headers.insert(header::UPGRADE, protocol.clone());
            headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        }
    }

    let access = if signed_in {
        match token(&shared, None).await {
            Ok(access) => Some(access),
            Err((status, said)) => return plain(status, said),
        }
    } else {
        None
    };
    let method = request.method().clone();
    let on_upgrade = upgrading.then(|| hyper::upgrade::on(&mut request));
    let no_body = hyper::body::Body::is_end_stream(request.body());
    let idempotent = request.headers().contains_key(IDEMPOTENCY_KEY);
    let length = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|length| length.to_str().ok())
        .and_then(|length| length.parse::<usize>().ok());
    let incoming = request.into_body();
    let body = if no_body {
        Outgoing::Empty
    } else if idempotent && length.is_some_and(|length| length <= WHOLE_BODY_AT_MOST) {
        match http_body_util::Limited::new(incoming, WHOLE_BODY_AT_MOST)
            .collect()
            .await
        {
            Ok(whole) => Outgoing::Whole(whole.to_bytes()),
            Err(_) => return plain(StatusCode::BAD_REQUEST, "The request did not arrive whole."),
        }
    } else {
        Outgoing::Streamed(reqwest::Body::wrap_stream(
            http_body_util::BodyDataStream::new(incoming),
        ))
    };

    let forward = Forward {
        method,
        destination,
        headers,
        upgrading,
        idempotent,
    };
    let mut answered = match forward.send(&shared, access.as_deref(), body).await {
        Ok(answered) => answered,
        Err(error) => return unreachable(&shared, error),
    };
    // A 401 to a request that carried no sign-in is somebody else's refusal, and is handed back.
    if let (Some(access), true) = (access, answered.status() == StatusCode::UNAUTHORIZED) {
        // The token was refused. A new one, and the request once more when it had no body to
        // send again; a request with a body is answered as it was, and the next one is signed in.
        match token(&shared, Some(access.clone())).await {
            Ok(newer) if no_body && newer != access => {
                answered = match forward.send(&shared, Some(&newer), Outgoing::Empty).await {
                    Ok(answered) => answered,
                    Err(error) => return unreachable(&shared, error),
                };
            }
            Ok(_) => {}
            Err((status, said)) => return plain(status, said),
        }
    }

    let status = answered.status();
    let mut response = Response::builder().status(status);
    for (name, value) in answered.headers() {
        if name == header::SET_COOKIE {
            continue;
        }
        if hop_by_hop(name) && status != StatusCode::SWITCHING_PROTOCOLS {
            continue;
        }
        if name == header::LOCATION {
            response = response.header(name, on_the_relay(&shared, value));
            continue;
        }
        response = response.header(name, value);
    }

    if status == StatusCode::SWITCHING_PROTOCOLS {
        let Some(on_upgrade) = on_upgrade else {
            return plain(
                StatusCode::BAD_GATEWAY,
                "OpenBot answered with a socket nobody asked for.",
            );
        };
        // The two connections joined, each way, until either closes.
        tokio::spawn(async move {
            let (Ok(page), Ok(mut openbot)) = (on_upgrade.await, answered.upgrade().await) else {
                return;
            };
            let mut page = TokioIo::new(page);
            let _ = tokio::io::copy_bidirectional(&mut page, &mut openbot).await;
        });
        return response
            .body(Empty::new().map_err(|never| match never {}).boxed())
            .unwrap_or_else(|_| {
                plain(
                    StatusCode::BAD_GATEWAY,
                    "OpenBot's answer could not be passed on.",
                )
            });
    }

    // As it arrives: each piece is a frame of its own, so nothing waits for the end.
    let pieces = answered
        .bytes_stream()
        .map(|piece| piece.map(Frame::data).map_err(Into::into));
    response
        .body(BodyExt::boxed(StreamBody::new(pieces)))
        .unwrap_or_else(|_| {
            plain(
                StatusCode::BAD_GATEWAY,
                "OpenBot's answer could not be passed on.",
            )
        })
}

/// The body of the page's request, as it is passed on.
enum Outgoing {
    Empty,
    /// Held whole, so it can be sent again: only for a write that carries an Idempotency-Key.
    Whole(Bytes),
    /// Passed on as it arrives, so part of it may be gone already: sent once at most.
    Streamed(reqwest::Body),
}

/// The page's request as it goes to OpenBot.
struct Forward {
    method: Method,
    destination: reqwest::Url,
    headers: HeaderMap,
    upgrading: bool,
    idempotent: bool,
}

impl Forward {
    fn request(
        &self,
        client: &reqwest::Client,
        access: Option<&str>,
        body: Option<reqwest::Body>,
    ) -> reqwest::RequestBuilder {
        let mut outgoing = client
            .request(self.method.clone(), self.destination.clone())
            .headers(self.headers.clone());
        if let Some(access) = access {
            outgoing = outgoing.bearer_auth(access);
        }
        if let Some(body) = body {
            outgoing = outgoing.body(body);
        }
        outgoing
    }

    /// Sent, and sent once more on a new connection when the one it went on closed before
    /// OpenBot's answer began and the request is safe to send twice: a read (GET, HEAD, OPTIONS)
    /// with no body, or a write with an Idempotency-Key whose body is empty or held whole. A body
    /// that streams, a write without the key and a socket upgrade are never sent again
    /// (RFC 9110 §9.2.2).
    async fn send(
        &self,
        shared: &Shared,
        access: Option<&str>,
        body: Outgoing,
    ) -> reqwest::Result<reqwest::Response> {
        let read = matches!(self.method, Method::GET | Method::HEAD | Method::OPTIONS);
        let (first, again) = match body {
            Outgoing::Empty => (None, (read || self.idempotent).then_some(None)),
            Outgoing::Whole(whole) => (Some(whole.clone().into()), Some(Some(whole))),
            Outgoing::Streamed(streamed) => (Some(streamed), None),
        };
        let error = match self.request(&shared.client, access, first).send().await {
            Err(error) if closed_unanswered(&error) => error,
            answered => return answered,
        };
        let (Some(again), false) = (again, self.upgrading) else {
            return Err(error);
        };
        log::info!(
            "[relay] the connection to OpenBot closed before it answered {} {}; sending it once more",
            self.method,
            self.destination.path()
        );
        self.request(&shared.fresh, access, again.map(reqwest::Body::from))
            .send()
            .await
    }
}

/// Whether the connection a request went on closed before any answer: what a load balancer or an
/// ingress does to a kept-open connection it closes for being idle just as the request is sent
/// ("connection closed before message completed", or a reset). Not a refused connection or a
/// timeout, which say OpenBot itself is not there.
fn closed_unanswered(error: &reqwest::Error) -> bool {
    if error.is_connect() || error.is_timeout() {
        return false;
    }
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        if inner
            .downcast_ref::<hyper::Error>()
            .is_some_and(hyper::Error::is_incomplete_message)
        {
            return true;
        }
        if inner.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            )
        }) {
            return true;
        }
        source = inner.source();
    }
    false
}

/// An access token, off the async threads: a refresh is a blocking request. On a sign-in that has
/// ended, the relay says so and stops; the page is answered 401.
async fn token(
    shared: &Arc<Shared>,
    refused: Option<String>,
) -> Result<String, (StatusCode, &'static str)> {
    let session = shared.session.clone();
    let got = tokio::task::spawn_blocking(move || match refused {
        Some(used) => session.after_refused(&used),
        None => session.access(),
    })
    .await;
    match got {
        Ok(Ok(access)) => Ok(access),
        Ok(Err(problem)) if kind_of(&problem) == Some(Kind::SessionEnded) => {
            end_session(shared);
            Err((StatusCode::UNAUTHORIZED, "The sign-in has ended."))
        }
        Ok(Err(_)) | Err(_) => {
            say_unreachable(shared);
            Err((StatusCode::BAD_GATEWAY, "OpenBot could not be reached."))
        }
    }
}

fn end_session(shared: &Arc<Shared>) {
    if shared.session_ended.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("[relay] the sign-in has ended; no longer answering");
    let _ = shared.stop.send(true);
    // On a thread of its own: the shell stops this relay from it, which this runtime's own
    // threads must not wait for.
    let shared = shared.clone();
    std::thread::spawn(move || (shared.on_ended)(Ended::SessionEnded));
}

fn say_unreachable(shared: &Arc<Shared>) {
    let mut said = shared.unreachable_said.lock().unwrap();
    if said.is_some_and(|at| at.elapsed() < UNREACHABLE_SAID_EVERY) {
        return;
    }
    *said = Some(Instant::now());
    drop(said);
    let shared = shared.clone();
    std::thread::spawn(move || (shared.on_ended)(Ended::Unreachable));
}

fn unreachable(shared: &Arc<Shared>, error: reqwest::Error) -> Response<Body> {
    log::warn!(
        "[relay] OpenBot did not answer: {}",
        super::transport(error)
    );
    say_unreachable(shared);
    plain(StatusCode::BAD_GATEWAY, "OpenBot could not be reached.")
}

/// A redirect's `Location`, kept on the relay when it points at the typed address, so the window
/// stays on pages the relay serves. One that points anywhere else is handed back as it is: the
/// window opens it in the person's browser.
fn on_the_relay(shared: &Shared, location: &HeaderValue) -> HeaderValue {
    let rewritten = location
        .to_str()
        .ok()
        .and_then(|location| reqwest::Url::parse(location).ok())
        .filter(|url| {
            url.scheme() == shared.upstream.scheme()
                && url.host_str() == shared.upstream.host_str()
                && url.port_or_known_default() == shared.upstream.port_or_known_default()
        })
        .map(|url| {
            let mut kept = format!("{}{}", shared.origin, url.path());
            if let Some(query) = url.query() {
                kept.push('?');
                kept.push_str(query);
            }
            if let Some(fragment) = url.fragment() {
                kept.push('#');
                kept.push_str(fragment);
            }
            kept
        })
        .and_then(|kept| HeaderValue::from_str(&kept).ok());
    rewritten.unwrap_or_else(|| location.clone())
}

#[cfg(test)]
mod tests {
    use super::super::credentials::{in_memory, Store};
    use super::super::fake_openbot::{raw_request, FakeOpenBot, Shape};
    use super::*;
    use std::io::Read;

    const ECHO: &str = "/api/v2/echo";

    /// An OpenBot, a sign-in to it, and a relay in front of it.
    struct Rig {
        openbot: FakeOpenBot,
        store: Store,
        session: Arc<Session>,
        relay: Relay,
        ended: Arc<Mutex<Vec<Ended>>>,
    }

    fn rig() -> Rig {
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let session = Arc::new(openbot.sign_in(store.clone()));
        let ended = Arc::new(Mutex::new(Vec::new()));
        let heard = ended.clone();
        let relay = Relay::start(session.clone(), None, move |why| {
            heard.lock().unwrap().push(why)
        })
        .unwrap();
        Rig {
            openbot,
            store,
            session,
            relay,
            ended,
        }
    }

    fn http() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap()
    }

    /// The window: it went to the entry address first, and carries the cookie from then on.
    struct Window {
        origin: String,
        host: String,
        cookie: String,
    }

    impl Rig {
        fn window(&self) -> Window {
            enter(&self.relay)
        }

        fn echoes(&self) -> usize {
            self.openbot.seen_at(ECHO).len()
        }
    }

    fn enter(relay: &Relay) -> Window {
        let entered = http().get(relay.entry()).send().unwrap();
        assert_eq!(entered.status(), 303);
        assert_eq!(entered.headers()["location"], "/");
        let cookie = entered.headers()["set-cookie"].to_str().unwrap().to_owned();
        assert!(
            cookie.ends_with("; HttpOnly; SameSite=Strict; Path=/"),
            "{cookie}"
        );
        Window {
            origin: relay.origin(),
            host: relay.address().to_string(),
            cookie: cookie.split(';').next().unwrap().to_owned(),
        }
    }

    impl Window {
        fn request(
            &self,
            method: reqwest::Method,
            path: &str,
        ) -> reqwest::blocking::RequestBuilder {
            http()
                .request(method, format!("{}{path}", self.origin))
                .header("cookie", &self.cookie)
        }

        fn get(&self, path: &str) -> reqwest::blocking::RequestBuilder {
            self.request(reqwest::Method::GET, path)
        }

        /// What `ECHO` says OpenBot received.
        fn echo(&self, request: reqwest::blocking::RequestBuilder) -> serde_json::Value {
            let answered = request.send().unwrap();
            assert_eq!(answered.status(), 200);
            answered.json().unwrap()
        }

        /// A request written by hand, for the ones no client will send.
        fn raw(&self, first_line: &str, host: &str) -> String {
            raw_request(
                &self.host,
                &format!(
                    "{first_line}\r\nHost: {host}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
                    self.cookie
                ),
            )
        }
    }

    fn status(answer: &str) -> &str {
        answer.lines().next().unwrap_or("")
    }

    #[test]
    fn it_listens_on_127_0_0_1_only_at_a_port_of_its_own() {
        let rig = rig();
        let second = Relay::start(rig.session.clone(), None, |_| {}).unwrap();
        for relay in [&rig.relay, &second] {
            assert_eq!(
                relay.address().ip(),
                std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)
            );
            assert_ne!(relay.address().port(), 0);
            assert_eq!(
                relay.origin(),
                format!("http://127.0.0.1:{}", relay.address().port())
            );
            // Not on the other loopback, and so not on every address either.
            assert!(std::net::TcpStream::connect_timeout(
                &SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, relay.address().port())),
                Duration::from_secs(2)
            )
            .is_err());
        }
        assert_ne!(rig.relay.address().port(), second.address().port());
        assert_ne!(rig.relay.entry(), second.entry());
    }

    /// A name that resolves to this computer is not this relay: only its own `127.0.0.1:<port>`.
    #[test]
    fn a_request_for_another_host_is_refused_and_never_reaches_openbot() {
        let rig = rig();
        let window = rig.window();
        let port = rig.relay.address().port();
        for host in [
            format!("localhost:{port}"),
            "openbot.example.com".to_owned(),
            format!("[::1]:{port}"),
            "127.0.0.1".to_owned(),
            format!("127.0.0.1:{}", port.wrapping_add(1)),
        ] {
            let answer = window.raw(&format!("GET {ECHO} HTTP/1.1"), &host);
            assert_eq!(
                status(&answer),
                "HTTP/1.1 421 Misdirected Request",
                "{host}"
            );
        }
        assert_eq!(rig.echoes(), 0);
        // Its own name is answered.
        let answer = window.raw(&format!("GET {ECHO} HTTP/1.1"), &window.host);
        assert_eq!(status(&answer), "HTTP/1.1 200 OK");
        assert_eq!(rig.echoes(), 1);
    }

    /// The relay goes to the typed address and nowhere else: a request that names another place
    /// to go is refused, and nothing leaves for anywhere.
    #[test]
    fn an_absolute_address_or_a_connect_goes_nowhere() {
        let rig = rig();
        let window = rig.window();
        for first_line in [
            format!("GET http://elsewhere.example{ECHO} HTTP/1.1"),
            format!("GET {}{ECHO} HTTP/1.1", rig.openbot.address()),
            "CONNECT elsewhere.example:443 HTTP/1.1".to_owned(),
        ] {
            let answer = window.raw(&first_line, &window.host);
            assert_eq!(status(&answer), "HTTP/1.1 403 Forbidden", "{first_line}");
        }
        assert_eq!(
            rig.openbot
                .requests()
                .iter()
                .filter(|seen| seen.contains("echo"))
                .count(),
            0
        );
        // A path that only looks like another host is a path at the typed address.
        let before = rig.openbot.seen().len();
        let answer = window.raw("GET //elsewhere.example/page HTTP/1.1", &window.host);
        assert_eq!(status(&answer), "HTTP/1.1 404 Not Found");
        let seen = rig.openbot.seen();
        assert_eq!(seen.len(), before + 1);
        assert_eq!(seen.last().unwrap().path, "//elsewhere.example/page");
    }

    /// OpenBot sees the app's token and none of what the browser adds: where the page is, its
    /// cookies, or a header claiming to speak for another proxy. The rest goes through.
    #[test]
    fn openbot_sees_the_bearer_token_and_no_origin_cookie_or_forwarding_header() {
        let rig = rig();
        let window = rig.window();
        let access = rig.session.access().unwrap();
        let sent = window.echo(
            window
                .request(reqwest::Method::POST, &format!("{ECHO}?thread=t-1&x=a%20b"))
                .header("origin", &window.origin)
                .header("cookie", format!("{}; theme=dark", window.cookie))
                .header("referer", format!("{}/channel/c-1", window.origin))
                .header("forwarded", "for=203.0.113.9")
                .header("x-forwarded-for", "203.0.113.9")
                .header("x-forwarded-host", "elsewhere.example")
                .header("x-forwarded-proto", "https")
                .header("authorization", "Bearer made-by-the-page")
                .header("x-request-id", "kept-as-sent")
                .header("content-type", "application/json")
                .body(r#"{"message":"hello"}"#),
        );
        let headers = sent["headers"].as_object().unwrap();
        assert_eq!(headers["authorization"], format!("Bearer {access}"));
        for gone in [
            "origin",
            "cookie",
            "referer",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
        ] {
            assert!(!headers.contains_key(gone), "{gone} reached OpenBot");
        }
        assert_eq!(headers["x-request-id"], "kept-as-sent");
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(
            headers["host"],
            rig.openbot.address().trim_start_matches("http://")
        );
        assert_eq!(sent["method"], "POST");
        assert_eq!(sent["query"], "thread=t-1&x=a%20b");
        assert_eq!(sent["body"], r#"{"message":"hello"}"#);
        // The token never comes back to the page.
        assert!(!sent.to_string().contains(&window.cookie));
    }

    /// OpenBot hears which apps a request came through: the name the window's page gave, then this
    /// app's, on OpenBot's API and on its pages alike. A page that names none is this app alone.
    #[test]
    fn openbot_hears_the_pages_app_and_then_this_one() {
        let rig = rig();
        let window = rig.window();
        let mine = format!("desktop/{}", crate::client_version::app_version());
        let sent = window.echo(window.get(ECHO).header("openbot-client", "web/1.1.0"));
        assert_eq!(
            sent["headers"]["openbot-client"],
            format!("web/1.1.0 {mine}")
        );
        let sent = window.echo(window.get(ECHO));
        assert_eq!(sent["headers"]["openbot-client"], mine.as_str());
        let page = window
            .get("/landing")
            .header("openbot-client", "web/1.1.0")
            .send()
            .unwrap();
        assert_eq!(page.status(), 200);
        assert_eq!(
            rig.openbot.seen_at("/landing")[0].header("openbot-client"),
            Some(format!("web/1.1.0 {mine}").as_str())
        );
    }

    #[test]
    fn a_cookie_openbot_sets_does_not_come_back() {
        let rig = rig();
        let answered = rig.window().get("/api/v2/cookie").send().unwrap();
        assert_eq!(answered.status(), 200);
        assert!(answered.headers().get("set-cookie").is_none());
        assert_eq!(answered.text().unwrap(), "ok");
        assert_eq!(rig.openbot.seen_at("/api/v2/cookie").len(), 1);
    }

    /// A chat answer arrives as it is written. OpenBot sends three events 400 ms apart; the page
    /// has the first well before the last is sent.
    #[test]
    fn a_stream_arrives_in_pieces_as_it_is_sent() {
        let rig = rig();
        let started = Instant::now();
        let mut answered = rig.window().get("/api/v2/stream").send().unwrap();
        assert_eq!(answered.headers()["content-type"], "text/event-stream");
        let mut arrivals = Vec::new();
        let mut buffer = [0u8; 256];
        loop {
            let read = answered.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            arrivals.push((
                started.elapsed(),
                String::from_utf8_lossy(&buffer[..read]).into_owned(),
            ));
        }
        let all: String = arrivals.iter().map(|(_, text)| text.as_str()).collect();
        assert_eq!(all, "data: 0\n\ndata: 1\n\ndata: 2\n\n");
        let (first_at, first) = &arrivals[0];
        let (last_at, _) = arrivals.last().unwrap();
        assert_eq!(first, "data: 0\n\n", "{arrivals:?}");
        assert!(*first_at < Duration::from_millis(350), "{arrivals:?}");
        assert!(
            *last_at - *first_at >= Duration::from_millis(600),
            "{arrivals:?}"
        );
    }

    fn socket_request(
        window: &Window,
        path: &str,
    ) -> tokio_tungstenite::tungstenite::handshake::client::Request {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://{}{path}", window.host)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", window.origin.parse().unwrap());
        request
    }

    /// A WebSocket through the relay: a real client on one side and a real server on the other,
    /// messages both ways, and the upgrade itself carrying the token.
    #[test]
    fn a_websocket_upgrade_echoes_both_ways_and_carries_the_bearer_token() {
        use futures_util::SinkExt;
        let rig = rig();
        let window = rig.window();
        rig.relay.set_organization(Some("org_socket"));
        let access = rig.session.access().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let connect = |request| async {
                let stream = tokio::net::TcpStream::connect(&window.host).await.unwrap();
                tokio_tungstenite::client_async(request, stream).await
            };
            // Without the window's cookie there is no socket, and OpenBot is not asked.
            let refused = connect(socket_request(&window, "/api/v2/socket")).await;
            assert!(refused.is_err());
            assert_eq!(rig.openbot.seen_at("/api/v2/socket").len(), 0);

            let mut request = socket_request(&window, "/api/v2/socket");
            request
                .headers_mut()
                .insert("cookie", window.cookie.parse().unwrap());
            let (mut socket, answered) = connect(request).await.unwrap();
            assert_eq!(answered.status(), 101);
            assert!(answered.headers().get("set-cookie").is_none());
            for said in ["hello", "and again"] {
                socket.send(said.into()).await.unwrap();
                let heard = socket.next().await.unwrap().unwrap();
                assert_eq!(heard.to_text().unwrap(), format!("echo: {said}"));
            }
            socket.close(None).await.unwrap();
        });
        let upgrade = rig.openbot.seen_at("/api/v2/socket").remove(0);
        assert_eq!(
            upgrade.header("authorization"),
            Some(format!("Bearer {access}").as_str())
        );
        assert_eq!(upgrade.header("upgrade"), Some("websocket"));
        assert_eq!(upgrade.header(ORGANIZATION_HEADER), Some("org_socket"));
        assert_eq!(upgrade.header("origin"), None);
        assert_eq!(upgrade.header("cookie"), None);
    }

    /// The person's OpenBot sign-in goes to OpenBot's API and nowhere else. On a company's cluster
    /// the same host name also serves things that are not OpenBot's, a socket at
    /// `/client/websocket` among them, and the app's own pages and files need no sign-in at all.
    /// Those go through the relay like everything else, with no token and no organisation named.
    #[test]
    fn the_sign_in_and_the_organisation_go_only_to_openbots_api() {
        use futures_util::SinkExt;
        let rig = rig();
        let window = rig.window();
        rig.relay.set_organization(Some("org_A1-b"));
        let access = rig.session.access().unwrap();
        let bearer = format!("Bearer {access}");

        // OpenBot's API, and an upgrade under it: both carried.
        let sent = window.echo(window.get(ECHO));
        assert_eq!(sent["headers"]["authorization"], bearer);
        assert_eq!(
            sent["headers"][ORGANIZATION_HEADER.to_ascii_lowercase()],
            "org_A1-b"
        );
        assert!(carries_the_sign_in("/api"));
        assert!(carries_the_sign_in("/api/me"));
        assert!(carries_the_sign_in(
            "/.well-known/oauth-authorization-server/api/auth"
        ));

        // The app's pages and files, whatever the page itself sends with them.
        for path in ["/", "/assets/app.js", "/landing"] {
            let answered = window
                .get(path)
                .header("authorization", "Bearer made-by-the-page")
                .header(ORGANIZATION_HEADER, "org_forged")
                .send()
                .unwrap();
            assert_eq!(answered.status(), 200, "{path}");
            let seen = rig.openbot.seen_at(path).remove(0);
            assert_eq!(seen.header("authorization"), None, "{path}");
            assert_eq!(seen.header(ORGANIZATION_HEADER), None, "{path}");
            assert_eq!(seen.header("cookie"), None, "{path}");
            assert_eq!(seen.header("origin"), None, "{path}");
        }
        for path in [
            "/client/websocket",
            "/apis",
            "/api-docs",
            "/API/v2/echo",
            "/x/api/v2/echo",
            "/.well-knownish",
        ] {
            assert!(!carries_the_sign_in(path), "{path}");
        }

        // The other service's socket: still connects through the relay and echoes both ways, and
        // its upgrade carries neither. The window's cookie is still what lets it through.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let connect = |request| async {
                let stream = tokio::net::TcpStream::connect(&window.host).await.unwrap();
                tokio_tungstenite::client_async(request, stream).await
            };
            assert!(connect(socket_request(&window, "/client/websocket"))
                .await
                .is_err());
            for path in ["/client/websocket", "/api/v2/socket"] {
                let mut request = socket_request(&window, path);
                request
                    .headers_mut()
                    .insert("cookie", window.cookie.parse().unwrap());
                request
                    .headers_mut()
                    .insert("authorization", "Bearer made-by-the-page".parse().unwrap());
                let (mut socket, answered) = connect(request).await.unwrap();
                assert_eq!(answered.status(), 101, "{path}");
                for said in ["hello", "and again"] {
                    socket.send(said.into()).await.unwrap();
                    let heard = socket.next().await.unwrap().unwrap();
                    assert_eq!(heard.to_text().unwrap(), format!("echo: {said}"));
                }
                socket.close(None).await.unwrap();
            }
        });
        let other = rig.openbot.seen_at("/client/websocket");
        assert_eq!(other.len(), 1, "the one without the cookie never arrived");
        assert_eq!(other[0].header("upgrade"), Some("websocket"));
        assert_eq!(other[0].header("authorization"), None);
        assert_eq!(other[0].header(ORGANIZATION_HEADER), None);
        assert_eq!(other[0].header("cookie"), None);
        let own = rig.openbot.seen_at("/api/v2/socket").remove(0);
        assert_eq!(own.header("authorization"), Some(bearer.as_str()));
        assert_eq!(own.header(ORGANIZATION_HEADER), Some("org_A1-b"));
        // No refresh was needed for any of it, and nothing ended.
        assert!(rig.ended.lock().unwrap().is_empty());
    }

    /// A path that is not OpenBot's API answers 401 for reasons of its own. That is not the
    /// person's sign-in being refused: no refresh is made, and the answer goes back as it is.
    #[test]
    fn a_401_from_outside_openbots_api_uses_no_refresh() {
        let rig = rig();
        let window = rig.window();
        let before = rig.openbot.token_requests().len();
        // The stand-in's OpenBot socket path, asked for under a prefix that is not the API's.
        let answered = window.get("/client/needs-its-own-token").send().unwrap();
        assert_eq!(answered.status(), 401);
        assert_eq!(rig.openbot.token_requests().len(), before);
        assert_eq!(rig.openbot.seen_at("/client/needs-its-own-token").len(), 1);
    }

    /// The access token ran out. OpenBot answers 401, the relay refreshes once, and the same
    /// request is sent again with the new token: the page sees only the answer.
    #[test]
    fn a_401_after_expiry_leads_to_one_refresh_and_the_request_again() {
        let rig = rig();
        let window = rig.window();
        let first = rig.session.access().unwrap();
        rig.openbot.expire_access_tokens();
        let refreshes = || {
            rig.openbot
                .token_requests()
                .iter()
                .filter(|request| request["grant_type"] == "refresh_token")
                .count()
        };
        assert_eq!(refreshes(), 0);

        let sent = window.echo(window.get(ECHO));

        assert_eq!(refreshes(), 1);
        let second = rig.session.access().unwrap();
        assert_ne!(second, first);
        assert_eq!(sent["headers"]["authorization"], format!("Bearer {second}"));
        let tries = rig.openbot.seen_at(ECHO);
        assert_eq!(tries.len(), 2, "refused once, then answered");
        assert_eq!(
            tries[0].header("authorization"),
            Some(format!("Bearer {first}").as_str())
        );
        // And the next request needs no refresh.
        window.echo(window.get(ECHO));
        assert_eq!(refreshes(), 1);
        assert!(rig.ended.lock().unwrap().is_empty());
    }

    /// Signed out elsewhere, or removed. The refresh is refused: the shell is told once that the
    /// session ended, the saved sign-in is forgotten, and the relay stops answering.
    #[test]
    fn a_refused_refresh_says_session_ended_and_the_relay_stops_answering() {
        let rig = rig();
        let window = rig.window();
        rig.openbot.end_sessions();

        let answered = window.get(ECHO).send().unwrap();
        assert_eq!(answered.status(), 401);

        let deadline = Instant::now() + Duration::from_secs(10);
        while rig.ended.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "the shell was never told");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(*rig.ended.lock().unwrap(), [Ended::SessionEnded]);
        assert_eq!(rig.store.get(&rig.openbot.address()).unwrap(), None);
        // No longer listening: a new connection is refused, or closed with no answer.
        let seen = rig.openbot.seen().len();
        loop {
            match window.get(ECHO).send() {
                Err(_) => break,
                Ok(answered) => {
                    assert_eq!(answered.status(), 401);
                    assert!(Instant::now() < deadline, "the relay kept answering");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        assert_eq!(
            rig.openbot.seen().len(),
            seen,
            "nothing more reached OpenBot"
        );
        assert_eq!(
            *rig.ended.lock().unwrap(),
            [Ended::SessionEnded],
            "said once"
        );
    }

    /// A page in the person's own browser, or another program on this computer, can send a
    /// request to `127.0.0.1:<port>` with the right `Host`. It does not have the run's secret,
    /// so it is refused and OpenBot never hears of it.
    #[test]
    fn a_request_without_the_windows_cookie_is_refused_and_never_reaches_openbot() {
        let rig = rig();
        let window = rig.window();
        let origin = rig.relay.origin();
        let refused = |request: reqwest::blocking::RequestBuilder| {
            let answered = request.send().unwrap();
            assert_eq!(answered.status(), 403);
            assert!(answered.headers().get("set-cookie").is_none());
        };
        // No cookie, a wrong one, and one that only starts like the right one.
        refused(http().get(format!("{origin}{ECHO}")));
        refused(
            http()
                .get(format!("{origin}{ECHO}"))
                .header("cookie", format!("{COOKIE}=guessed")),
        );
        refused(
            http()
                .get(format!("{origin}{ECHO}"))
                .header("cookie", format!("{}x", window.cookie)),
        );
        refused(http().post(format!("{origin}{ECHO}")).body("{}"));
        // The entry address with no key, or the wrong one, gives nothing.
        refused(http().get(format!("{origin}{ENTER_PATH}")));
        refused(http().get(format!("{origin}{ENTER_PATH}?key=guessed")));
        refused(http().post(rig.relay.entry()).header("content-length", "0"));
        assert_eq!(rig.openbot.seen_at(ECHO).len(), 0);
        assert_eq!(rig.openbot.seen_at(ENTER_PATH).len(), 0);

        // With the cookie the window was given, the same request goes through.
        window.echo(window.get(ECHO));
        assert_eq!(rig.echoes(), 1);
        // Nothing of the relay's own is ever forwarded, the entry address included.
        let own = window.get("/.openbot-relay/anything").send().unwrap();
        assert_eq!(own.status(), 404);
        assert!(rig
            .openbot
            .requests()
            .iter()
            .all(|seen| !seen.contains(".openbot-relay")));
    }

    /// Even with the cookie, a request another site's page made is refused: its `Origin` is not
    /// the relay's, or the browser says it came from another site.
    #[test]
    fn a_request_from_another_site_is_refused_even_with_the_cookie() {
        let rig = rig();
        let window = rig.window();
        for (name, value) in [
            ("origin", "https://elsewhere.example"),
            ("origin", "http://127.0.0.1:1"),
            ("origin", "null"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-site", "same-site"),
        ] {
            let answered = window.get(ECHO).header(name, value).send().unwrap();
            assert_eq!(answered.status(), 403, "{name}: {value}");
        }
        assert_eq!(rig.echoes(), 0);
        // The page's own requests say same-origin, or nothing at all.
        window.echo(
            window
                .get(ECHO)
                .header("origin", &window.origin)
                .header("sec-fetch-site", "same-origin"),
        );
        assert_eq!(rig.echoes(), 1);
    }

    /// A redirect is the page's to follow, not the relay's. One to the typed address is kept on
    /// the relay; one to anywhere else is handed back untouched.
    #[test]
    fn a_redirect_is_handed_back_and_kept_on_the_relay_when_it_is_openbots() {
        let rig = rig();
        let window = rig.window();
        let home = window.get("/api/v2/home").send().unwrap();
        assert_eq!(home.status(), 302);
        assert_eq!(
            home.headers()["location"],
            format!("{}/landing?from=home#top", window.origin).as_str()
        );
        let away = window.get("/api/v2/away").send().unwrap();
        assert_eq!(away.status(), 302);
        assert_eq!(away.headers()["location"], "https://elsewhere.example/page");
        assert_eq!(rig.openbot.seen_at("/landing").len(), 0, "not followed");
    }

    /// The shell names the organisation on every request, and the page cannot.
    #[test]
    fn the_chosen_organisation_is_named_on_every_request_and_only_by_the_shell() {
        let rig = rig();
        let window = rig.window();
        let named = |sent: &serde_json::Value| {
            sent["headers"]
                .get(ORGANIZATION_HEADER.to_ascii_lowercase())
                .cloned()
        };
        // None chosen: none sent, whatever the page says.
        assert_eq!(named(&window.echo(window.get(ECHO))), None);
        assert_eq!(
            named(&window.echo(window.get(ECHO).header(ORGANIZATION_HEADER, "org_forged"))),
            None
        );

        rig.relay.set_organization(Some("org_A1-b"));
        assert_eq!(
            named(&window.echo(window.get(ECHO))),
            Some("org_A1-b".into())
        );
        assert_eq!(
            named(&window.echo(window.get(ECHO).header(ORGANIZATION_HEADER, "org_forged"))),
            Some("org_A1-b".into())
        );
        // Something that is not an id is not sent.
        rig.relay.set_organization(Some("not an id"));
        assert_eq!(named(&window.echo(window.get(ECHO))), None);
        rig.relay.set_organization(None);
        assert_eq!(named(&window.echo(window.get(ECHO))), None);

        // A relay started again reads the choice back from connection.json.
        let config = crate::test_support::temp_root("relay-organisation");
        let chosen = super::super::choice::Choice {
            mode: super::super::choice::Mode::Connected,
            address: Some(rig.openbot.address()),
            organization_id: Some("org_kept".into()),
        };
        super::super::choice::write(&config, &chosen).unwrap();
        let read = super::super::choice::read(&config);
        let again =
            Relay::start(rig.session.clone(), read.organization_id.as_deref(), |_| {}).unwrap();
        let window = enter(&again);
        assert_eq!(
            named(&window.echo(window.get(ECHO))),
            Some("org_kept".into())
        );
        let _ = std::fs::remove_dir_all(config);
    }

    /// Signed out while working in another organisation, then signed in again at the same address:
    /// the new sign-in's relay names that organisation from its first request, because the app is
    /// what remembers it (a token remembers nothing). At another address it names none.
    #[test]
    fn a_new_sign_in_at_the_same_address_names_the_organisation_kept_through_sign_out() {
        use super::super::choice;
        let openbot = FakeOpenBot::start(Shape::Current);
        let store = in_memory();
        let first = openbot.sign_in(store.clone());
        // What the shell leaves in connection.json at sign-out: the address and the organisation.
        let config = crate::test_support::temp_root("relay-organisation-after-sign-out");
        let left = choice::Choice {
            mode: choice::Mode::Connected,
            address: Some(openbot.address()),
            organization_id: Some("org_kai".into()),
        };
        choice::write(&config, &left).unwrap();
        first.sign_out().unwrap();

        let again = Arc::new(openbot.sign_in(store.clone()));
        let next = choice::signed_in_at(&choice::read(&config), &openbot.address());
        assert_eq!(next.organization_id.as_deref(), Some("org_kai"));
        let relay = Relay::start(again.clone(), next.organization_id.as_deref(), |_| {}).unwrap();
        let window = enter(&relay);
        let sent = window.echo(window.get(ECHO));
        assert_eq!(
            sent["headers"].get(ORGANIZATION_HEADER.to_ascii_lowercase()),
            Some(&serde_json::Value::from("org_kai"))
        );

        let elsewhere = choice::signed_in_at(&choice::read(&config), "https://another.example.com");
        assert_eq!(elsewhere.organization_id, None);
        let _ = std::fs::remove_dir_all(config);
    }

    /// One request through the relay, so it keeps a connection to OpenBot open, and a moment for
    /// that connection to go back to be used again.
    fn keep_a_connection_open(window: &Window) {
        window.echo(window.get(ECHO));
        std::thread::sleep(Duration::from_millis(150));
    }

    /// A load balancer or an ingress in front of OpenBot closes a kept-open connection once it has
    /// been idle for a while, and the relay may send on it at that very moment: the request is
    /// written and the connection closes with no answer ("connection closed before message
    /// completed"). Nothing was wrong with OpenBot, so the page must not see a failure: a request
    /// that is safe to send twice goes once more, on a new connection.
    #[test]
    fn a_kept_open_connection_closed_as_it_is_used_is_not_a_failure_for_the_page() {
        let rig = rig();
        let window = rig.window();
        rig.openbot.close_kept_open_connections();

        keep_a_connection_open(&window);
        let sent = window.echo(window.get(&format!("{ECHO}?page=2")));
        assert_eq!(rig.openbot.closed_unanswered(), 1, "sent on the kept one");
        assert_eq!(sent["method"], "GET");
        assert_eq!(sent["query"], "page=2");

        // A write the API marks with an Idempotency-Key, its body whole: sent again, body and all.
        keep_a_connection_open(&window);
        let sent = window.echo(
            window
                .request(reqwest::Method::POST, ECHO)
                .header("idempotency-key", "key-1")
                .header("content-type", "application/json")
                .body(r#"{"name":"Ada"}"#),
        );
        assert_eq!(rig.openbot.closed_unanswered(), 2, "sent on the kept one");
        assert_eq!(sent["method"], "POST");
        assert_eq!(sent["body"], r#"{"name":"Ada"}"#);
        assert_eq!(sent["headers"]["idempotency-key"], "key-1");

        // Each reached OpenBot once: the two that kept the connection open, and the two again.
        assert_eq!(rig.echoes(), 4);
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            rig.ended.lock().unwrap().is_empty(),
            "the person was told OpenBot was unreachable"
        );
    }

    /// The same close, on a request that may not be sent twice: a write with no Idempotency-Key,
    /// a body that streams (so part of it may already be gone), or a socket. The page gets the
    /// relay's answer as before, and OpenBot is not sent it again.
    #[test]
    fn a_request_that_is_not_safe_to_send_twice_is_not_sent_again() {
        let rig = rig();
        let window = rig.window();
        rig.openbot.close_kept_open_connections();

        let streamed =
            || reqwest::blocking::Body::new(std::io::Cursor::new(br#"{"name":"Ada"}"#.to_vec()));
        let writes = [
            window
                .request(reqwest::Method::POST, ECHO)
                .header("content-type", "application/json")
                .body(r#"{"name":"Ada"}"#),
            window
                .request(reqwest::Method::POST, ECHO)
                .header("idempotency-key", "key-2")
                .body(streamed()),
        ];
        for (sent, write) in writes.into_iter().enumerate() {
            keep_a_connection_open(&window);
            let answered = write.send().unwrap();
            assert_eq!(answered.status(), 502, "write {sent}");
            assert_eq!(answered.text().unwrap(), "OpenBot could not be reached.");
            assert_eq!(rig.openbot.closed_unanswered(), sent + 1, "sent once");
        }
        assert_eq!(
            rig.echoes(),
            2,
            "only the two that kept the connection open"
        );

        keep_a_connection_open(&window);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let stream = tokio::net::TcpStream::connect(&window.host).await.unwrap();
            let mut request = socket_request(&window, "/api/v2/socket");
            request
                .headers_mut()
                .insert("cookie", window.cookie.parse().unwrap());
            assert!(tokio_tungstenite::client_async(request, stream)
                .await
                .is_err());
        });
        assert_eq!(rig.openbot.closed_unanswered(), 3, "the upgrade, sent once");
        assert_eq!(rig.openbot.seen_at("/api/v2/socket").len(), 0);
    }

    /// The entry address holds the run's secret, and the log's redaction covers it.
    #[test]
    fn the_entry_address_and_the_cookie_are_redacted_in_a_log_line() {
        let rig = rig();
        let window = rig.window();
        let secret = window.cookie.split_once('=').unwrap().1.to_owned();
        for line in [
            format!("[window] navigating to {}", rig.relay.entry()),
            format!("[relay] refused {}", window.cookie),
        ] {
            let written = crate::logging::redact(&line);
            assert!(!written.contains(&secret), "{written}");
            assert!(written.contains(crate::logging::REDACTED), "{written}");
        }
    }
}
