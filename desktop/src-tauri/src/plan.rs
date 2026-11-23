//! Signing in to a ChatGPT plan, and the images the two plans run on.
//!
//! A Claude plan's sign-in is native and lives in `claude_sign_in`: the browser comes back to a
//! loopback listener of Desktop's own, and nothing is pasted. ChatGPT's runs the vendor's own login
//! (`langchain-openai`'s `login_chatgpt`) in the image that also serves the plan, published on the
//! port its client registered. See `SigningInToChatGpt`.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

/**
The published name of the Claude Agent SDK harness image: the Bot a Claude plan runs on.

Named for the sign-in it once ran, which no longer needs it: the Claude plan's sign-in is native
(`claude_sign_in`). Install pulls it only for an installation on a Claude plan
(`preparation::PLAN_IMAGES`), and Start pulls it when a plan picks it.

A NAME, NOT A REFERENCE. This was `openbot-harness-claude-sdk:test`, which is what a development
tree builds: it resolved locally on the machine it was written on and, on a machine that had never
built anything, sent Podman to `docker.io/library/openbot-harness-claude-sdk`. Resolved through the
release's manifest by `crate::deployment::reference`, like every other image.
*/
pub const SIGN_IN_IMAGE: &str = "agent-claude-sdk";

/// Everything the terminal drew, with the escapes taken out. The vendor's login may colour what it
/// prints, and the link and the store are read from it.
fn plain(output: &str) -> String {
    let mut out = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI: ESC [ … final byte in @-~
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
            continue;
        }
        // OSC: ESC ] … terminated by BEL or ESC \
        if chars.peek() == Some(&']') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '\u{7}' {
                    break;
                }
                if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                    chars.next();
                    break;
                }
            }
            continue;
        }
        // Everything else: ESC, then zero or more intermediate bytes (0x20-0x2F), then one final
        // byte (0x30-0x7E). `ESC ( B`, a charset designation, is three bytes, not two.
        while let Some(&c) = chars.peek() {
            chars.next();
            if !(' '..='/').contains(&c) {
                break;
            }
        }
    }
    out
}

/// How long to wait for the login to show the URL. Machine time: a container start and an HTTP call.
const PATIENCE_FOR_THE_LINK: Duration = Duration::from_secs(90);

/// How long a person is given to approve in their browser: a password, a second factor, perhaps a
/// choice between accounts. Too short tells somebody who did nothing wrong that it did not work.
const PATIENCE_FOR_THE_PERSON: Duration = Duration::from_secs(600);

/// The published name of the image whose `langchain-openai` runs the ChatGPT sign-in.
///
/// The LangGraph harness, used as a tool rather than as a Bot: it is the image that already carries
/// the vendor's own login. Every install pulls it, because a ChatGPT plan also runs it as its model
/// service (`CHATGPT_PLAN_SERVICE`).
///
/// A name, not a reference: see `SIGN_IN_IMAGE`.
pub const CHATGPT_SIGN_IN_IMAGE: &str = "agent-langgraph-agui";

/// The Compose service that holds a signed-in ChatGPT plan's model transport.
///
/// The same image as the sign-in, run as a service beside the Bot. The Bot itself is the TypeScript
/// LangGraph image, and LangChain's ChatGPT plan model exists only in Python, so the Bot sends its
/// model calls here, and so do the server's own Bots on that plan. A service of its own behind its
/// own profile, started only on a ChatGPT plan, at Start or alone when the plan is chosen in the
/// app (`crate::ai_connection::Plan`), so every other installation runs one Bot image, not two.
pub const CHATGPT_PLAN_SERVICE: &str = "agent-chatgpt-plan";

/// Where the Bot and the server reach that service: its name on the Compose network and the port
/// its Dockerfile fixes. Written to `.env` as `CHATGPT_PLAN_HARNESS_URL` on every Start, so a plan
/// chosen in the app reaches it with no restart.
pub const CHATGPT_PLAN_URL: &str = "http://agent-chatgpt-plan:4206";

/// Where the vendor's login persists what it gets.
const CHATGPT_STORE: &str = "/root/.langchain/chatgpt-auth.json";

/// The port the vendor's login binds, and the port the container publishes to reach it.
///
/// Two different numbers on purpose. See `CHATGPT_LOGIN`.
const CHATGPT_LOOPBACK: u16 = 1455;
const CHATGPT_RELAY: u16 = 1456;

fn publish_chatgpt_callback(
    command: &mut std::process::Command,
    engine: crate::engine::Engine,
    os: &str,
) {
    // macOS Podman clears HostIP inside its VM, so dual loopback publishes become duplicate
    // mappings and rootlessport rejects them with "conflict with ID 1". See Podman's
    // libpod/networking_common.go::convertPortMappings. Windows Podman's IPv6 forward instead
    // accepts TCP but drops HTTP, preventing localhost from trying IPv4 (RFC 8305, sections 5/9.2).
    // Publish IPv4 only on these hosts: IPv6 refuses, allowing the registered localhost callback
    // to reach IPv4. Docker and native Linux Podman retain both loopback bindings.
    let hosts: &[&str] =
        if matches!(os, "windows" | "macos") && engine == crate::engine::Engine::Podman {
            &["127.0.0.1"]
        } else {
            &["127.0.0.1", "[::1]"]
        };
    for host in hosts {
        command.arg("-p");
        command.arg(format!("{host}:{CHATGPT_LOOPBACK}:{CHATGPT_RELAY}"));
    }
}

