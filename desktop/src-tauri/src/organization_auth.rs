//! Employee identity from the customer's OpenBot authority. Intelligence credentials are separate.
use crate::problem::{Connection, Problem};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SAVED_COOKIE: &str = "OPENBOT_ORGANIZATION_SESSION";
const CALLBACK: &str = "/organization-auth/callback";
const PATIENCE: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OrganizationUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub role: String,
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    authority: String,
    cookie: String,
}

struct Pending {
    root: PathBuf,
    authority: String,
    state: String,
    verifier: String,
    receiver: Option<mpsc::Receiver<Result<String, Problem>>>,
    cancelled: Arc<AtomicBool>,
}
static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<Option<Pending>> {
    PENDING.get_or_init(|| Mutex::new(None))
}
fn problem(message: &str) -> Problem {
    Problem::plain(message)
}
fn auth_problem(message: &str) -> Problem {
    problem(message).connection(Connection::Organization)
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn authority(value: &str) -> Result<String, Problem> {
    let url = Url::parse(value.trim())
        .map_err(|_| problem("Enter your organization's OpenBot sign-in URL."))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(problem("Use the HTTPS origin of your organization's OpenBot. HTTP is allowed only for a local test."));
    }
    Ok(url.origin().ascii_serialization())
}

fn client() -> Result<Client, Problem> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| problem("OpenBot could not prepare organization sign-in."))
}

fn verify(client: &Client, saved: &SavedSession) -> Result<OrganizationUser, Problem> {
    #[derive(Deserialize)]
    struct Me {
        user: OrganizationUser,
    }
    let response = client
        .get(format!("{}/api/me", saved.authority))
        .header("cookie", &saved.cookie)
        .send()
        .map_err(|_| {
            problem("OpenBot could not reach your organization. Try again when it is available.")
        })?;
    if response.status() == 401 || response.status() == 403 {
        return Err(auth_problem("Sign in to your organization again."));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not answer. Try again when it is available.",
        ));
    }
    let user = response
        .json::<Me>()
        .map_err(|_| problem("Your organization returned an invalid sign-in response."))?
        .user;
    if user.id.is_empty()
        || user.id == "dev-local-user"
        || user.email.is_empty()
        || !matches!(user.role.as_str(), "admin" | "user")
    {
        return Err(auth_problem(
            "Your organization has not granted this account access to OpenBot.",
        ));
    }
    Ok(user)
}

fn saved(root: &Path, expected: &str) -> Result<Option<SavedSession>, Problem> {
    let Some(value) = crate::vault::recall(root, SAVED_COOKIE)? else {
        return Ok(None);
    };
    let session: SavedSession = serde_json::from_str(&value)
        .map_err(|_| auth_problem("Sign in to your organization again."))?;
    if session.authority != expected {
        return Ok(None);
    }
    Ok(Some(session))
}

pub fn status(root: &Path, authority_url: &str) -> Result<Option<OrganizationUser>, Problem> {
    let expected = authority(authority_url)?;
    saved(root, &expected)?
        .map(|session| verify(&client()?, &session))
        .transpose()
}

