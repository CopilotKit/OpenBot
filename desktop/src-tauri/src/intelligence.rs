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
    pub fn finish(self) -> Result<(String, Vec<Project>), crate::problem::Problem> {
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

/**
Read a response as JSON, keeping what actually came back when it will not parse.

WITHOUT THIS THE FAILURE IS UNDIAGNOSABLE, and it was. A sign-in that got all the way through the
browser ended on "That sign-in returned something unexpected: error decoding response body" — which
says a shape was wrong without saying which, from which endpoint, or what arrived instead. The body
is the only thing that answers any of those, and it is exactly what a two-fold failure is for.

Capped, because a body that is not JSON is often a whole HTML error page and nobody needs all of
it. Reported as a `Problem`, so the sentence stays the person's and the body stays behind the
disclosure.
*/
/**
The same body with anything that looks like a credential masked.

BECAUSE THE DISCLOSURE IS STILL A SCREEN. The body that diagnosed the field-name bug also carried a
live session token, and a person doing the obvious thing with a technical detail is pasting it into
a bug report. What a developer needs from this is the SHAPE — which fields arrived and what they
were called — and the shape survives masking perfectly.
*/
fn without_credentials(body: &str) -> String {
    let Ok(mut raw) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_string();
    };
    mask(&mut raw);
    serde_json::to_string(&raw).unwrap_or_else(|_| body.to_string())
}