/**
The ChatGPT sign-in, as a program handed to the harness image.

WHY THERE IS A RELAY IN HERE. `langchain-openai` refuses a non-loopback callback host on purpose:
RFC 8252 wants a loopback redirect for a native app, and binding `0.0.0.0` would put the
authorization code on the local network. But a published Docker port cannot reach a `127.0.0.1`
listener inside the container. So the vendor's server keeps its loopback bind and this relay accepts
on `0.0.0.0:1456` and forwards into it. The container publishes 1456 as the host's 1455, which is
the address the browser is sent to.

AND THE HOST IS LEFT AT ITS DEFAULT, `localhost`, WHICH IS NOT COSMETIC. OpenAI compares the
redirect URI as a string, and `http://localhost:1455/auth/callback` is what is registered. Passing
`127.0.0.1` — the same address, a different string — makes the authorize request fail with
`unknown_error` before any login page is drawn. Measured, twice, before the cause was obvious.

AND WHAT IS PRINTED IS THE WHOLE STORE, NOT THE ACCESS TOKEN. The access token expires within the
hour and nothing can renew it; the store carries the refresh token beside it, which is what the
harness's provider renews from. Carrying only the token yields a Bot that answers until lunchtime
and then reports an auth failure nobody can account for.

Passed as an argument rather than a mounted file, so the app never has to write a script to disk to
run one.

AND THE RELAY ANSWERS WHAT THE VENDOR'S SERVER CANNOT. That server takes exactly one redirect and
closes, and it fails the whole sign-in on a redirect whose `state` is not its own. A browser can
come back more than once: a second tab opened from "Didn't open?", Back to OpenAI's page, a tab left
over from an earlier attempt. So the relay reads each request line before forwarding it. A callback
carrying another attempt's `state` gets a page saying the link is out of date, and never reaches the
vendor's server. A second callback after the first gets a page saying OpenBot already has this
sign-in. Before this, the first case failed a sign-in the person was in the middle of approving,
and the second got a connection closed with nothing said. The `state` is read off the line the
login prints its link on, the same line OpenBot reads the link from. If that line ever changes
shape the relay forwards everything, as it did before.
*/
const CHATGPT_LOGIN: &str = r#"
import builtins, json, socket, threading, time, urllib.parse
from pathlib import Path

CALLBACK = "/auth/callback"
LINK = "https://auth.openai.com/oauth/authorize"
link_state = []
received = threading.Event()
claim = threading.Lock()
say = builtins.print

def watch_for_link(*words, **options):
    for word in " ".join(str(w) for w in words).split():
        if word.startswith(LINK) and not link_state:
            link_state.extend(urllib.parse.parse_qs(urllib.parse.urlsplit(word).query).get("state", [])[:1])
    return say(*words, **options)

builtins.print = watch_for_link

STYLE = (
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2328}"
    "main{max-width:440px;margin:24px;padding:32px;border:1px solid #d8dee4;border-radius:12px;background:#fff}"
    "h1{font-size:22px;line-height:1.25;margin:0 0 12px}p{font-size:15px;line-height:1.5;margin:0;color:#57606a}"
    "@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}"
    "main{background:#161b22;border-color:#30363d}p{color:#9da7b3}}</style>"
)

def answer(client, status, heading, message):
    body = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>" + heading + "</title>" + STYLE + "</head><body><main><h1>" + heading
        + "</h1><p>" + message + "</p></main></body></html>"
    ).encode("utf-8")
    head = (
        "HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\n"
        "Content-Length: " + str(len(body)) + "\r\nCache-Control: no-store\r\n"
        "Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    try:
        client.sendall(head + body)
        client.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    finally:
        client.close()

# The whole head, through its blank line, not only the request line. A page the relay answers itself
# ends in a close, and a close with part of the request still unread resets the connection: the
# browser shows a reset instead of the page.
def request_head(client):
    data = b""
    client.settimeout(60)
    try:
        while b"\r\n\r\n" not in data and len(data) < 16384:
            chunk = client.recv(4096)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    return data

def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def serve(client):
    head = request_head(client)
    if not head:
        client.close()
        return
    try:
        target = urllib.parse.urlsplit(head.split(b"\r\n", 1)[0].split(b" ")[1].decode("latin-1"))
    except IndexError:
        target = urllib.parse.urlsplit("/")
    query = urllib.parse.parse_qs(target.query)
    is_callback = target.path == CALLBACK and ("code" in query or "error" in query)
    state = (query.get("state") or [""])[0]
    if is_callback and link_state and not state.startswith(link_state[0]):
        answer(client, "400 Bad Request", "This sign-in link is out of date",
               "OpenBot started a newer sign-in. Finish it in the newest tab OpenBot opened, or close this one.")
        return
    claimed = False
    if is_callback:
        with claim:
            claimed = not received.is_set()
            received.set()
        if not claimed:
            answer(client, "200 OK", "OpenBot already has this sign-in",
                   "You can close this tab and go back to OpenBot.")
            return
    upstream = None
    waited = time.monotonic() + 5
    while upstream is None:
        try:
            upstream = socket.create_connection(("127.0.0.1", __LOOPBACK_PORT__), timeout=10)
        except OSError:
            # Some other request's callback went through and the vendor's server has closed. Not
            # when this is that callback: it waits for the server like any request.
            if received.is_set() and not claimed:
                answer(client, "200 OK", "OpenBot already has this sign-in",
                       "You can close this tab and go back to OpenBot.")
                return
            if time.monotonic() > waited:
                answer(client, "503 Service Unavailable", "This sign-in has ended",
                       "OpenBot stopped waiting for it. Start the sign-in again from OpenBot.")
                return
            time.sleep(0.1)
    client.settimeout(None)
    upstream.settimeout(None)
    try:
        upstream.sendall(head)
    except OSError:
        client.close()
        upstream.close()
        return
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()

def relay():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", __RELAY_PORT__))
    listener.listen(8)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()

threading.Thread(target=relay, daemon=True).start()

from langchain_openai.chatgpt_oauth import login_chatgpt

login_chatgpt(open_browser=False, port=__LOOPBACK_PORT__, timeout=900)

raw = json.loads(Path(__STORE_PATH__).read_text())
if not (raw.get("access_token") or raw.get("token")):
    raise SystemExit("the sign-in finished but left no token behind")
print("OPENBOT_CHATGPT_STORE=" + json.dumps(raw, separators=(",", ":")), flush=True)
"#;

/**
Fill in the addresses the login program needs.

THE PLACEHOLDERS ARE UNDERSCORED FOR A REASON, and it is not style. They used to be bare words, and
`OPENBOT_CHATGPT_STORE=` contains one of them: rendering rewrote the program's own marker into
`print("OPENBOT_CHATGPT_"/root/..."=" + ...)`, which is a syntax error. The container then died
before it printed anything and the window said "the sign-in never offered a link to open" — a
failure with no relation to its cause, from a program that no test could see was malformed because
every test looked at the template rather than the rendering.
*/
fn render_login(template: &str) -> String {
    template
        .replace("__RELAY_PORT__", &CHATGPT_RELAY.to_string())
        .replace("__LOOPBACK_PORT__", &CHATGPT_LOOPBACK.to_string())
        .replace("__STORE_PATH__", &format!("{CHATGPT_STORE:?}"))
}

/**
A ChatGPT sign-in in progress.

NO TERMINAL HERE. This login finishes on its own when the browser redirect reaches the callback, so
nothing is ever typed and plain pipes are enough.

ITS CONTAINER HAS A NAME, because it holds a port. Killing `docker run` does
not stop the container it started, so a sign-in given up on kept the callback port until the
vendor's own timeout, and the next sign-in could not publish it. Stopping one removes its container.
*/
pub struct SigningInToChatGpt {
    child: std::process::Child,
    output: std::sync::Arc<std::sync::Mutex<String>>,
    engine: crate::engine::Address,
    container: String,
    attempt: u64,
    stopped: bool,
}

/// The path the vendor's login is redirected to, on `localhost:CHATGPT_LOOPBACK`.
const CHATGPT_CALLBACK_PATH: &str = "/auth/callback";

/**
How long OpenBot keeps answering the callback port after a sign-in ends.

THE PORT OUTLIVES THE SIGN-IN, ON PURPOSE. The vendor's server takes one redirect and closes, and
its container goes with it. A browser can still come back through OpenAI afterwards with a new code:
a second tab, Back to OpenAI's page, a tab left over from an attempt given up on. With nothing
listening that is "localhost refused to connect", which reads as a failed sign-in when OpenBot is in
fact signed in. RFC 8252 section 8.3 says to close the port once the response is received, and the
listener that redeems codes does exactly that. What stays is a page, not a listener: it never reads
or uses a code, it answers on loopback only, and it gives the port up to any new sign-in, to the
`/cancel` the Codex CLI sends when it wants the same port, and when this time runs out.
*/
const ANSWER_LATE_CALLBACKS_FOR: Duration = Duration::from_secs(15 * 60);

/// How long to wait for the engine to let go of the callback port once its container is gone.
const PATIENCE_FOR_THE_PORT: Duration = Duration::from_secs(3);

/// Each ChatGPT sign-in's number. A newer one owns the callback port; an older one ending does not
/// get to answer on it.
static CHATGPT_ATTEMPTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Who has the callback port on this machine: one sign-in's container, or the page after one.
///
/// Process-wide because the port is machine-wide. Two copies of state about one port is how a
/// sign-in ends up publishing a port its own app is still holding.
static CHATGPT_CALLBACK: std::sync::Mutex<CallbackPort> = std::sync::Mutex::new(CallbackPort {
    live: None,
    answering: None,
});

struct CallbackPort {
    /// The container of the sign-in in progress, so a new one or a cancel can stop it.
    live: Option<(crate::engine::Address, String)>,
    /// The page answering redirects that arrive after a sign-in ended.
    answering: Option<LateCallbacks>,
}

fn callback_port() -> std::sync::MutexGuard<'static, CallbackPort> {
    CHATGPT_CALLBACK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn current_attempt() -> u64 {
    CHATGPT_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst)
}

