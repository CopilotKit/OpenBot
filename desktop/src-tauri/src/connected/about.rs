/*!
What the OpenBot this app is connected to says about itself, for Get Troubleshooting Logs…: whether
it answers at all, which release it runs, what it offers, and which account and organization the app
is signed in to there.

Asked through the API the app already uses, and nothing else (api/openapi.yaml):

- `GET /health`, which answers anybody: whether that OpenBot answers, and how fast.
- `getPerson` (`/people/me`): the account's id, and the release the server runs (`openbotVersion`).
- `getDeployment`: its edition and the API versions it serves.

Each is asked with what is left of one deadline, so a troubleshooting file is never held up by an
OpenBot that doesn't answer: what didn't answer is said, in its own words.
*/

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::move_to_cloud::{their_own_organization, Organization};

/// What the OpenBot said, or why it didn't.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct About {
    /// `answered 200 in 0.12s`, or what went wrong.
    pub health: String,
    /// The release the server runs, as `getPerson` names it.
    pub release: Option<String>,
    /// `team` or `personal`.
    pub edition: Option<String>,
    /// The API versions it serves, such as `v2`.
    pub api: Vec<String>,
    /// The organization the app works in there.
    pub organization: Option<String>,
    /// The account the app is signed in as there, by its id.
    pub account: Option<String>,
    /// What couldn't be asked, each in a sentence.
    pub unanswered: Vec<String>,
}

/// How long one question waits at most, when the deadline leaves more.
const EACH: Duration = Duration::from_secs(8);

/// What `ask` needs of the sign-in: a current access token.
pub type Token<'a> = &'a (dyn Fn() -> Result<String, String> + Sync);