pub fn cancel(root: &Path) {
    if let Ok(mut held) = pending().lock() {
        if held.as_ref().is_some_and(|run| run.root == root) {
            if let Some(run) = held.take() {
                run.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn callback_code(request: &str, expected_state: &str) -> Result<String, Problem> {
    let first = request.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(problem("The organization sign-in callback was invalid."));
    }
    let target = parts.next().unwrap_or("");
    let parsed = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| problem("The organization sign-in callback was invalid."))?;
    let parameters: Vec<_> = parsed.query_pairs().collect();
    let states: Vec<_> = parameters
        .iter()
        .filter(|(key, _)| key == "state")
        .collect();
    let codes: Vec<_> = parameters.iter().filter(|(key, _)| key == "code").collect();
    if parsed.path() != CALLBACK
        || states.len() != 1
        || states[0].1 != expected_state
        || codes.len() != 1
        || codes[0].1.len() != 32
        || !codes[0].1.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(problem(
            "The organization sign-in callback did not match this request. Sign in again.",
        ));
    }
    Ok(codes[0].1.to_string())
}

pub fn begin(root: &Path, authority_url: &str, provider: &str) -> Result<String, Problem> {
    let authority = authority(authority_url)?;
    if !matches!(provider, "google" | "microsoft" | "okta") {
        return Err(problem("Choose Google, Microsoft, or Okta."));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| problem("OpenBot could not receive the organization sign-in callback."))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| problem("OpenBot could not prepare the organization callback."))?;
    let port = listener
        .local_addr()
        .map_err(|_| problem("OpenBot could not read its callback address."))?
        .port();
    let state = random();
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (sender, receiver) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_listener = cancelled.clone();
    let expected_state = state.clone();
    let mut url = Url::parse(&format!("{authority}/api/auth/desktop"))
        .map_err(|_| problem("The organization URL is invalid."))?;
    url.query_pairs_mut()
        .append_pair("provider", provider)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair(
            "redirect_uri",
            &format!("http://127.0.0.1:{port}{CALLBACK}"),
        );
    let mut held = pending()
        .lock()
        .map_err(|_| problem("Restart OpenBot to begin organization sign-in."))?;
    if let Some(old) = held.take() {
        old.cancelled.store(true, Ordering::SeqCst);
    }
    *held = Some(Pending {
        root: root.to_path_buf(),
        authority,
        state,
        verifier,
        receiver: Some(receiver),
        cancelled,
    });
    std::thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < PATIENCE && !cancel_listener.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut bytes = [0u8; 8192];
                    let result = stream
                        .read(&mut bytes)
                        .map_err(|_| problem("OpenBot could not read the organization callback."))
                        .and_then(|length| {
                            callback_code(
                                &String::from_utf8_lossy(&bytes[..length]),
                                &expected_state,
                            )
                        });
                    let (status, message) = if result.is_ok() {
                        ("200 OK", "Sign-in received. You can return to OpenBot.")
                    } else {
                        (
                            "400 Bad Request",
                            "Sign-in did not match. Return to OpenBot and try again.",
                        )
                    };
                    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}", message.len());
                    let _ = stream.write_all(reply.as_bytes());
                    let _ = sender.send(result);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => {
                    let _ = sender.send(Err(problem(
                        "OpenBot could not receive the organization callback.",
                    )));
                    return;
                }
            }
        }
        let _ = sender.send(Err(problem(
            "Organization sign-in expired or was cancelled. Try again.",
        )));
    });
    Ok(url.to_string())
}

pub fn finish(root: &Path) -> Result<OrganizationUser, Problem> {
    let (run_authority, run_state, run_verifier, receiver, cancelled) = {
        let mut held = pending()
            .lock()
            .map_err(|_| problem("Restart OpenBot to finish organization sign-in."))?;
        let run = held
            .as_mut()
            .filter(|run| run.root == root)
            .ok_or_else(|| problem("Begin organization sign-in for this installation first."))?;
        (
            run.authority.clone(),
            run.state.clone(),
            run.verifier.clone(),
            run.receiver
                .take()
                .ok_or_else(|| problem("This sign-in is already waiting for the browser."))?,
            run.cancelled.clone(),
        )
    };
    let code = receiver
        .recv_timeout(PATIENCE)
        .map_err(|_| problem("Organization sign-in expired. Try again."))??;
    if cancelled.load(Ordering::SeqCst) {
        return Err(problem("Organization sign-in was cancelled."));
    }
    let client = client()?;
    let response = client.post(format!("{}/api/auth/electron/token", run_authority)).header("origin", &run_authority)
        .json(&serde_json::json!({ "token": code, "state": run_state, "code_verifier": run_verifier })).send()
        .map_err(|_| problem("OpenBot could not finish organization sign-in. Try again."))?;
    if response.status().is_client_error() {
        return Err(auth_problem(
            "Your organization refused this sign-in. Try again.",
        ));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not complete sign-in. Try again.",
        ));
    }
    let cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .find(|value| {
            value.starts_with("better-auth.session_token=")
                || value.starts_with("__Secure-better-auth.session_token=")
        })
        .ok_or_else(|| problem("Your organization did not return an OpenBot session."))?
        .to_string();
    let session = SavedSession {
        authority: run_authority,
        cookie,
    };
    let user = verify(&client, &session)?;
    let encoded = serde_json::to_string(&session)
        .map_err(|_| problem("OpenBot could not save organization sign-in."))?;
    let mut held = pending()
        .lock()
        .map_err(|_| problem("Restart OpenBot to finish organization sign-in."))?;
    if cancelled.load(Ordering::SeqCst)
        || !held
            .as_ref()
            .is_some_and(|run| run.state == run_state && run.root == root)
    {
        return Err(problem("Organization sign-in was cancelled or replaced."));
    }
    crate::vault::remember(root, SAVED_COOKIE, &encoded)?;
    held.take();
    Ok(user)
}

