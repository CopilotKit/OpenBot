/*!
A provider's OAuth redirect, caught on this computer's loopback (RFC 8252 section 7.3).

One listener for every sign-in that ends in a redirect to `localhost`: Desktop's own Claude plan
sign-in (`claude_sign_in`), and the redirect OpenBot's page asks Desktop to catch while OpenBot
Cloud's server runs the sign-in (`sign_in_redirect`). The browser is sent to
`http://localhost:<port><path>?code=…&state=…`, and this answers it.

THE STATE DECIDES WHICH REQUEST IS THE ONE. A browser can come back more than once: a second tab, Back
to the provider's page, a tab left over from an earlier attempt. A callback carrying another state
gets a page saying its link is out of date, and the wait goes on. Only the request on the path whose
`state` matches, carrying `code` or `error`, ends it, and the caller answers that one: a redirect to
the provider's own page, or OpenBot's.

The code is never logged, kept or drawn on a page here. It is handed to the caller once.
*/

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// How long one connection is given to send its request line.
const REQUEST_PATIENCE: Duration = Duration::from_secs(2);

/// How often a wait looks for a connection, a cancel or its deadline.
const POLL: Duration = Duration::from_millis(50);

/// The listener a sign-in's redirect comes back to.
pub struct Listener {
    listeners: Vec<TcpListener>,
    port: u16,
    path: &'static str,
    /// The Codex CLI's convention: GET /cancel asks whoever holds a fixed callback port to let it go.
    honours_cancel: bool,
}

/// What the redirect brought back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Code { code: String, state: String },
    Error { error: String, state: String },
}

/// Why a wait ended without a redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    TimedOut,
    Cancelled,
    /// Another program on this computer asked for the port back (`GET /cancel`).
    PortWanted,
    Failed(String),
}

/// Why a fixed port couldn't be listened on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// Something else on this computer has it.
    Busy,
    Failed(String),
}

