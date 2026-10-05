//! Per-run authentication failures reported by the owned server, never guessed from logs.
use openbot_desktop_lib::problem::Connection;
use reqwest::blocking::Client;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    connection: String,
    code: String,
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not create connection status client: {error}"))
}

pub fn poll(client: &Client, port: u16, token: &str) -> Result<Option<Connection>, String> {
    let response = client
        .get(format!(
            "http://127.0.0.1:{port}/api/desktop/connection-failure"
        ))
        .header("x-openbot-desktop-host-token", token)
        .send()
        .map_err(|error| format!("Connection status request failed: {error}"))?;
    // Older installed payloads have no status endpoint. This is a capability check, not auth.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Connection status request returned HTTP {}.",
            response.status()
        ));
    }
    let failure = response
        .json::<Option<Failure>>()
        .map_err(|_| "Connection status response was invalid.".to_string())?;
    match failure {
        None => Ok(None),
        Some(Failure { connection, code }) => match (connection.as_str(), code.as_str()) {
            ("model", "provider_authentication_failed") => Ok(Some(Connection::Model)),
            ("intelligence", "intelligence_authentication_failed") => {
                Ok(Some(Connection::Intelligence))
            }
            ("organization", "organization_authentication_failed") => {
                Ok(Some(Connection::Organization))
            }
            _ => Err("Connection status response contained an unsupported failure.".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn runtime_connection_poll_accepts_only_authenticated_typed_provider_failures() {
        for (status, body, expected) in [
            (200, "null", Ok(None)),
            (
                200,
                r#"{"connection":"model","code":"provider_authentication_failed"}"#,
                Ok(Some(Connection::Model)),
            ),
            (
                200,
                r#"{"connection":"intelligence","code":"intelligence_authentication_failed"}"#,
                Ok(Some(Connection::Intelligence)),
            ),
            (
                200,
                r#"{"connection":"organization","code":"organization_authentication_failed"}"#,
                Ok(Some(Connection::Organization)),
            ),
            (404, "", Ok(None)),
            (401, "provider auth failed", Err(())),
            (403, "provider auth failed", Err(())),
            (500, "provider auth failed", Err(())),
            (
                200,
                r#"{"connection":"model","code":"rate_limit"}"#,
                Err(()),
            ),
            (
                200,
                r#"{"connection":"model","code":"provider_authentication_failed","secret":"unexpected"}"#,
                Err(()),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    headers.push_str(&line);
                }
                assert!(headers.starts_with("GET /api/desktop/connection-failure "));
                assert!(headers
                    .to_lowercase()
                    .contains("x-openbot-desktop-host-token: synthetic-run-token\r\n"));
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let result = poll(&client().unwrap(), port, "synthetic-run-token");
            server.join().unwrap();
            assert_eq!(result.map_err(|_| ()), expected);
        }
    }
}