/// A one-use navigation sets the local HttpOnly cookie; credentials never enter renderer IPC.
pub fn session_destination(
    root: &Path,
    authority_url: &str,
    app_url: &str,
) -> Result<String, Problem> {
    let authority = authority(authority_url)?;
    let session = saved(root, &authority)?
        .ok_or_else(|| auth_problem("Sign in to your organization to open OpenBot."))?;
    let client = client()?;
    verify(&client, &session)?;
    let mut destination = Url::parse(app_url)
        .map_err(|_| problem("OpenBot could not find this installation's application."))?;
    if destination.scheme() != "http"
        || !matches!(
            destination.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
    {
        return Err(problem(
            "The installed OpenBot application must be on this computer.",
        ));
    }
    destination.set_path("/api/auth/organization/session");
    destination.set_query(None);
    destination.set_fragment(None);
    #[derive(Deserialize)]
    struct Ticket {
        ticket: String,
    }
    let response = client
        .post(destination.clone())
        .header("origin", destination.origin().ascii_serialization())
        .json(&serde_json::json!({ "cookie": session.cookie }))
        .send()
        .map_err(|_| {
            problem("OpenBot could not deliver your organization sign-in to this installation.")
        })?;
    if response.status() == 401 || response.status() == 403 {
        return Err(auth_problem("Sign in to your organization again."));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not answer. Try again when it is available.",
        ));
    }
    let ticket = response
        .json::<Ticket>()
        .map_err(|_| problem("OpenBot did not accept your organization session."))?;
    if ticket.ticket.is_empty() || ticket.ticket.len() > 128 {
        return Err(problem("OpenBot returned an invalid sign-in handoff."));
    }
    destination
        .query_pairs_mut()
        .append_pair("ticket", &ticket.ticket);
    Ok(destination.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    #[test]
    fn cancellation_retires_a_finish_already_waiting_for_the_browser() {
        let root = PathBuf::from("organization-cancellation-fixture");
        begin(&root, "https://company.example", "google").unwrap();
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || finish(&worker_root));
        let deadline = Instant::now() + Duration::from_secs(2);
        while pending()
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|run| run.receiver.is_some())
        {
            assert!(Instant::now() < deadline, "finish did not start waiting");
            std::thread::yield_now();
        }
        cancel(&root);
        assert!(worker.join().unwrap().is_err());
        assert!(pending().lock().unwrap().is_none());
    }
    #[test]
    fn only_rejected_sessions_request_organization_refresh() {
        for (status, expected) in [
            ("401 Unauthorized", Some(Connection::Organization)),
            ("503 Service Unavailable", None),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                assert_eq!(line, "GET /api/me HTTP/1.1\r\n");
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let result = verify(
                &client().unwrap(),
                &SavedSession {
                    authority: format!("http://{address}"),
                    cookie: "better-auth.session_token=fixture".into(),
                },
            );
            assert_eq!(result.unwrap_err().connection, expected);
            worker.join().unwrap();
        }
    }
    #[test]
    fn authority_is_explicit_and_cannot_smuggle_credentials_or_destinations() {
        assert_eq!(
            authority("https://company.example").unwrap(),
            "https://company.example"
        );
        for bad in [
            "http://company.example",
            "https://person:password@company.example",
            "https://company.example/path",
            "https://company.example?next=elsewhere",
        ] {
            assert!(authority(bad).is_err());
        }
    }
    #[test]
    fn callback_requires_the_exact_single_state_and_code() {
        let code = "a".repeat(32);
        assert_eq!(
            callback_code(
                &format!("GET {CALLBACK}?code={code}&state=expected HTTP/1.1\r\n"),
                "expected"
            )
            .unwrap(),
            code
        );
        for query in [
            format!("code={code}&state=wrong"),
            format!("code={code}&state=expected&state=expected"),
            "code=short&state=expected".into(),
        ] {
            assert!(
                callback_code(&format!("GET {CALLBACK}?{query} HTTP/1.1\r\n"), "expected").is_err()
            );
        }
    }
}