fn mask(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (name, held) in fields.iter_mut() {
                let lower = name.to_lowercase();
                let secret = ["token", "key", "secret", "credential", "password"]
                    .iter()
                    .any(|word| lower.contains(word));
                if secret && held.is_string() {
                    *held = serde_json::Value::String("[hidden]".into());
                } else {
                    mask(held);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(mask),
        _ => {}
    }
}

fn read_json(
    response: reqwest::blocking::Response,
    what: &str,
) -> Result<serde_json::Value, crate::problem::Problem> {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    serde_json::from_str(&body).map_err(|error| {
        let mut shown = without_credentials(body.trim());
        shown.truncate(2000);
        crate::problem::Problem::with(
            format!("CopilotKit's {what} came back in a shape OpenBot does not understand."),
            format!("HTTP {status}\n{error}\n\n{shown}"),
        )
    })
}

/**
The session the ops API hands back for a browser sign-in.

IT IS CALLED `cliToken`, and reading it as `token` was a whole sign-in that failed at the last step.
The alias is kept because this is somebody else's response and the older name may still appear;
being tolerant here costs nothing and being strict cost a person their setup.
*/
#[derive(Deserialize)]
struct Session {
    #[serde(alias = "cliToken", alias = "token")]
    cli_token: String,
}

fn exchange(clerk_token: &str) -> Result<String, crate::problem::Problem> {
    let response = client()?
        .post(format!("{OPS_API}/api/cli/auth/session"))
        .json(&serde_json::json!({ "clerkToken": clerk_token }))
        .send()
        .map_err(|error| {
            crate::problem::Problem::with("The sign-in could not be completed.", error.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(crate::problem::Problem::with(
            "CopilotKit refused that sign-in. Try again.",
            format!("HTTP {status}\n{}", response.text().unwrap_or_default()),
        ));
    }
    let raw = read_json(response, "sign-in")?;
    serde_json::from_value::<Session>(raw.clone())
        .map(|session| session.cli_token)
        .map_err(|error| {
            crate::problem::Problem::with(
                "CopilotKit's sign-in came back without the session OpenBot needs.",
                format!("{error}\n\n{raw}"),
            )
        })
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

fn product_credential(session: &str) -> Result<String, crate::problem::Problem> {
    let response = client()?
        .post(format!("{OPS_API}/api/cli/auth/product-credential"))
        .bearer_auth(session)
        .send()
        .map_err(|error| {
            crate::problem::Problem::with("The sign-in could not be completed.", error.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(crate::problem::Problem::with(
            "CopilotKit would not issue a credential for this account.",
            format!("HTTP {status}\n{}", response.text().unwrap_or_default()),
        ));
    }
    let raw = read_json(response, "credential")?;
    serde_json::from_value::<ProductCredentialResponse>(raw.clone())
        .map(|payload| payload.product_credential.token)
        .map_err(|error| {
            crate::problem::Problem::with(
                "CopilotKit's credential came back in a shape OpenBot does not understand.",
                format!("{error}\n\n{raw}"),
            )
        })
}

fn list_projects(product: &str) -> Result<Vec<Project>, crate::problem::Problem> {
    let response = client()?
        .get(format!("{PRODUCT_API}/api/projects"))
        .bearer_auth(product)
        .send()
        .map_err(|error| {
            crate::problem::Problem::with("Your projects could not be listed.", error.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(crate::problem::Problem::with(
            "Your CopilotKit projects could not be listed.",
            format!("HTTP {status}\n{}", response.text().unwrap_or_default()),
        ));
    }
    let raw = read_json(response, "project list")?;
    let found = projects_in(&raw);
    /*
     * AN EMPTY LIST AND AN UNREADABLE ONE ARE DIFFERENT THINGS, and telling somebody with projects
     * that they have none is the worse of the two. Measured: the sign-in got all the way here and
     * the screen said "That account has no projects yet", which was false and which nobody could
     * have argued with. If the payload carried something and none of it parsed as a project, the
     * shape is what changed, and the shape is what gets shown.
     */
    if found.is_empty() && !looks_genuinely_empty(&raw) {
        return Err(crate::problem::Problem::with(
            "CopilotKit's project list came back in a shape OpenBot does not understand.",
            without_credentials(&raw.to_string()),
        ));
    }
    Ok(found)
}

/// Whether a payload actually says "no projects" rather than saying something unrecognised.
fn looks_genuinely_empty(raw: &serde_json::Value) -> bool {
    let rows = raw
        .get("projects")
        .or_else(|| raw.get("data"))
        .and_then(|value| value.as_array())
        .or_else(|| raw.as_array());
    match rows {
        Some(rows) => rows.is_empty(),
        None => false,
    }
}

/**
Ask for a key for the project somebody chose.

`POST /api/keys` with `project_id` and a name, which is the CLI's own call. The name says where the
key came from, because a person looking at a list of keys months later deserves to know which one
their laptop is using.
*/
/// A project id as the keys endpoint wants it, and unchanged if it is not a number at all.
fn as_number(project_id: &str) -> serde_json::Value {
    match project_id.trim().parse::<u64>() {
        Ok(number) => serde_json::Value::from(number),
        Err(_) => serde_json::Value::from(project_id),
    }
}

pub fn provision_key(product: &str, project_id: &str) -> Result<String, crate::problem::Problem> {
    let response = client()?
        .post(format!("{PRODUCT_API}/api/keys"))
        .bearer_auth(product)
        /*
         * `project_id` AS A NUMBER, which is what the endpoint's own schema requires.
         *
         * `api-keys-routes.ts` declares `project_id: z.number().int().positive()` — not `coerce`,
         * so the string "7" is rejected outright. Measured as `HTTP 400 VALIDATION_ERROR: Request
         * validation failed.` on the last step of a sign-in that had otherwise worked, which is the
         * most expensive place in the product to fail.
         *
         * The id travels as a string because a project list can use either shape (see
         * `projects_in`), so it is turned back into a number here, where the requirement is.
         */
        .json(&serde_json::json!({
            "project_id": as_number(project_id),
            "name": "OpenBot Desktop",
        }))
        .send()
        .map_err(|error| {
            crate::problem::Problem::with("A key could not be created.", error.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(crate::problem::Problem::with(
            "CopilotKit would not create a key for that project.",
            format!("HTTP {status}\n{}", response.text().unwrap_or_default()),
        ));
    }
    let raw = read_json(response, "key")?;
    key_in(&raw).ok_or_else(|| {
        crate::problem::Problem::with("That key came back without a value in it.", raw.to_string())
    })
}

/**
The key itself, out of whatever the endpoint wrapped it in.

Tolerant for the same reason the project list is, and pure so it is testable: this is somebody
else's response shape, and a setup that fails at the last step because a field moved is the worst
possible place to be strict.
*/
pub fn key_in(raw: &serde_json::Value) -> Option<String> {
    for at in [
        raw.get("key"),
        raw.get("apiKey"),
        raw.get("data"),
        Some(raw),
    ] {
        let Some(value) = at else { continue };
        if let Some(text) = value.as_str() {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
        for field in ["key", "apiKey", "value", "token", "secret"] {
            if let Some(text) = value.get(field).and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
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
            // THE ID IS A NUMBER, and requiring a string silently dropped every project. The
            // account had ten of them and the screen said it had none: `{"id":7,"name":"my-app"}`
            // parsed to nothing because `as_str` returns None for `7`. Both shapes are read now,
            // because which one an endpoint uses is not ours to decide.
            let id = match row.get("id")? {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Number(number) => number.to_string(),
                _ => return None,
            };
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
    /// The field name that broke a whole sign-in, read off the real response.
    #[test]
    fn the_session_is_read_from_the_name_the_endpoint_uses() {
        // Verbatim shape from the ops API, with the value replaced.
        let body = r#"{"cliToken":"abc","organization":{"organizationName":"CopilotKit"}}"#;
        let session: super::Session = serde_json::from_str(body).expect("cliToken was not read");
        assert_eq!(session.cli_token, "abc");
        // The older name still works, because being strict here is what cost the setup.
        let older: super::Session = serde_json::from_str(r#"{"token":"xyz"}"#).unwrap();
        assert_eq!(older.cli_token, "xyz");
    }

    /// A body shown to a person keeps its shape and loses its credentials.
    #[test]
    fn the_shown_body_has_no_credentials_left_in_it() {
        let body = r#"{"cliToken":"live-secret","user":{"email":"a@b.c"},"apiKey":"another"}"#;
        let shown = super::without_credentials(body);
        assert!(!shown.contains("live-secret"), "{shown}");
        assert!(!shown.contains("another"), "{shown}");
        // The shape is the whole point of showing it at all.
        assert!(shown.contains("cliToken") && shown.contains("email") && shown.contains("a@b.c"));
    }

    /// The keys endpoint takes a number, and sending a string failed the whole sign-in.
    #[test]
    fn the_project_id_is_sent_as_the_number_the_endpoint_requires() {
        assert_eq!(super::as_number("7"), serde_json::json!(7));
        assert_eq!(super::as_number(" 11 "), serde_json::json!(11));
        // A self-hosted deployment could use a real string id; that is not ours to mangle.
        assert_eq!(super::as_number("p_abc"), serde_json::json!("p_abc"));
    }

    /// A numeric id is still an id, and requiring a string hid every project this account had.
    #[test]
    fn projects_are_read_whether_the_id_is_a_number_or_a_string() {
        // Verbatim shape from the product API, trimmed.
        let real: serde_json::Value = serde_json::from_str(
            r#"{"projects":[{"createdAt":"2026-06-17T21:52:32.994Z","id":7,"name":"my-app","slug":"my-app"},{"id":11,"name":"Test Project"}]}"#,
        )
        .unwrap();
        let found = super::projects_in(&real);
        assert_eq!(found.len(), 2, "a numeric id dropped the project");
        assert_eq!(found[0].id, "7");
        assert_eq!(found[0].name, "my-app");

        // A string id keeps working, because some endpoints do use one.
        let text: serde_json::Value =
            serde_json::from_str(r#"[{"id":"p_1","name":"One"}]"#).unwrap();
        assert_eq!(super::projects_in(&text)[0].id, "p_1");
    }

    /// An empty answer and an unreadable one are told apart, because one of them is a lie.
    #[test]
    fn a_payload_we_cannot_read_is_not_reported_as_no_projects() {
        let empty: serde_json::Value = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        assert!(super::looks_genuinely_empty(&empty));
        assert!(super::looks_genuinely_empty(&serde_json::json!([])));

        // A shape nobody recognises is not an empty list, and saying so is the bug.
        let odd: serde_json::Value =
            serde_json::from_str(r#"{"items":[{"id":"p1","name":"One"}]}"#).unwrap();
        assert!(!super::looks_genuinely_empty(&odd));
        assert!(super::projects_in(&odd).is_empty());
    }

    /// Something that is not JSON is still worth showing, unchanged.
    #[test]
    fn a_body_that_is_not_json_is_shown_as_it_arrived() {
        assert_eq!(
            super::without_credentials("<html>502</html>"),
            "<html>502</html>"
        );
    }

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

    /// The key, wherever that response decided to put it.
    #[test]
    fn the_key_is_found_in_the_shapes_that_endpoint_uses() {
        for raw in [
            serde_json::json!({"key": "cpk-abc"}),
            serde_json::json!({"apiKey": "cpk-abc"}),
            serde_json::json!({"key": {"value": "cpk-abc"}}),
            serde_json::json!({"data": {"key": "cpk-abc"}}),
        ] {
            assert_eq!(key_in(&raw).as_deref(), Some("cpk-abc"), "{raw}");
        }
    }

    /// A response with no key is a failure to report, not an empty string to write into `.env`.
    #[test]
    fn a_response_without_a_key_yields_nothing() {
        assert_eq!(key_in(&serde_json::json!({"key": ""})), None);
        assert_eq!(key_in(&serde_json::json!({"unexpected": true})), None);
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

#[cfg(test)]
mod wire {
    /// What the window actually receives, which is the only thing that decides what it can render.
    #[test]
    fn a_project_reaches_the_window_with_both_fields() {
        let project = super::Project {
            id: "7".into(),
            name: "my-app".into(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert_eq!(
            json, r#"{"id":"7","name":"my-app"}"#,
            "the wire shape changed"
        );
    }
}