impl Listener {
    /// On `127.0.0.1`, on a port the system picks, for a provider that accepts any loopback port.
    pub fn on_any_port(path: &'static str) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listeners: vec![listener],
            port,
            path,
            honours_cancel: false,
        })
    }

    /**
    On a fixed port, on both loopbacks, for a provider that registered one exact redirect
    (`http://localhost:1455/auth/callback` for ChatGPT).

    Both, because a browser resolving `localhost` may try either. Busy when either is already taken:
    the browser could then reach the other program, which would see the code. A loopback this computer
    doesn't have (no IPv6, say) is skipped, as long as the other binds.
    */
    pub fn on_port(port: u16, path: &'static str) -> Result<Self, BindError> {
        let mut listeners = Vec::new();
        let mut last = None;
        for address in [
            SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        ] {
            match TcpListener::bind(address) {
                Ok(listener) => listeners.push(listener),
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    return Err(BindError::Busy)
                }
                Err(error) => last = Some(error.to_string()),
            }
        }
        if listeners.is_empty() {
            return Err(BindError::Failed(
                last.unwrap_or_else(|| "no loopback address could be bound".into()),
            ));
        }
        for listener in &listeners {
            listener
                .set_nonblocking(true)
                .map_err(|error| BindError::Failed(error.to_string()))?;
        }
        Ok(Self {
            listeners,
            port,
            path,
            honours_cancel: true,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The redirect URI a provider is told, exactly as registered: `localhost`, not `127.0.0.1`.
    /// OAuth servers compare it as a string.
    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}{}", self.port, self.path)
    }

    /**
    Wait for the redirect whose `state` is `state`, until `patience` runs out or `cancelled` says so.

    Every other request is answered here and the wait goes on: another state gets a page saying its
    link is out of date, anything else on this port a 404. The one that matches is handed back with
    its connection still open, for the caller to answer once it knows how the sign-in went.
    */
    pub fn wait(
        &self,
        state: &str,
        patience: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(Outcome, Reply), Ended> {
        let deadline = Instant::now() + patience;
        loop {
            if cancelled() {
                return Err(Ended::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(Ended::TimedOut);
            }
            let accepted = self
                .listeners
                .iter()
                .find_map(|listener| match listener.accept() {
                    Ok((stream, _)) => Some(Ok(stream)),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                    Err(error) => Some(Err(error)),
                });
            match accepted {
                None => std::thread::sleep(POLL),
                Some(Err(error)) => return Err(Ended::Failed(error.to_string())),
                Some(Ok(stream)) => match self.receive(stream, state) {
                    Received::Ours(outcome, reply) => return Ok((outcome, reply)),
                    Received::PortWanted => return Err(Ended::PortWanted),
                    Received::Answered => {}
                },
            }
        }
    }

    fn receive(&self, mut stream: TcpStream, state: &str) -> Received {
        let Ok(line) = crate::provider_oauth::read_callback_request(&mut stream, REQUEST_PATIENCE)
        else {
            return Received::Answered;
        };
        let target = line.split_whitespace().nth(1).unwrap_or("/");
        let Ok(parsed) = reqwest::Url::parse(&format!("http://localhost{target}")) else {
            Reply(stream).text("400 Bad Request", "");
            return Received::Answered;
        };
        if self.honours_cancel && parsed.path() == "/cancel" {
            Reply(stream).text("200 OK", "Login cancelled");
            return Received::PortWanted;
        }
        if parsed.path() != self.path {
            Reply(stream).text("404 Not Found", "");
            return Received::Answered;
        }
        let mut code = None;
        let mut error = None;
        let mut given = None;
        for (name, value) in parsed.query_pairs() {
            match name.as_ref() {
                "code" if code.is_none() => code = Some(value.into_owned()),
                "error" if error.is_none() => error = Some(value.into_owned()),
                "state" if given.is_none() => given = Some(value.into_owned()),
                _ => {}
            }
        }
        let carries_an_answer = code.as_deref().is_some_and(|c| !c.is_empty()) || error.is_some();
        if given.as_deref() != Some(state) || !carries_an_answer {
            Reply(stream).page(
                "400 Bad Request",
                "This sign-in link is out of date",
                &["OpenBot started a newer sign-in. Finish it in the newest tab OpenBot opened, or close this one."],
            );
            return Received::Answered;
        }
        let state = state.to_owned();
        let outcome = match (error, code) {
            (Some(error), _) => Outcome::Error { error, state },
            (None, Some(code)) => Outcome::Code { code, state },
            (None, None) => unreachable!("checked above"),
        };
        Received::Ours(outcome, Reply(stream))
    }
}

enum Received {
    Ours(Outcome, Reply),
    PortWanted,
    Answered,
}

/// The browser's connection for the redirect that matched, answered once.
pub struct Reply(TcpStream);

impl Reply {
    /// Send the browser on, as Claude Code does to Claude's own success page.
    pub fn redirect(self, location: &str) {
        self.send(
            "302 Found",
            &[("Location", location)],
            "text/plain; charset=utf-8",
            "",
        );
    }

    /// Plain text, as Claude Code answers a sign-in that failed.
    pub fn text(self, status: &str, body: &str) {
        self.send(status, &[], "text/plain; charset=utf-8", body);
    }

    /// A page in OpenBot's words. Its lines are this program's own text, never anything the request
    /// carried.
    pub fn page(self, status: &str, heading: &str, lines: &[&str]) {
        let lines: String = lines.iter().map(|line| format!("<p>{line}</p>")).collect();
        let body = format!(
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
        );
        self.send(status, &[], "text/html; charset=utf-8", &body);
    }

    fn send(self, status: &str, headers: &[(&str, &str)], kind: &str, body: &str) {
        let mut stream = self.0;
        let extra: String = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect();
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\n{extra}Content-Type: {kind}\r\nContent-Length: {}\r\n\
             Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
             X-Content-Type-Options: nosniff\r\n\
             Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.flush();
        /*
         * Only the request line was read. Closing with the rest of the head unread resets the
         * connection, and the browser shows a reset instead of the page. So say we're done writing
         * and read what is left, briefly, before letting go.
         */
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let mut buffer = [0u8; 4096];
        while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A browser arriving at `target` on the listener's port. Answers the whole reply.
    pub(crate) fn browser_get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_secs(2),
        )
        .expect("the listener accepts");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: localhost:{port}\r\nUser-Agent: test\r\nAccept: text/html\r\n\r\n"
        )
        .unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    #[test]
    fn another_state_is_told_its_link_is_out_of_date_and_the_wait_goes_on() {
        let _ports = crate::test_support::hold_ports();
        let listener = Listener::on_any_port("/callback").unwrap();
        let port = listener.port();
        let browser = std::thread::spawn(move || {
            let stale = browser_get(port, "/callback?code=ac.stale&state=earlier");
            let elsewhere = browser_get(port, "/favicon.ico");
            let ours = browser_get(port, "/callback?code=ac.ours&state=current");
            (stale, elsewhere, ours)
        });
        let (outcome, reply) = listener
            .wait("current", Duration::from_secs(20), &|| false)
            .unwrap();
        assert_eq!(
            outcome,
            Outcome::Code {
                code: "ac.ours".into(),
                state: "current".into()
            }
        );
        reply.page("200 OK", "Done", &["Close this tab."]);
        let (stale, elsewhere, ours) = browser.join().unwrap();
        assert!(stale.starts_with("HTTP/1.1 400"), "{stale}");
        assert!(
            stale.contains("This sign-in link is out of date"),
            "{stale}"
        );
        assert!(!stale.contains("ac.stale"), "a page must never echo a code");
        assert!(elsewhere.starts_with("HTTP/1.1 404"), "{elsewhere}");
        assert!(ours.starts_with("HTTP/1.1 200"), "{ours}");
        assert!(!ours.contains("ac.ours"), "a page must never echo a code");
    }

    #[test]
    fn a_cancel_ends_the_wait_promptly() {
        let listener = Listener::on_any_port("/callback").unwrap();
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let began = Instant::now();
        let ended = listener
            .wait("s", Duration::from_secs(60), &|| {
                cancelled.load(std::sync::atomic::Ordering::SeqCst)
            })
            .err();
        assert_eq!(ended, Some(Ended::Cancelled));
        assert!(began.elapsed() < Duration::from_secs(3));
    }
}
