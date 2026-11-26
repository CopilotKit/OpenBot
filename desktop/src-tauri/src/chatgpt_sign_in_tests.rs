/*!
The ChatGPT sign-in against a stand-in for auth.openai.com that holds it to OpenAI's documented flow
(https://developers.openai.com/siwc/token-sharing-open-source/sign-in): the browser's redirect comes
back to the real loopback listener, the code is exchanged at the stand-in's token endpoint, which
checks every field, and the ID token it issues is signed with an RSA key it publishes as a JWKS.
The keys in `testdata/` are throwaway test keys made for these tests and nothing else.
*/

use super::*;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

/// The one sign-in slot is process-wide, and port 1455 machine-wide: these tests take turns with
/// every other test that binds it (`plan::tests::CALLBACK_PORT`) and with any that binds ports.
fn slot() -> (
    std::sync::MutexGuard<'static, ()>,
    std::sync::MutexGuard<'static, ()>,
) {
    (
        crate::plan::tests::CALLBACK_PORT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        crate::test_support::hold_ports(),
    )
}

const ISSUER_KEY: &[u8] = include_bytes!("testdata/issuer.der");
const STRANGER_KEY: &[u8] = include_bytes!("testdata/stranger.der");

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn jwt(key: &[u8], claims: serde_json::Value) -> String {
    let pair = ring::rsa::KeyPair::from_pkcs8(key).unwrap();
    let head = b64(br#"{"alg":"RS256","kid":"test-key","typ":"JWT"}"#);
    let body = b64(claims.to_string().as_bytes());
    let signed = format!("{head}.{body}");
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signed.as_bytes(),
        &mut signature,
    )
    .unwrap();
    format!("{signed}.{}", b64(&signature))
}

fn jwks() -> String {
    let pair = ring::rsa::KeyPair::from_pkcs8(ISSUER_KEY).unwrap();
    let public: ring::rsa::PublicKeyComponents<Vec<u8>> = pair.public().into();
    serde_json::json!({"keys": [{
        "kty": "RSA", "kid": "test-key", "alg": "RS256", "use": "sig",
        "n": b64(&public.n), "e": b64(&public.e),
    }]})
    .to_string()
}

/// What the stand-in issues for one exchange.
#[derive(Clone)]
struct Issue {
    scope: &'static str,
    key: &'static [u8],
    client_id: &'static str,
}

/// The stand-in for auth.openai.com: `POST /token` and `GET /jwks`.
struct StandIn {
    port: u16,
    exchanges: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

impl StandIn {
    fn start(issue: Issue, nonce: Arc<Mutex<String>>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let exchanges = Arc::new(Mutex::new(Vec::new()));
        let seen = exchanges.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let (line, body) = read_request(&mut stream);
                let (status, reply) = if line.starts_with("GET /jwks") {
                    ("200 OK", jwks())
                } else if line.starts_with("POST /token") {
                    let form: HashMap<String, String> =
                        reqwest::Url::parse(&format!("http://x/?{body}"))
                            .unwrap()
                            .query_pairs()
                            .into_owned()
                            .collect();
                    seen.lock().unwrap().push(form.clone());
                    if form.get("client_id").map(String::as_str) != Some(issue.client_id) {
                        (
                            "400 Bad Request",
                            r#"{"error":"invalid_client"}"#.to_string(),
                        )
                    } else {
                        let now = now();
                        let id_token = jwt(
                            issue.key,
                            serde_json::json!({
                                "iss": "https://auth.example.test", "aud": issue.client_id,
                                "sub": "user-123", "email": "person@example.test",
                                "nonce": nonce.lock().unwrap().clone(),
                                "iat": now, "exp": now + 3600,
                            }),
                        );
                        ("200 OK", serde_json::json!({
                            "access_token": "header.payload.signature", "refresh_token": "refresh-1",
                            "id_token": id_token, "token_type": "Bearer", "expires_in": 3600,
                            "scope": issue.scope, "earliest_refresh_at": now + 60,
                        }).to_string())
                    }
                } else {
                    ("404 Not Found", String::new())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        Self { port, exchanges }
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            authorize: "https://auth.example.test/api/accounts/authorize".into(),
            token: format!("http://127.0.0.1:{}/token", self.port),
            jwks: format!("http://127.0.0.1:{}/jwks", self.port),
            issuer: "https://auth.example.test".into(),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> (String, String) {
    let mut data = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).unwrap_or(0);
        if count == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..count]);
        let text = String::from_utf8_lossy(&data).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            if data.len() >= end + 4 + length {
                let body = String::from_utf8_lossy(&data[end + 4..end + 4 + length]).to_string();
                return (text.lines().next().unwrap_or("").to_string(), body);
            }
        }
    }
    (String::new(), String::new())
}

fn query_of(url: &str) -> HashMap<String, String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

/// The browser coming back from ChatGPT to the redirect the URL named.
fn browser_returns(url: &str, extra: &[(&str, &str)]) -> String {
    let query = query_of(url);
    let redirect = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    let mut back = redirect.clone();
    back.query_pairs_mut().append_pair("state", &query["state"]);
    for (name, value) in extra {
        back.query_pairs_mut().append_pair(name, value);
    }
    let mut stream = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    let target = format!("{}?{}", back.path(), back.query().unwrap());
    write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer
}