/**
Ask the OpenBot at `address` about itself, by `deadline`. `organization` is the one the app works in
there; with none on record, the person's own, as the app picks it. `token` is the app's sign-in; with
none (the app isn't signed in now), only whether it answers is asked.
*/
pub fn ask(
    address: &str,
    organization: Option<&str>,
    token: Option<Token>,
    deadline: Instant,
) -> About {
    let base = address.trim_end_matches('/');
    let mut about = About::default();
    let client = |left: Duration| {
        reqwest::blocking::Client::builder()
            .connect_timeout(left.min(EACH))
            .timeout(left.min(EACH))
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(crate::client_version::headers())
            .build()
            .map_err(|error| error.to_string())
    };
    let left = || deadline.saturating_duration_since(Instant::now());

    let started = Instant::now();
    about.health = match client(left()).and_then(|client| {
        client
            .get(format!("{base}/health"))
            .send()
            .map_err(|error| plain_error(&error))
    }) {
        Ok(answer) => format!(
            "answered {} in {:.2}s",
            answer.status().as_u16(),
            started.elapsed().as_secs_f32()
        ),
        Err(error) => format!("no answer: {error}"),
    };

    // The one on record, whether or not it can be asked about.
    about.organization = organization.map(str::to_owned);
    let Some(token) = token else {
        about
            .unanswered
            .push("The release and the account: the app isn't signed in there now.".to_owned());
        return about;
    };
    let get = |path: &str| -> Result<serde_json::Value, String> {
        if left().is_zero() {
            return Err("no time was left to ask".to_owned());
        }
        let bearer = token()?;
        let answer = client(left())?
            .get(format!("{base}{path}"))
            .bearer_auth(bearer)
            .send()
            .map_err(|error| plain_error(&error))?;
        let status = answer.status().as_u16();
        let request_id = answer
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if !(200..300).contains(&status) {
            return Err(match request_id {
                Some(id) => format!("answered {status}, request id {id}"),
                None => format!("answered {status}"),
            });
        }
        answer
            .json::<serde_json::Value>()
            .map_err(|error| format!("answered {status} with what isn't JSON: {error}"))
    };

    let organization = match organization {
        Some(organization) => Some(organization.to_owned()),
        None => match get("/api/v2/people/me/organizations") {
            Ok(page) => {
                #[derive(Deserialize)]
                struct Page {
                    organizations: Vec<Organization>,
                }
                serde_json::from_value::<Page>(page)
                    .ok()
                    .and_then(|page| their_own_organization(&page.organizations))
            }
            Err(error) => {
                about.unanswered.push(format!(
                    "Which organization: GET /api/v2/people/me/organizations {error}."
                ));
                None
            }
        },
    };
    about.organization = organization.clone();
    let Some(organization) = organization else {
        return about;
    };

    match get(&format!("/api/v2/organizations/{organization}/people/me")) {
        Ok(answer) => {
            about.account = answer
                .pointer("/person/id")
                .and_then(|id| id.as_str())
                .map(str::to_owned);
            about.release = answer
                .get("openbotVersion")
                .and_then(|version| version.as_str())
                .map(str::to_owned);
        }
        Err(error) => about.unanswered.push(format!(
            "The account and the release: GET /api/v2/organizations/{organization}/people/me {error}."
        )),
    }
    match get(&format!("/api/v2/organizations/{organization}/deployment")) {
        Ok(answer) => {
            about.edition = answer
                .get("edition")
                .and_then(|edition| edition.as_str())
                .map(str::to_owned);
            about.api = answer
                .get("api")
                .and_then(|api| api.as_array())
                .map(|versions| {
                    versions
                        .iter()
                        .filter_map(|version| version.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
        }
        Err(error) => about.unanswered.push(format!(
            "What it offers: GET /api/v2/organizations/{organization}/deployment {error}."
        )),
    }
    about
}

/// A request's failure in a few words: timed out, refused, or the error's own.
fn plain_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "it didn't answer in time".to_owned()
    } else if error.is_connect() {
        "couldn't connect".to_owned()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// An OpenBot that answers as the API describes, on 127.0.0.1, for as many requests as asked.
    fn openbot(answers: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let served = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for _ in 0..answers {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut authorized = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line
                        .to_ascii_lowercase()
                        .starts_with("authorization: bearer oba_test")
                    {
                        authorized = true;
                    }
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let path = first
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                asked.push(format!("{path} {authorized}"));
                let body = match path.as_str() {
                    "/health" => r#"{"status":"ok"}"#.to_owned(),
                    "/api/v2/people/me/organizations" => {
                        r#"{"organizations":[{"id":"org_team","active":true},{"id":"Kd8fJ2pQKd8fJ2pQ","personal":true}],"nextCursor":null}"#.to_owned()
                    }
                    p if p.ends_with("/people/me") => {
                        r#"{"person":{"id":"usr_1","email":"dana@acme-robotics.io","name":"Dana","image":null},"openbotVersion":"v1.2.0-rc.4"}"#.to_owned()
                    }
                    p if p.ends_with("/deployment") => {
                        r#"{"edition":"team","api":["v2"],"authProviders":[]}"#.to_owned()
                    }
                    _ => String::new(),
                };
                let status = if body.is_empty() {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let mut stream = stream;
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nx-request-id: req_test\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
            asked
        });
        (address, served)
    }

    /// Signed in with no organization on record: the person's own is picked from their list, and
    /// the account's id and the server's release come from getPerson, never the email.
    #[test]
    fn a_signed_in_app_learns_the_release_the_account_and_the_organization() {
        let (address, served) = openbot(4);
        let token = || Ok("oba_test".to_owned());
        let about = ask(
            &address,
            None,
            Some(&token),
            Instant::now() + Duration::from_secs(10),
        );
        assert!(
            about.health.starts_with("answered 200 in "),
            "{}",
            about.health
        );
        assert_eq!(about.organization.as_deref(), Some("Kd8fJ2pQKd8fJ2pQ"));
        assert_eq!(about.account.as_deref(), Some("usr_1"));
        assert_eq!(about.release.as_deref(), Some("v1.2.0-rc.4"));
        assert_eq!(about.edition.as_deref(), Some("team"));
        assert_eq!(about.api, vec!["v2"]);
        assert!(about.unanswered.is_empty(), "{:?}", about.unanswered);
        assert_eq!(
            served.join().unwrap(),
            vec![
                "/health false",
                "/api/v2/people/me/organizations true",
                "/api/v2/organizations/Kd8fJ2pQKd8fJ2pQ/people/me true",
                "/api/v2/organizations/Kd8fJ2pQKd8fJ2pQ/deployment true",
            ]
        );
    }

    /// Not signed in: only whether it answers. An address nobody answers at says so, in time.
    #[test]
    fn signed_out_or_unreachable_says_what_it_could_not_ask() {
        let (address, served) = openbot(1);
        let about = ask(
            &address,
            Some("org_team"),
            None,
            Instant::now() + Duration::from_secs(10),
        );
        assert!(about.health.starts_with("answered 200"), "{}", about.health);
        assert_eq!(about.account, None);
        assert_eq!(about.organization.as_deref(), Some("org_team"));
        assert_eq!(about.unanswered.len(), 1);
        served.join().unwrap();

        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let nobody = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let started = Instant::now();
        let token = || Ok("oba_test".to_owned());
        let about = ask(
            &nobody,
            Some("org_team"),
            Some(&token),
            Instant::now() + Duration::from_secs(3),
        );
        assert!(about.health.starts_with("no answer: "), "{}", about.health);
        assert_eq!(about.account, None);
        assert_eq!(about.unanswered.len(), 2, "{:?}", about.unanswered);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