/// A new attempt's number, taking the port from whatever had it: the page after an earlier
/// sign-in, or an earlier sign-in still waiting. Returns once the port is free for this one.
fn take_the_callback_port() -> u64 {
    // A redirect OpenBot's page asked Desktop to catch for OpenBot Cloud's sign-in, on the same port.
    crate::sign_in_redirect::release_port(CHATGPT_LOOPBACK);
    let (attempt, live, answering) = {
        let mut port = callback_port();
        let attempt = CHATGPT_ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        (attempt, port.live.take(), port.answering.take())
    };
    if let Some(answering) = answering {
        answering.stop();
    }
    if let Some((engine, container)) = live {
        remove_container(&engine, &container);
    }
    attempt
}

/**
Let a redirect OpenBot's page asks Desktop to catch (`sign_in_redirect`) have the callback port.

Refused while a ChatGPT plan sign-in of Desktop's own is in progress: its container holds the port,
and a person is approving it. The page this module leaves on the port after one gives way, as it
does to any new sign-in.
*/
pub(crate) fn make_way_for_sign_in_redirect() -> Result<(), ()> {
    let answering = {
        let mut port = callback_port();
        if port.live.is_some() {
            return Err(());
        }
        port.answering.take()
    };
    if let Some(answering) = answering {
        answering.stop();
    }
    Ok(())
}

/// Once an attempt has ended, answer the redirects that still arrive for it. Not if a newer
/// attempt has begun since: the port is that one's.
fn answer_late_callbacks(attempt: u64, outcome: SignInOutcome) {
    let previous = {
        let mut port = callback_port();
        if current_attempt() != attempt {
            return;
        }
        port.answering.take()
    };
    if let Some(previous) = previous {
        previous.stop();
    }
    let Some(answering) = LateCallbacks::start(CHATGPT_LOOPBACK, outcome) else {
        return;
    };
    let mut port = callback_port();
    if current_attempt() == attempt {
        port.answering = Some(answering);
    } else {
        drop(port);
        answering.stop();
    }
}

/**
Stop the ChatGPT sign-in in progress, if there is one.

For when the person leaves it: another provider, Back, Escape. Left running, its container kept the
callback port and its browser tab could still finish, and the browser then said "You're signed in"
while the window had dropped the result. Stopped, that tab gets OpenBot's page saying the sign-in
ended. Whoever is waiting on `finish` gets an error, as the container is gone.
*/
pub fn cancel_chatgpt_sign_in() {
    let (attempt, (engine, container)) = {
        let mut port = callback_port();
        let Some(live) = port.live.take() else {
            return;
        };
        (
            CHATGPT_ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1,
            live,
        )
    };
    remove_container(&engine, &container);
    answer_late_callbacks(attempt, SignInOutcome::Ended);
}

/// Give the callback port back on Quit: stop any sign-in in progress and the page after one.
pub fn release_chatgpt_callback_port() {
    take_the_callback_port();
}

