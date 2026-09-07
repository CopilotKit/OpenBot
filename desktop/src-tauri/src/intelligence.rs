//! Signing in to CopilotKit Intelligence, so nobody is sent to a terminal for a key.
//!
//! THE LAST DEVELOPER-SHAPED ASK IN SETUP. Before this, the final screen wanted an "Intelligence
//! project key", and the only way to produce one was `npx copilotkit login` followed by
//! `copilotkit project select`. That is two commands, a terminal and a package manager, for
//! somebody whose entire relationship with this product is a window their IT department sent them.
//! The audience rule says any step that amounts to "go and get something and come back" is a
//! defect, and that was the largest one left.
//!
//! The flow is the CLI's own, done here instead: a loopback callback, an exchange, and a key this
//! deployment provisions for the project the person chose. Reading it out of the CLI rather than
//! inventing it is deliberate — the endpoints, the parameter names and the order all belong to
//! whoever changes them, and guessing at somebody else's auth is how this breaks silently later.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Where the sign-in page and the CLI API live.
const OPS_FRONTEND: &str = "https://dashboard.operations.copilotkit.ai";
const OPS_API: &str = "https://api.operations.copilotkit.ai";
/// Where projects and their keys live.
const PRODUCT_API: &str = "https://api.intelligence.copilotkit.ai";

/// How long somebody gets to finish signing in.
const PATIENCE: Duration = Duration::from_secs(600);

/// A project somebody can put OpenBot in.
#[derive(Clone, Debug, serde::Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
}

/**
The callback the browser is sent back to.

`127.0.0.1` and an ephemeral port, which is what the CLI does: the port is whatever the operating
system had free, so nothing has to be reserved and two sign-ins cannot collide. Never `localhost`,
for the reason the rest of this tree does not use it either.
*/
pub struct SigningInToIntelligence {
    listener: TcpListener,
    state: String,
    port: u16,
}

/// What the browser hands back, pulled out of the callback line.
///
/// Pure so the parsing is testable without a browser: this is a `GET /callback?...` request line,
/// and the two things that matter are in its query.
pub fn callback_values(request_line: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    let mut state = None;
    let mut token = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        let value = percent_decode(value);
        match key {
            "state" => state = Some(value),
            "clerkToken" => token = Some(value),
            _ => {}
        }
    }
    Some((state?, token?))
}