fn sign_in(
    root: &std::path::Path,
    issue: Issue,
    redirect_extra: Vec<(&'static str, &'static str)>,
) -> (String, Result<String, String>, Vec<HashMap<String, String>>) {
    let nonce = Arc::new(Mutex::new(String::new()));
    let stand_in = StandIn::start(issue, nonce.clone());
    let url = begin_with(&stand_in.endpoints(), root).unwrap();
    *nonce.lock().unwrap() = query_of(&url)["nonce"].clone();
    let finishing = std::thread::spawn(finish);
    let page = browser_returns(&url, &redirect_extra);
    let result = finishing.join().unwrap();
    assert!(page.contains("ChatGPT"), "{page}");
    let exchanges = stand_in.exchanges.lock().unwrap().clone();
    (url, result, exchanges)
}

const GRANTED: &str =
    "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

#[test]
fn a_first_sign_in_registers_openbot_and_returns_the_plan_record() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-first-sign-in");
    let issue = Issue {
        scope: GRANTED,
        key: ISSUER_KEY,
        client_id: "oaiapp_issued",
    };
    let (url, result, exchanges) = sign_in(
        &root,
        issue,
        vec![("code", "the-code"), ("client_id", "oaiapp_issued")],
    );

    let query = query_of(&url);
    assert!(url.starts_with("https://auth.example.test/api/accounts/authorize?"));
    assert_eq!(query["client_id"], "dynamic_agent_client");
    assert_eq!(query["agent_name_hint"], "OpenBot");
    assert!(query["ext_agent_host_id"].starts_with("urn:uuid:"));
    assert_eq!(query["response_type"], "code");
    assert_eq!(
        query["scope"],
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    );
    assert_eq!(query["resource"], "https://api.openai.com/v1");
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(query["redirect_uri"].starts_with("http://127.0.0.1:"));
    assert!(query["redirect_uri"].ends_with("/auth/callback"));
    assert!(!query.contains_key("id_token_hint"));

    let exchange = &exchanges[0];
    assert_eq!(exchange["grant_type"], "authorization_code");
    assert_eq!(exchange["client_id"], "oaiapp_issued");
    assert_eq!(exchange["code"], "the-code");
    assert_eq!(exchange["redirect_uri"], query["redirect_uri"]);
    assert_eq!(exchange["resource"], "https://api.openai.com/v1");
    assert_eq!(
        crate::provider_oauth::pkce_challenge(&exchange["code_verifier"]),
        query["code_challenge"]
    );
    assert!(!exchange.contains_key("client_secret"));

    let record: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(record["client_id"], "oaiapp_issued");
    assert_eq!(record["subject"], "user-123");
    assert_eq!(record["refresh_token"], "refresh-1");
    assert_eq!(record["ext_agent_host_id"], query["ext_agent_host_id"]);
    assert!(record["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s == PLAN_SCOPE));
}

#[test]
fn a_returning_sign_in_reuses_the_issued_client_and_this_computers_host_id() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-returning-sign-in");
    let first = Issue {
        scope: GRANTED,
        key: ISSUER_KEY,
        client_id: "oaiapp_issued",
    };
    let (first_url, record, _) = sign_in(
        &root,
        first.clone(),
        vec![("code", "c1"), ("client_id", "oaiapp_issued")],
    );
    crate::env::write_plan_store(
        &root,
        &crate::env::ModelCredential::ChatGptPlan {
            store: record.unwrap(),
        },
    )
    .unwrap();

    // The callback may leave the client id out on reauthorization.
    let (url, result, exchanges) = sign_in(&root, first, vec![("code", "c2")]);
    let query = query_of(&url);
    assert_eq!(query["client_id"], "oaiapp_issued");
    assert!(!query.contains_key("agent_name_hint"));
    assert!(query.contains_key("id_token_hint"));
    assert_eq!(query["login_hint"], "person@example.test");
    assert_eq!(
        query["ext_agent_host_id"],
        query_of(&first_url)["ext_agent_host_id"]
    );
    assert_eq!(exchanges[0]["client_id"], "oaiapp_issued");
    assert!(result.is_ok());
}

#[test]
fn a_sign_in_without_plan_permission_saves_nothing() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-no-plan-scope");
    let issue = Issue {
        scope: "email offline_access openid profile",
        key: ISSUER_KEY,
        client_id: "oaiapp_issued",
    };
    let (_, result, _) = sign_in(
        &root,
        issue,
        vec![("code", "c"), ("client_id", "oaiapp_issued")],
    );
    assert_eq!(result.unwrap_err(), NOT_ALLOWED);
}

#[test]
fn a_declined_consent_is_not_exchanged() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-declined");
    let issue = Issue {
        scope: GRANTED,
        key: ISSUER_KEY,
        client_id: "oaiapp_issued",
    };
    let (_, result, exchanges) = sign_in(&root, issue, vec![("error", "access_denied")]);
    assert_eq!(result.unwrap_err(), NOT_ALLOWED);
    assert!(exchanges.is_empty());
}

#[test]
fn an_id_token_not_signed_by_the_issuer_is_refused() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-forged-id-token");
    let issue = Issue {
        scope: GRANTED,
        key: STRANGER_KEY,
        client_id: "oaiapp_issued",
    };
    let (_, result, _) = sign_in(
        &root,
        issue,
        vec![("code", "c"), ("client_id", "oaiapp_issued")],
    );
    assert_eq!(result.unwrap_err(), REFUSED);
}

#[test]
fn a_new_registration_without_an_issued_client_is_incomplete() {
    let _slot = slot();
    let root = crate::test_support::temp_root("chatgpt-no-issued-client");
    let issue = Issue {
        scope: GRANTED,
        key: ISSUER_KEY,
        client_id: "oaiapp_issued",
    };
    let (_, result, exchanges) = sign_in(&root, issue, vec![("code", "c")]);
    assert_eq!(result.unwrap_err(), INCOMPLETE);
    assert!(exchanges.is_empty());
}