/// Remove a sign-in's container, which is what releases its published port. Waits for the engine,
/// within reason: an engine that does not answer is not a reason to hang a window.
fn remove_container(engine: &crate::engine::Address, container: &str) {
    let (binary, arguments) = engine.parts();
    let mut command = crate::quiet::command(binary);
    command.args(arguments);
    command.args(["rm", "-f", container]);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    let Ok(mut removing) = command.spawn() else {
        return;
    };
    let began = Instant::now();
    while began.elapsed() < Duration::from_secs(20) {
        if !matches!(removing.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = removing.kill();
    let _ = removing.wait();
}

/// How a sign-in ended, which is what a late redirect is told.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignInOutcome {
    SignedIn,
    Ended,
}

impl SignInOutcome {
    fn page(self) -> String {
        let (heading, lines): (&str, &[&str]) = match self {
            SignInOutcome::SignedIn => (
                "OpenBot is signed in to ChatGPT",
                &[
                    "This tab isn't needed. You can close it and go back to OpenBot.",
                    "To use a different ChatGPT account, sign in again from OpenBot.",
                ],
            ),
            SignInOutcome::Ended => (
                "This sign-in has ended",
                &["OpenBot stopped waiting for it. Start the sign-in again from OpenBot."],
            ),
        };
        let lines: String = lines.iter().map(|line| format!("<p>{line}</p>")).collect();
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <title>{heading}</title><style>\
             body{{margin:0;min-height:100vh;display:grid;place-items:center;\
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\
             background:#f6f7f9;color:#1f2328}}\
             main{{max-width:440px;margin:24px;padding:32px;border:1px solid #d8dee4;\
             border-radius:12px;background:#fff}}\
             h1{{font-size:22px;line-height:1.25;margin:0 0 12px}}\
             p{{font-size:15px;line-height:1.5;margin:0;color:#57606a}}p+p{{margin-top:8px}}\
             @media (prefers-color-scheme: dark){{body{{background:#0d1117;color:#e6edf3}}\
             main{{background:#161b22;border-color:#30363d}}p{{color:#9da7b3}}}}\
             </style></head><body><main><h1>{heading}</h1>{lines}</main></body></html>"
        )
    }
}

/**
The page on the callback port between sign-ins. See `ANSWER_LATE_CALLBACKS_FOR`.

Bound on both loopbacks, as Docker publishes the sign-in's own port: a browser resolving `localhost`
tries either. Started only once the sign-in's container is gone, so it never competes with it.
*/
struct LateCallbacks {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    serving: std::thread::JoinHandle<()>,
}

impl LateCallbacks {
    /// Bound before this returns, so a redirect that arrives the moment a sign-in ends is answered.
    /// None when the port stays busy: something else on this machine has it, and that wins.
    fn start(port: u16, outcome: SignInOutcome) -> Option<Self> {
        use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};

        let addresses = [
            SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        ];
        let mut bound: [Option<TcpListener>; 2] = [None, None];
        let mut busy = [true, true];
        let began = Instant::now();
        loop {
            for (at, address) in addresses.iter().enumerate() {
                if bound[at].is_some() || !busy[at] {
                    continue;
                }
                match TcpListener::bind(address) {
                    Ok(listener) => bound[at] = Some(listener),
                    // The engine can take a moment to let go once the container is removed.
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
                    // No IPv6 loopback on this machine, say. Nothing to wait for.
                    Err(_) => busy[at] = false,
                }
            }
            let waiting = (0..2).any(|at| bound[at].is_none() && busy[at]);
            if !waiting || began.elapsed() >= PATIENCE_FOR_THE_PORT {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let listeners: Vec<TcpListener> = bound
            .into_iter()
            .flatten()
            .filter(|listener| listener.set_nonblocking(true).is_ok())
            .collect();
        if listeners.is_empty() {
            return None;
        }

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopping = std::sync::Arc::clone(&stop);
        let serving = std::thread::spawn(move || {
            let until = Instant::now() + ANSWER_LATE_CALLBACKS_FOR;
            while !stopping.load(std::sync::atomic::Ordering::SeqCst) && Instant::now() < until {
                let accepted = listeners.iter().find_map(|listener| listener.accept().ok());
                match accepted {
                    Some((stream, _)) => {
                        if !answer_late_callback(stream, outcome) {
                            return;
                        }
                    }
                    None => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        });
        Some(Self { stop, serving })
    }

    /// Stop answering and let the port go. Returns once it has.
    fn stop(self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.serving.join();
    }
}

/**
Answer one request on the callback port. False when asked to give the port up.

The request line is read for its path and nothing else. The query of a late redirect carries a
live authorization code, and this page has no use for it: it is not parsed, kept or logged.
*/
fn answer_late_callback(mut stream: std::net::TcpStream, outcome: SignInOutcome) -> bool {
    // An accepted socket inherits non-blocking from its listener on macOS and Windows.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let mut head = Vec::new();
    let mut buffer = [0u8; 2048];
    while !head.windows(2).any(|pair| pair == b"\r\n") && head.len() < 16 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => head.extend_from_slice(&buffer[..read]),
        }
    }
    let line = head.split(|byte| *byte == b'\r').next().unwrap_or_default();
    let target = line.split(|byte| *byte == b' ').nth(1).unwrap_or_default();
    let path = target
        .split(|byte| *byte == b'?')
        .next()
        .unwrap_or_default();

    let (status, kind, body, keep_answering) = match path {
        path if path == CHATGPT_CALLBACK_PATH.as_bytes() => {
            ("200 OK", "text/html; charset=utf-8", outcome.page(), true)
        }
        // The Codex CLI's convention for taking this port from a login server it finds on it.
        b"/cancel" => (
            "200 OK",
            "text/plain; charset=utf-8",
            "Login cancelled".to_string(),
            false,
        ),
        _ => (
            "404 Not Found",
            "text/plain; charset=utf-8",
            String::new(),
            true,
        ),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
    // Let the browser close first, so the port is not left in TIME_WAIT for the next sign-in.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
    keep_answering
}

impl SigningInToChatGpt {
    /**
    Start the flow and return the URL a browser has to open.

    THE PORT IS TAKEN FIRST. Whatever had the callback port is stopped before the new container
    publishes it: the page after an earlier sign-in, or an earlier sign-in still waiting, which is
    what a person who chose another provider and came back leaves behind. Before this, the second
    sign-in failed with "port is already allocated" while the first one's tab could still finish.
    */
    pub fn begin(
        engine: &crate::engine::Address,
        image: &str,
    ) -> Result<(Self, String), crate::problem::Problem> {
        let program = render_login(CHATGPT_LOGIN);
        let attempt = take_the_callback_port();
        let container = format!("openbot-chatgpt-sign-in-{}-{attempt}", std::process::id());
        {
            let mut port = callback_port();
            if current_attempt() == attempt {
                port.live = Some((engine.clone(), container.clone()));
            }
        }

        let (binary, arguments) = engine.parts();
        let mut command = crate::quiet::command(binary);
        command.args(arguments);
        command.arg("run");
        command.arg("--pull=never");
        command.arg("--rm");
        command.arg("--name");
        command.arg(&container);
        /*
         * Published on loopback only, and on the number the vendor's login advertises.
         *
         * The container's relay listens on `CHATGPT_RELAY` and forwards to the login's own
         * loopback bind; the browser is sent to `CHATGPT_LOOPBACK` on this machine.
         * publish_chatgpt_callback handles the macOS and Windows Podman forwarding limitations.
         */
        publish_chatgpt_callback(&mut command, engine.engine, std::env::consts::OS);
        command.arg(image);
        command.arg("python");
        command.arg("-u");
        command.arg("-c");
        command.arg(program);
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let mut port = callback_port();
                if port
                    .live
                    .as_ref()
                    .is_some_and(|(_, live)| *live == container)
                {
                    port.live = None;
                }
                return Err(crate::problem::Problem::with(
                    "OpenBot could not start the sign-in with OpenAI.",
                    error.to_string(),
                ));
            }
        };

        // Both streams, because the vendor's login prints its fallback URL to whichever it prefers
        // and that is not ours to depend on.
        let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let held = std::sync::Arc::clone(&output);
        if let Some(mut out) = child.stdout.take() {
            std::thread::spawn(move || drain(&mut out, held));
        }
        let held = std::sync::Arc::clone(&output);
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || drain(&mut err, held));
        }

        let mut signing = Self {
            child,
            output,
            engine: engine.clone(),
            container,
            attempt,
            stopped: false,
        };
        let url = signing
            .wait_for(openai_url_in, PATIENCE_FOR_THE_LINK)
            .ok_or_else(|| signing.gave_up())?;
        // Cancelled, or replaced by a newer sign-in, while this one was starting. Nobody is to be
        // sent to a link whose listener is about to go.
        if current_attempt() != attempt {
            signing.stop();
            return Err(crate::problem::Problem::with(
                "The sign-in was stopped. Start it again.",
                "a newer sign-in or a cancel replaced this one while it started",
            ));
        }
        Ok((signing, url))
    }

    /**
    Give up, saying it twice.

    THE CONTAINER'S OUTPUT IS THE WHOLE DIAGNOSIS HERE, and withholding it cost real time. A
    rendering bug made the login program a syntax error, so it died before printing anything and the
    window said only "the sign-in never offered a link to open" — true, useless, and unrelatable to
    its cause. What Python said is now kept beside the sentence, where whoever is debugging can open
    it and nobody else has to look.

    This is safe to carry: a store is printed on one marked
    line and only after a successful login, so a run that failed to produce a link has no credential
    in its output to leak. The marker line is stripped regardless, because "no credential here" is
    not a thing to be almost sure about.
    */
    fn gave_up(&mut self) -> crate::problem::Problem {
        let said = String::from("OpenBot could not start the sign-in with OpenAI.");
        let detail = self
            .output
            .lock()
            .map(|seen| {
                seen.lines()
                    .filter(|line| !line.contains("OPENBOT_CHATGPT_STORE="))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        self.stop();
        crate::problem::Problem::with(said, detail)
    }

    /// Wait for the browser redirect to complete the login, and return the token store.
    ///
    /// Nothing is sent: the callback is what finishes this, so all there is to do is wait for the
    /// program to say what it got. What comes back is the vendor's whole store, refresh token
    /// included, because an access token on its own stops working within the hour.
    ///
    /// Either way the port is then answered for a while, saying how this one ended. See
    /// `ANSWER_LATE_CALLBACKS_FOR`.
    pub fn finish(mut self) -> Result<String, String> {
        let result = self
            .wait_for(chatgpt_store_in, PATIENCE_FOR_THE_PERSON)
            .ok_or_else(|| {
                "That sign-in did not finish. Start it again and approve the request in your browser."
                    .to_string()
            });
        self.stop();
        answer_late_callbacks(
            self.attempt,
            if result.is_ok() {
                SignInOutcome::SignedIn
            } else {
                SignInOutcome::Ended
            },
        );
        result
    }

    fn wait_for<T>(&mut self, found: impl Fn(&str) -> Option<T>, patience: Duration) -> Option<T> {
        let began = Instant::now();
        while began.elapsed() < patience {
            if let Ok(seen) = self.output.lock() {
                if let Some(value) = found(&seen) {
                    return Some(value);
                }
            }
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                std::thread::sleep(Duration::from_millis(150));
                return self.output.lock().ok().and_then(|seen| found(&seen));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }

    /// Remove the container, which is what frees the port, then reap the command that ran it.
    fn stop(&mut self) {
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        remove_container(&self.engine, &self.container);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let mut port = callback_port();
        if port
            .live
            .as_ref()
            .is_some_and(|(_, live)| *live == self.container)
        {
            port.live = None;
        }
    }
}

/// A sign-in dropped without finishing still gives its port back.
impl Drop for SigningInToChatGpt {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accumulate a child's stream. Never printed: the tail of it is a token.
fn drain<R: Read>(stream: &mut R, into: std::sync::Arc<std::sync::Mutex<String>>) {
    let mut buffer = [0u8; 8192];
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let Ok(mut held) = into.lock() else { break };
        held.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
}

/// The token the vendor's login printed, if it got one.
///
/// Its own line rather than scraped out of the store file, because the store shape belongs to the
/// library and the line is this deployment's own contract with the program above.
pub fn chatgpt_store_in(output: &str) -> Option<String> {
    plain(output)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("OPENBOT_CHATGPT_STORE="))
        .map(str::trim)
        // A store is an object. Anything else is a half-read line, and writing it to the file the
        // harness reads would turn a sign-in that looked fine into a Bot that cannot start.
        .find(|store| store.starts_with('{') && store.ends_with('}') && store.len() > 2)
        .map(str::to_string)
}

/// The address a browser has to open for the ChatGPT sign-in.
///
/// Printed by the vendor's login as its fallback when `open_browser` is off, which is how this gets
/// it: OpenBot opens the browser itself so the window can also show the link.
pub fn openai_url_in(output: &str) -> Option<String> {
    plain(output)
        .split_whitespace()
        .find(|word| word.starts_with("https://auth.openai.com/oauth/authorize"))
        .map(str::to_string)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::engine::Engine;

    #[test]
    fn subscription_containers_never_download_software() {
        if crate::test_support::isolated_process(
            "plan::tests::subscription_containers_never_download_software",
        ) {
            return;
        }
        let root = crate::test_support::temp_root("subscription-without-downloads");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("docker.rs");
        std::fs::write(&source, r#"
use std::io::Write;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Stopping the ChatGPT sign-in removes its container by name. Nothing to remove here.
    if args.first().map(String::as_str) == Some("rm") {
        return;
    }
    assert_eq!(args.first().map(String::as_str), Some("run"));
    assert!(args.iter().any(|arg| arg == "--pull=never"), "subscription login must refuse missing images");
    println!("https://auth.openai.com/oauth/authorize?synthetic=prepared");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}
"#).unwrap();
        crate::test_support::compile_fixture(
            &source,
            &root.join(format!("docker{}", std::env::consts::EXE_SUFFIX)),
        );
        std::env::set_var("PATH", &root);
        let address = crate::engine::Address::new(Engine::Docker, None);
        let (mut chatgpt, url) = SigningInToChatGpt::begin(&address, "synthetic-chatgpt").unwrap();
        assert!(url.contains("synthetic=prepared"));
        chatgpt.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chatgpt_callback_uses_one_loopback_mapping_for_macos_and_windows_podman() {
        for (engine, os, hosts) in [
            (Engine::Podman, "windows", vec!["127.0.0.1"]),
            (Engine::Podman, "macos", vec!["127.0.0.1"]),
            (Engine::Podman, "linux", vec!["127.0.0.1", "[::1]"]),
            (Engine::Docker, "windows", vec!["127.0.0.1", "[::1]"]),
            (Engine::Docker, "macos", vec!["127.0.0.1", "[::1]"]),
            (Engine::Docker, "linux", vec!["127.0.0.1", "[::1]"]),
        ] {
            let mut command = crate::quiet::command(engine.binary());
            publish_chatgpt_callback(&mut command, engine, os);
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect();
            let expected: Vec<String> = hosts
                .into_iter()
                .flat_map(|host| ["-p".into(), format!("{host}:1455:1456")])
                .collect();
            assert_eq!(args, expected, "{engine:?}, OS={os}");
        }
    }

    /// The store line is this deployment's contract with the program it hands the image.
    #[test]
    fn the_chatgpt_store_is_read_off_its_own_line() {
        let output = "some chatter\nOPENBOT_CHATGPT_STORE={\"access_token\":\"a\",\"refresh_token\":\"r\"}\nmore\n";
        assert_eq!(
            chatgpt_store_in(output).as_deref(),
            Some("{\"access_token\":\"a\",\"refresh_token\":\"r\"}")
        );
        assert_eq!(chatgpt_store_in("OPENBOT_CHATGPT_STORE=\n"), None);
        assert_eq!(chatgpt_store_in("nothing here"), None);
    }

    /// A truncated store is worse than none: it would be written to the file the harness reads.
    #[test]
    fn a_half_read_store_line_is_refused() {
        assert_eq!(chatgpt_store_in("OPENBOT_CHATGPT_STORE={\"access_to"), None);
        assert_eq!(chatgpt_store_in("OPENBOT_CHATGPT_STORE={}"), None);
    }

    /**
    THE RENDERED PROGRAM, not the template, because rendering is where it broke.

    A bare `STORE` placeholder rewrote the marker in the program's own print line and the container
    died on a syntax error. Every assertion here is about the string that is actually handed to
    Python.
    */
    #[test]
    fn rendering_leaves_the_marker_and_the_addresses_intact() {
        let program = render_login(CHATGPT_LOGIN);
        assert!(
            program.contains(r#"print("OPENBOT_CHATGPT_STORE=" + json.dumps(raw"#),
            "rendering damaged the line the deployment reads:\n{program}"
        );
        assert!(
            !program.contains("__"),
            "a placeholder survived rendering:\n{program}"
        );
        assert!(program.contains(&format!("(\"0.0.0.0\", {CHATGPT_RELAY})")));
        assert!(program.contains(&format!("port={CHATGPT_LOOPBACK}")));
        assert!(program.contains(&format!("{CHATGPT_STORE:?}")));
        // What the reader looks for has to survive what the writer produces.
        assert_eq!(
            chatgpt_store_in("OPENBOT_CHATGPT_STORE={\"a\":1}").as_deref(),
            Some("{\"a\":1}")
        );
    }

    /// The URL the vendor's login prints as its fallback.
    #[test]
    fn the_openai_url_is_found() {
        let real = "https://auth.openai.com/oauth/authorize?client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
        assert_eq!(
            openai_url_in(&format!("Open this: {real}\n")).as_deref(),
            Some(real)
        );
        assert_eq!(openai_url_in("no url yet"), None);
    }

    /// The callback port is one port on the whole machine, so the tests that publish it take turns.
    /// Each runs in its own process (`isolated_process`), and this is held around that process.
    pub(crate) static CALLBACK_PORT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /**
    A container engine for the ChatGPT sign-in, faithful where this bug lives: the callback port.

    `run` publishes each `-p` loopback address on this machine as Docker does, and a second publish
    of a port still held fails with Docker's own message and exit code. It prints the authorize link
    the vendor's login prints, answers the first callback with the vendor's success page, prints the
    store line and exits, which releases the ports as Docker removes its forwards when a container
    ends. `rm -f NAME` stops the run of that name and returns once it is gone, as Docker's does.
    */
    const FAKE_ENGINE: &str = r#"
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let here = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    match args.first().map(String::as_str) {
        Some("rm") => remove(&here, args.last().unwrap()),
        Some("run") => run(&args, &here),
        other => panic!("unexpected engine command {other:?}"),
    }
}

fn remove(here: &Path, name: &str) {
    let pid = here.join(format!("{name}.pid"));
    if !pid.exists() {
        return;
    }
    std::fs::write(here.join(format!("{name}.stop")), "").unwrap();
    // Back once the container is gone, however long a busy computer takes, as Docker's is. Two
    // minutes is not stopping at all, and fails loudly.
    let began = Instant::now();
    while pid.exists() {
        if began.elapsed() > Duration::from_secs(120) {
            eprintln!("Error response from daemon: could not kill container {name}: it is still running");
            std::process::exit(1);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run(args: &[String], here: &Path) {
    let mut listeners = Vec::new();
    let mut name: Option<String> = None;
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "-p" => {
                let (published, _inside) = args[at + 1].rsplit_once(':').unwrap();
                let address: SocketAddr = published.parse().unwrap();
                match TcpListener::bind(address) {
                    Ok(listener) => listeners.push(listener),
                    Err(_) => {
                        eprintln!("docker: Error response from daemon: driver failed programming external connectivity on endpoint sign-in: Bind for {published} failed: port is already allocated.");
                        std::process::exit(125);
                    }
                }
                at += 2;
            }
            "--name" => {
                name = Some(args[at + 1].clone());
                at += 2;
            }
            _ => at += 1,
        }
    }
    let pid: Option<PathBuf> = name.as_ref().map(|name| here.join(format!("{name}.pid")));
    if let Some(pid) = &pid {
        std::fs::write(pid, std::process::id().to_string()).unwrap();
    }
    let stop: Option<PathBuf> = name.as_ref().map(|name| here.join(format!("{name}.stop")));
    let end = |listeners: Vec<TcpListener>, code: i32| -> ! {
        drop(listeners);
        if let Some(pid) = &pid {
            let _ = std::fs::remove_file(pid);
        }
        std::process::exit(code)
    };

    println!("\nChatGPT sign-in: open the following URL in a browser:\n  https://auth.openai.com/oauth/authorize?client_id=app_synthetic&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=synthetic{}\n", std::process::id());
    std::io::stdout().flush().unwrap();
    for listener in &listeners {
        listener.set_nonblocking(true).unwrap();
    }
    let began = Instant::now();
    loop {
        if stop.as_ref().is_some_and(|stop| stop.exists()) {
            end(listeners, 137);
        }
        // Only so a run nobody stops does not outlive its test.
        if began.elapsed() > Duration::from_secs(120) {
            end(listeners, 1);
        }
        let accepted = listeners.iter().find_map(|listener| listener.accept().ok());
        if let Some((mut stream, _)) = accepted {
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut head = Vec::new();
            let mut buffer = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => head.extend_from_slice(&buffer[..read]),
                }
            }
            let head = String::from_utf8_lossy(&head);
            if head.starts_with("GET /auth/callback?") && head.contains("code=") {
                let body = "<h1>You're signed in</h1>";
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                drop(stream);
                println!("OPENBOT_CHATGPT_STORE={{\"access_token\":\"synthetic-access\",\"refresh_token\":\"synthetic-refresh\"}}");
                std::io::stdout().flush().unwrap();
                end(listeners, 0);
            }
            let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
"#;

    /// Put the fake engine first on PATH, as `docker`. Only call this in an isolated process.
    fn fake_engine(label: &str) -> std::path::PathBuf {
        let root = crate::test_support::temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("docker.rs");
        std::fs::write(&source, FAKE_ENGINE).unwrap();
        crate::test_support::compile_fixture(
            &source,
            &root.join(format!("docker{}", std::env::consts::EXE_SUFFIX)),
        );
        std::env::set_var("PATH", &root);
        root
    }

    fn state_of(url: &str) -> String {
        url.split("state=").nth(1).unwrap().to_string()
    }

    /// The browser arriving back from OpenAI, on the address OpenAI sends it to.
    fn browser_returns(code: &str, state: &str) -> std::io::Result<String> {
        callback_on(CHATGPT_LOOPBACK, code, state)
    }

    fn callback_on(port: u16, code: &str, state: &str) -> std::io::Result<String> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        write!(
            stream,
            "GET /auth/callback?code={code}&scope=openid&state={state} HTTP/1.1\r\n\
             Host: localhost:{port}\r\nConnection: close\r\n\r\n"
        )?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply)
    }

    /// A callback whose request head is longer than one read, as a browser's can be with its
    /// cookies, sent whole. The reply is read a moment later, once any reset has arrived.
    #[cfg(unix)]
    fn crowded_callback_on(port: u16, code: &str, state: &str) -> std::io::Result<String> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let cookie = "c".repeat(6000);
        stream.write_all(
            format!(
                "GET /auth/callback?code={code}&scope=openid&state={state} HTTP/1.1\r\n\
                 Host: localhost:{port}\r\nCookie: session={cookie}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )?;
        std::thread::sleep(Duration::from_millis(100));
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply)
    }

    /**
    The vendor's `login_chatgpt`, keeping every part of the real one (langchain-openai 1.6.1) the
    relay meets: it prints the authorize link, binds an `HTTPServer` on `localhost:port` a moment
    later, handles one request at a time until one carries a code or an error, answers that one
    with its success page, closes, and only then checks the `state`, failing the whole sign-in on
    one that is not its own. The token exchange with OpenAI is a pause; the store lands under the
    home directory.
    */
    #[cfg(unix)]
    const FAKE_CHATGPT_OAUTH: &str = r#"
import http.server, json, secrets, time, urllib.parse
from pathlib import Path

def login_chatgpt(*, store_path=None, host="localhost", port=1455, callback_path="/auth/callback", open_browser=True, timeout=300.0):
    state = secrets.token_urlsafe(32)
    redirect_uri = "http://" + host + ":" + str(port) + callback_path
    query = urllib.parse.urlencode({"client_id": "app_synthetic", "response_type": "code", "redirect_uri": redirect_uri, "state": state})
    print("\nChatGPT sign-in: open the following URL in a browser:\n  https://auth.openai.com/oauth/authorize?" + query + "\n")
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                return
            for key, value in urllib.parse.parse_qs(parsed.query).items():
                if key in ("code", "state", "error"):
                    result[key] = value[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<h1>You're signed in</h1>")

        def log_message(self, format, *args):
            return

    # Long enough that the attempt's own callback reaches the relay before this server listens. The
    # relay must hold it until the server is up, not answer it as a second one.
    time.sleep(0.5)
    server = http.server.HTTPServer((host, port), Handler)
    server.timeout = 1.0
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            server.handle_request()
            if result.get("code") or result.get("error"):
                break
        else:
            raise TimeoutError("Timed out waiting for ChatGPT OAuth callback")
    finally:
        server.server_close()
    if result.get("state") != state:
        raise RuntimeError("ChatGPT OAuth callback state mismatch.")
    time.sleep(1.5)
    path = Path(store_path) if store_path else Path.home() / ".langchain" / "chatgpt-auth.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}))
"#;

    #[cfg(unix)]
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /**
    The login program itself, run by Python against the stand-in above: the relay keeps redirects
    that are not this attempt's first away from the vendor's server.

    A redirect from an earlier attempt's tab used to reach that server, take the one request it
    serves, show "You're signed in" and then fail the sign-in the person was in the middle of. A
    second redirect after the first used to get a connection closed with nothing said.

    The attempt's own redirect, arriving before that server listened, used to be told "OpenBot
    already has this sign-in" and never reach it, so the sign-in never finished. And a page the
    relay answers itself used to close the connection with part of the request unread, which reset
    it: the browser showed a reset, not the page.
    */
    #[test]
    #[cfg(unix)]
    fn the_relay_keeps_other_redirects_away_from_the_sign_in_in_progress() {
        // Its relay and upstream take free ports; no other port test may take one in between.
        let _ports = crate::test_support::hold_ports();
        let root = crate::test_support::temp_root("chatgpt-relay");
        let package = root.join("langchain_openai");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("__init__.py"), "").unwrap();
        std::fs::write(package.join("chatgpt_oauth.py"), FAKE_CHATGPT_OAUTH).unwrap();
        let store = root.join(".langchain").join("chatgpt-auth.json");
        // Two different ports: a port given back can be handed out again at once.
        let relay = free_port();
        let loopback = std::iter::repeat_with(free_port)
            .find(|port| *port != relay)
            .unwrap();
        // Rendered as `render_login` does, with this test's ports, its store, and loopback for the
        // relay: a test has no business listening on the network.
        let program = CHATGPT_LOGIN
            .replace("__RELAY_PORT__", &relay.to_string())
            .replace("__LOOPBACK_PORT__", &loopback.to_string())
            .replace(
                "__STORE_PATH__",
                &format!("{:?}", store.display().to_string()),
            )
            .replace("(\"0.0.0.0\",", "(\"127.0.0.1\",");

        let mut python = std::process::Command::new("python3")
            .args(["-u", "-c", &program])
            .env("PYTHONPATH", &root)
            .env("HOME", &root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("python3 runs the login program");
        let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let held = std::sync::Arc::clone(&output);
        let mut out = python.stdout.take().unwrap();
        std::thread::spawn(move || drain(&mut out, held));
        let held = std::sync::Arc::clone(&output);
        let mut err = python.stderr.take().unwrap();
        std::thread::spawn(move || drain(&mut err, held));
        let began = Instant::now();
        let url = loop {
            if let Some(url) = openai_url_in(&output.lock().unwrap()) {
                break url;
            }
            assert!(began.elapsed() < Duration::from_secs(20), "no link printed");
            std::thread::sleep(Duration::from_millis(50));
        };
        let state = url
            .split("state=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();

        let earlier = callback_on(relay, "ac.earlier", "from-an-earlier-attempt").unwrap();
        assert!(earlier.starts_with("HTTP/1.1 400"), "{earlier}");
        assert!(
            earlier.contains("This sign-in link is out of date"),
            "{earlier}"
        );
        let crowded = crowded_callback_on(relay, "ac.crowded", "from-an-earlier-attempt").unwrap();
        assert!(
            crowded.contains("This sign-in link is out of date"),
            "{crowded}"
        );

        let first = callback_on(relay, "ac.first", &state).unwrap();
        assert!(first.contains("You're signed in"), "{first}");

        let again = callback_on(relay, "ac.again", &state).unwrap();
        assert!(
            again.contains("OpenBot already has this sign-in"),
            "{again}"
        );
        assert!(
            !again.contains("ac.again"),
            "the page must never echo a code"
        );

        let began = Instant::now();
        let status = loop {
            if let Some(status) = python.try_wait().unwrap() {
                break status;
            }
            assert!(
                began.elapsed() < Duration::from_secs(20),
                "the login did not end"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        std::thread::sleep(Duration::from_millis(100));
        let said = output.lock().unwrap().clone();
        assert!(status.success(), "the sign-in in progress failed:\n{said}");
        assert!(chatgpt_store_in(&said).is_some(), "{said}");
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    THE BUG AS IT HAPPENED. The first redirect signed OpenBot in, the container exited and took the
    callback port with it, and minutes later the browser came back through OpenAI with a new code
    and got "localhost refused to connect", which reads as a failed sign-in. A redirect that arrives
    after the sign-in finished is answered, and says OpenBot is already signed in.
    */
    #[test]
    fn a_redirect_after_the_sign_in_finished_is_answered_not_refused() {
        let _port = CALLBACK_PORT
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        if crate::test_support::isolated_process(
            "plan::tests::a_redirect_after_the_sign_in_finished_is_answered_not_refused",
        ) {
            return;
        }
        let root = fake_engine("chatgpt-late-redirect");
        let address = crate::engine::Address::new(Engine::Docker, None);

        let (signing, url) = SigningInToChatGpt::begin(&address, "synthetic-chatgpt").unwrap();
        let state = state_of(&url);
        let finishing = std::thread::spawn(move || signing.finish());
        let first = browser_returns("ac.first", &state).unwrap();
        assert!(first.contains("You're signed in"), "{first}");
        assert!(finishing.join().unwrap().is_ok());

        let late = browser_returns("ac.second", &state).expect(
            "a redirect after the sign-in finished was refused: the browser shows \
             ERR_CONNECTION_REFUSED and the person concludes the sign-in failed",
        );
        assert!(late.starts_with("HTTP/1.1 200"), "{late}");
        assert!(late.contains("OpenBot is signed in to ChatGPT"), "{late}");
        assert!(
            !late.contains("ac.second"),
            "the page must never echo a code"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    A second sign-in while the first still waits: the person chose another provider and came back,
    or the first one's browser tab went missing. The first one's container still holds the callback
    port, so the new one has to take it before it sends anybody to OpenAI.
    */
    #[test]
    fn a_new_sign_in_takes_the_callback_port_from_one_still_waiting() {
        let _port = CALLBACK_PORT
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        if crate::test_support::isolated_process(
            "plan::tests::a_new_sign_in_takes_the_callback_port_from_one_still_waiting",
        ) {
            return;
        }
        let root = fake_engine("chatgpt-second-attempt");
        let address = crate::engine::Address::new(Engine::Docker, None);

        let (first, first_url) = SigningInToChatGpt::begin(&address, "synthetic-chatgpt").unwrap();
        let first_waiting = std::thread::spawn(move || first.finish());

        let (second, second_url) = SigningInToChatGpt::begin(&address, "synthetic-chatgpt")
            .expect("a second sign-in could not start while the first held the callback port");
        assert_ne!(state_of(&first_url), state_of(&second_url));
        assert!(
            first_waiting.join().unwrap().is_err(),
            "the replaced sign-in must not report a success"
        );

        let second_waiting = std::thread::spawn(move || second.finish());
        let reply = browser_returns("ac.second", &state_of(&second_url)).unwrap();
        assert!(reply.contains("You're signed in"), "{reply}");
        assert!(second_waiting.join().unwrap().is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The registered redirect is `localhost`, and the script must not name anything else.
    ///
    /// `127.0.0.1` is the same address and a different string, and OAuth registration compares
    /// strings: passing it makes the authorize request fail with `unknown_error` before a login
    /// page is ever drawn. That cost two live attempts.
    #[test]
    fn the_login_leaves_the_callback_host_alone() {
        assert!(
            !CHATGPT_LOGIN.contains("host="),
            "the script names a callback host; the default `localhost` is what OpenAI registered"
        );
    }

    /// The stripper has to survive what a TUI actually emits, including a bare ESC pair.
    #[test]
    fn escapes_come_out_and_the_words_stay() {
        assert_eq!(plain("\u{1b}[1mbold\u{1b}[0m plain"), "bold plain");
        assert_eq!(plain("\u{1b}]0;title\u{7}after"), "after");
        assert_eq!(plain("\u{1b}(Bkept"), "kept");
    }
}