/// Enough percent-decoding for a token and a state, neither of which contains anything exotic.
fn percent_decode(value: &str) -> String {
    let bytes = value.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl SigningInToIntelligence {
    /// Open the callback and return the address a browser has to visit.
    pub fn begin() -> Result<(Self, String), String> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .map_err(|error| format!("A sign-in could not be started: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("A sign-in could not be started: {error}"))?
            .port();
        // Random, and checked when the browser comes back: without it any page could complete
        // somebody else's sign-in by hitting this port.
        let state: String = {
            use rand::Rng;
            let mut rng = rand::rng();
            (0..32)
                .map(|_| format!("{:x}", rng.random_range(0..16)))
                .collect()
        };
        let callback = format!("http://127.0.0.1:{port}/callback");
        let url = format!(
            "{OPS_FRONTEND}/cli-auth?callback={}&state={state}",
            urlencode(&callback)
        );
        Ok((
            Self {
                listener,
                state,
                port,
            },
            url,
        ))
    }

    /// The port the callback is listening on, for anything that needs to say so.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Wait for the browser, then turn what it brings into a project key.
    pub fn finish(self) -> Result<(String, Vec<Project>), String> {
        let token = self.wait_for_token()?;
        let session = exchange(&token)?;
        let product = product_credential(&session)?;
        let projects = list_projects(&product)?;
        Ok((product, projects))
    }

    fn wait_for_token(&self) -> Result<String, String> {
        self.listener
            .set_nonblocking(true)
            .map_err(|error| format!("The sign-in could not be watched: {error}"))?;
        let began = Instant::now();
        while began.elapsed() < PATIENCE {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(token) = self.read_callback(stream)? {
                        return Ok(token);
                    }
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(error) => return Err(format!("The sign-in could not be read: {error}")),
            }
        }
        Err("That sign-in was not finished in time. Start it again.".into())
    }

    fn read_callback(&self, mut stream: TcpStream) -> Result<Option<String>, String> {
        stream
            .set_nonblocking(false)
            .map_err(|error| format!("The sign-in could not be read: {error}"))?;
        let mut line = String::new();
        BufReader::new(
            stream
                .try_clone()
                .map_err(|error| format!("The sign-in could not be read: {error}"))?,
        )
        .read_line(&mut line)
        .map_err(|error| format!("The sign-in could not be read: {error}"))?;

        let Some((state, token)) = callback_values(&line) else {
            reply(&mut stream, "Waiting for the sign-in to finish.");
            return Ok(None);
        };
        /*
         * The state is checked before anything is done with the token.
         *
         * Anything on this machine can reach a loopback port, so without this a page in any tab
         * could complete a sign-in that nobody asked for.
         */
        if state != self.state {
            reply(&mut stream, "That sign-in did not match. Start it again.");
            return Err("That sign-in did not match the one this window started.".into());
        }
        reply(
            &mut stream,
            "Signed in. You can close this tab and go back to OpenBot.",
        );
        Ok(Some(token))
    }
}

/// A small page, so the browser does not sit on a blank tab.
fn reply(stream: &mut TcpStream, said: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>OpenBot</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
         <p>{said}</p>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn urlencode(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("The sign-in could not reach CopilotKit: {error}"))
}

#[derive(Deserialize)]
struct Session {
    token: String,
}

fn exchange(clerk_token: &str) -> Result<String, String> {
    let response = client()?
        .post(format!("{OPS_API}/api/cli/auth/session"))
        .json(&serde_json::json!({ "clerkToken": clerk_token }))
        .send()
        .map_err(|error| format!("The sign-in could not be completed: {error}"))?;
    if !response.status().is_success() {
        return Err("CopilotKit refused that sign-in. Try again.".into());
    }
    let session: Session = response
        .json()
        .map_err(|error| format!("That sign-in returned something unexpected: {error}"))?;
    Ok(session.token)
}

#[derive(Deserialize)]
struct ProductCredential {
    token: String,
}

#[derive(Deserialize)]
struct ProductCredentialResponse {
    #[serde(rename = "productCredential")]
    product_credential: ProductCredential,
}

fn product_credential(session: &str) -> Result<String, String> {
    let response = client()?
        .post(format!("{OPS_API}/api/cli/auth/product-credential"))
        .bearer_auth(session)
        .send()
        .map_err(|error| format!("The sign-in could not be completed: {error}"))?;
    if !response.status().is_success() {
        return Err("CopilotKit would not issue a credential for this account.".into());
    }
    let payload: ProductCredentialResponse = response
        .json()
        .map_err(|error| format!("That sign-in returned something unexpected: {error}"))?;
    Ok(payload.product_credential.token)
}

fn list_projects(product: &str) -> Result<Vec<Project>, String> {
    let response = client()?
        .get(format!("{PRODUCT_API}/api/projects"))
        .bearer_auth(product)
        .send()
        .map_err(|error| format!("Your projects could not be listed: {error}"))?;
    if !response.status().is_success() {
        return Err("Your CopilotKit projects could not be listed.".into());
    }
    let raw: serde_json::Value = response
        .json()
        .map_err(|error| format!("That list came back unreadable: {error}"))?;
    Ok(projects_in(&raw))
}

/**
The projects in whatever shape that endpoint answers with.

Tolerant on purpose, and pure so it can be tested against real payloads: this is somebody else's
API, the response has been a bare array and an object with a `projects` key at different times, and
a setup screen that shows nothing because a wrapper changed is worse than one that shows a list.
*/
pub fn projects_in(raw: &serde_json::Value) -> Vec<Project> {
    let rows = raw
        .get("projects")
        .or_else(|| raw.get("data"))
        .and_then(|value| value.as_array())
        .or_else(|| raw.as_array());
    let Some(rows) = rows else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let name = row
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(Project { id, name })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_callback_gives_up_its_state_and_token() {
        let line = "GET /callback?state=abc123&clerkToken=tok_xyz HTTP/1.1";
        assert_eq!(
            callback_values(line),
            Some(("abc123".into(), "tok_xyz".into()))
        );
    }

    /// Percent-encoded values come back decoded, since a token may carry them.
    #[test]
    fn an_encoded_value_is_decoded() {
        let line = "GET /callback?state=a%2Db&clerkToken=x%20y HTTP/1.1";
        assert_eq!(callback_values(line), Some(("a-b".into(), "x y".into())));
    }

    /// Anything that is not the callback is ignored rather than treated as a sign-in.
    #[test]
    fn a_request_that_is_not_the_callback_yields_nothing() {
        assert_eq!(callback_values("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(callback_values("GET /callback HTTP/1.1"), None);
        assert_eq!(callback_values(""), None);
    }

    /// Both shapes that endpoint has answered with, because a wrapper changing should not empty
    /// the screen.
    #[test]
    fn projects_are_read_from_either_shape() {
        let wrapped = serde_json::json!({"projects": [{"id": "p1", "name": "Ledgerline"}]});
        let bare = serde_json::json!([{"id": "p1", "name": "Ledgerline"}]);
        let expected = vec![Project {
            id: "p1".into(),
            name: "Ledgerline".into(),
        }];
        assert_eq!(projects_in(&wrapped), expected);
        assert_eq!(projects_in(&bare), expected);
    }

    /// A project with no name is listed under its id rather than dropped.
    #[test]
    fn a_nameless_project_is_still_offered() {
        let raw = serde_json::json!([{"id": "p2"}]);
        assert_eq!(
            projects_in(&raw),
            vec![Project {
                id: "p2".into(),
                name: "p2".into()
            }]
        );
    }

    #[test]
    fn nothing_readable_is_an_empty_list_rather_than_a_crash() {
        assert!(projects_in(&serde_json::json!({"unexpected": true})).is_empty());
    }

    /// The callback is opened on a loopback address, never a name.
    #[test]
    fn the_callback_is_loopback_and_the_url_carries_it() {
        let (signing, url) = SigningInToIntelligence::begin().expect("it did not start");
        assert!(url.starts_with(OPS_FRONTEND), "{url}");
        assert!(url.contains("127.0.0.1"), "{url}");
        assert!(!url.contains("localhost"), "{url}");
        assert!(signing.port() > 0);
    }
}
