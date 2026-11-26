/*!
Signing in to a ChatGPT plan with OpenAI's official Sign in with ChatGPT plan usage.

The flow is OpenAI's documented one for open-source and locally hosted apps
(https://developers.openai.com/siwc/token-sharing-open-source/sign-in), run natively here:

1. This computer has a stable, opaque host id (`urn:uuid:` + a UUIDv4), made once and kept beside
   the installation ([`HOST_ID_FILE`]). It is not a credential and says nothing about the person.
2. A listener on `127.0.0.1` (1455 when free, else any port: only the port may vary), and a fresh
   `state`, OIDC `nonce` and PKCE verifier for each attempt.
3. The system browser opens `https://auth.openai.com/api/accounts/authorize`. A first sign-in
   registers OpenBot as the person's agent (`client_id=dynamic_agent_client`,
   `agent_name_hint=OpenBot`); a later one reuses the `oaiapp_` client id that registration issued,
   with the saved ID token as `id_token_hint`. Scopes: `openid profile email` and the plan's
   `offline_access resource.invoke chatgpt.tokens.use.direct`, for `resource=https://api.openai.com/v1`.
4. The redirect brings back `code`, `state` and, for a new registration, the issued `client_id`.
   The code is exchanged at `https://auth.openai.com/api/accounts/oauth/token` with that client id,
   the PKCE verifier, the same redirect URI and resource. No client secret.
5. The ID token is checked: RS256 signature against OpenAI's published JWKS, issuer, audience (the
   issued client id), expiry and nonce. The granted scopes must include `chatgpt.tokens.use.direct`,
   or plan use was not allowed and nothing is saved
   (https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery#chatgpt-plan-use-isnt-enabled).
6. The credential record (identity, issued client id, host id, tokens, scopes, expiry) is what this
   returns. The caller keeps it owner-only in the file the plan's engine reads and renews.

No token is logged, shown, or put in a URL; only the ID token is ever sent back, as `id_token_hint`,
and only to OpenAI's authorize endpoint.
*/

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

use crate::loopback_redirect::{BindError, Ended, Listener, Outcome};

pub const ISSUER: &str = "https://auth.openai.com";
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const JWKS_URL: &str = "https://auth.openai.com/.well-known/jwks.json";
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that lets OpenBot use the person's plan. A sign-in without it is not used.
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// The first-time registration entry point. Never saved and never used for an exchange.
pub const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
/// The app's actual name, the same on every installation. The person may rename it on consent.
pub const AGENT_NAME: &str = "OpenBot";
/// This computer's host id, beside the installation, in the folder Compose mounts into the server.
pub const HOST_ID_FILE: &str = ".openbot/chatgpt-host-id";
const CALLBACK_PATH: &str = "/auth/callback";
const PREFERRED_PORT: u16 = 1455;
const PATIENCE_FOR_THE_PERSON: Duration = Duration::from_secs(900);

const DONE_HEADING: &str = "OpenBot is signed in to ChatGPT";
const DONE_LINES: &[&str] = &["You can close this tab and go back to OpenBot."];
const FAILED_HEADING: &str = "The ChatGPT sign-in didn't finish";
const FAILED_LINES: &[&str] = &["Go back to OpenBot and sign in again."];

const NOT_ALLOWED: &str = "ChatGPT didn't allow OpenBot to use your plan. Sign in again and allow it, or use an OpenAI API key.";
const DIDNT_FINISH: &str =
    "That sign-in did not finish. Start it again and approve the request in your browser.";
const STOPPED: &str = "The sign-in was stopped. Start it again.";
const NO_LONGER_RUNNING: &str = "That sign-in is no longer running. Start it again.";
const LOST: &str =
    "Could not reach ChatGPT to finish signing in. Check your connection and sign in again.";
const REFUSED: &str = "ChatGPT didn't accept the sign-in. Sign in again.";
const UNREADABLE: &str = "ChatGPT returned an unreadable sign-in response. Sign in again.";
const INCOMPLETE: &str = "ChatGPT didn't finish registering OpenBot. Sign in again.";
const OTHER_ACCOUNT: &str =
    "That sign-in came back for a different ChatGPT registration. Sign in again.";

/// Where the OAuth runs: OpenAI's own endpoints, unless a test points them at a stand-in.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub jwks: String,
    pub issuer: String,
}

impl Endpoints {
    pub fn configured() -> Self {
        let named = |name: &str, default: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        Self {
            authorize: named("OPENBOT_CHATGPT_OAUTH_AUTHORIZE_URL", AUTHORIZE_URL),
            token: named("OPENBOT_CHATGPT_OAUTH_TOKEN_URL", TOKEN_URL),
            jwks: named("OPENBOT_CHATGPT_OAUTH_JWKS_URL", JWKS_URL),
            issuer: named("OPENBOT_CHATGPT_OAUTH_ISSUER", ISSUER),
        }
    }
}

/// What an earlier sign-in on this computer registered, read from its saved record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Registration {
    pub client_id: String,
    pub id_token: Option<String>,
    pub email: Option<String>,
    pub subject: Option<String>,
}

impl Registration {
    /// The registration a saved credential record carries, if it is one of ours.
    pub fn from_record(record: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(record).ok()?;
        let client_id = value.get("client_id")?.as_str()?.trim().to_owned();
        if client_id.is_empty() || client_id == DYNAMIC_CLIENT {
            return None;
        }
        let text = |name: &str| {
            value
                .get(name)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            client_id,
            id_token: text("id_token"),
            email: text("email"),
            subject: text("subject"),
        })
    }
}

/// This computer's host id: made once (`urn:uuid:` and a UUIDv4) and reused for every sign-in.
pub fn host_id(root: &std::path::Path) -> std::io::Result<String> {
    let path = root.join(HOST_ID_FILE);
    if let Ok(saved) = std::fs::read_to_string(&path) {
        let saved = saved.trim();
        if saved.starts_with("urn:uuid:") && saved.len() == "urn:uuid:".len() + 36 {
            return Ok(saved.to_owned());
        }
    }
    let made = format!("urn:uuid:{}", uuid::Uuid::new_v4().hyphenated());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::env::write_private_file(&path, format!("{made}\n").as_bytes())?;
    Ok(made)
}

/// One sign-in, from its start to its credential record.
pub struct SignIn {
    verifier: String,
    state: String,
    nonce: String,
    redirect_uri: String,
    /// The loopback port the browser comes back to.
    port: u16,
    url: String,
    host_id: String,
    returning: Option<Registration>,
    endpoints: Endpoints,
    listener: Mutex<Option<Listener>>,
    cancelled: AtomicBool,
}

impl SignIn {
    /// PKCE, a state, a nonce, the listener on `127.0.0.1`, and the URL to approve at.
    pub fn start(
        endpoints: &Endpoints,
        host_id: String,
        returning: Option<Registration>,
    ) -> Result<Self, String> {
        // A redirect OpenBot's page asked Desktop to catch on 1455 (`sign_in_redirect`) gives way
        // to this newer sign-in, as it gives way to any.
        crate::sign_in_redirect::release_port(PREFERRED_PORT);
        let listener = match Listener::on_port(PREFERRED_PORT, CALLBACK_PATH) {
            Ok(listener) => listener,
            Err(BindError::Busy) | Err(BindError::Failed(_)) => {
                Listener::on_any_port(CALLBACK_PATH).map_err(|error| {
                    format!(
                        "OpenBot couldn't start the sign-in on this computer. Try again. ({error})"
                    )
                })?
            }
        };
        let verifier = crate::provider_oauth::random();
        let state = crate::provider_oauth::random();
        let nonce = crate::provider_oauth::random();
        let challenge = crate::provider_oauth::pkce_challenge(&verifier);
        let redirect_uri = listener.redirect_uri_ipv4();
        let port = listener.port();
        let url = authorize_url(
            &endpoints.authorize,
            &redirect_uri,
            &challenge,
            &state,
            &nonce,
            &host_id,
            returning.as_ref(),
        )?;
        Ok(Self {
            verifier,
            state,
            nonce,
            redirect_uri,
            port,
            url,
            host_id,
            returning,
            endpoints: endpoints.clone(),
            listener: Mutex::new(Some(listener)),
            cancelled: AtomicBool::new(false),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// The credential record, once the browser comes back and every check passes.
    pub fn finish(&self) -> Result<String, String> {
        let listener = self
            .listener
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| NO_LONGER_RUNNING.to_string())?;
        let (outcome, query, reply) = listener
            .wait_with_query(&self.state, PATIENCE_FOR_THE_PERSON, &|| {
                self.cancelled.load(Ordering::SeqCst)
            })
            .map_err(|ended| match ended {
                Ended::Cancelled => STOPPED.to_string(),
                Ended::TimedOut | Ended::PortWanted | Ended::Failed(_) => DIDNT_FINISH.to_string(),
            })?;
        let result = match outcome {
            Outcome::Error { error, .. } if error == "access_denied" => {
                Err(NOT_ALLOWED.to_string())
            }
            Outcome::Error { .. } => Err(DIDNT_FINISH.to_string()),
            Outcome::Code { code, .. } => self
                .client_id_from(&query)
                .and_then(|client_id| self.exchange(&code, &client_id)),
        };
        match &result {
            Ok(_) => reply.page("200 OK", DONE_HEADING, DONE_LINES),
            Err(_) => reply.page("200 OK", FAILED_HEADING, FAILED_LINES),
        }
        result
    }

    /// The client id this attempt exchanges with: the one a new registration was issued, or the
    /// saved one a returning sign-in used. A different one is refused, never adopted.
    fn client_id_from(
        &self,
        query: &std::collections::BTreeMap<String, String>,
    ) -> Result<String, String> {
        let given = query
            .get("client_id")
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty() && id != DYNAMIC_CLIENT);
        match (&self.returning, given) {
            (None, Some(issued)) => Ok(issued),
            (None, None) => Err(INCOMPLETE.into()),
            (Some(saved), Some(given)) if given != saved.client_id => Err(OTHER_ACCOUNT.into()),
            (Some(saved), _) => Ok(saved.client_id.clone()),
        }
    }

    fn exchange(&self, code: &str, client_id: &str) -> Result<String, String> {
        let client = http()?;
        let response = client
            .post(&self.endpoints.token)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("code_verifier", self.verifier.as_str()),
                ("redirect_uri", self.redirect_uri.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(|_| LOST.to_string())?;
        if !response.status().is_success() {
            log::warn!(
                "[chatgpt-sign-in] the code exchange was refused ({})",
                response.status().as_u16()
            );
            return Err(REFUSED.into());
        }
        let tokens: serde_json::Value = response.json().map_err(|_| UNREADABLE.to_string())?;
        let text = |name: &str| {
            tokens
                .get(name)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .filter(|v| !v.is_empty())
        };
        let access_token = text("access_token").ok_or_else(|| UNREADABLE.to_string())?;
        let refresh_token = text("refresh_token").ok_or_else(|| UNREADABLE.to_string())?;
        let id_token = text("id_token").ok_or_else(|| UNREADABLE.to_string())?;
        let mut scopes: Vec<String> = text("scope")
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        scopes.sort();
        if !scopes.iter().any(|scope| scope == PLAN_SCOPE) {
            return Err(NOT_ALLOWED.into());
        }
        let claims = verify_id_token(&id_token, client_id, &self.nonce, &self.endpoints)?;
        let subject = claims
            .get("sub")
            .and_then(|v| v.as_str())
            .filter(|sub| !sub.is_empty())
            .ok_or_else(|| REFUSED.to_string())?
            .to_owned();
        if let Some(saved) = &self.returning {
            if saved
                .subject
                .as_deref()
                .is_some_and(|before| before != subject)
            {
                return Err(OTHER_ACCOUNT.into());
            }
        }
        let now = now();
        let expires_in = tokens
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(3600);
        let saved_at = time::OffsetDateTime::from_unix_timestamp(now as i64)
            .ok()
            .and_then(|at| {
                at.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            })
            .unwrap_or_default();
        let record = serde_json::json!({
            "email": claims.get("email").and_then(|v| v.as_str()).unwrap_or_default(),
            "issuer": self.endpoints.issuer,
            "subject": subject,
            "client_id": client_id,
            "ext_agent_host_id": self.host_id,
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": text("token_type").unwrap_or_else(|| "Bearer".into()),
            "expires_in": expires_in,
            "expires_at": now + expires_in,
            "scopes": scopes,
            "saved_at": saved_at,
        });
        Ok(record.to_string())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("OpenBot/desktop-chatgpt-sign-in")
        .build()
        .map_err(|_| LOST.to_string())
}

/// The authorize URL, with each value URL-encoded.
fn authorize_url(
    authorize: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    nonce: &str,
    host_id: &str,
    returning: Option<&Registration>,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(authorize)
        .map_err(|_| "OpenBot couldn't start the sign-in with ChatGPT.".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        match returning {
            None => {
                query.append_pair("client_id", DYNAMIC_CLIENT);
                query.append_pair("agent_name_hint", AGENT_NAME);
            }
            Some(saved) => {
                query.append_pair("client_id", &saved.client_id);
                if let Some(hint) = &saved.id_token {
                    query.append_pair("id_token_hint", hint);
                }
                if let Some(email) = &saved.email {
                    query.append_pair("login_hint", email);
                }
            }
        }
        query.extend_pairs([
            ("ext_agent_host_id", host_id),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", SCOPE),
            ("resource", RESOURCE),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
        ]);
    }
    Ok(url.into())
}

/**
The ID token's claims, once its RS256 signature verifies against OpenAI's published keys and its
issuer, audience, expiry and nonce are this sign-in's
(https://developers.openai.com/siwc/token-sharing-open-source/sign-in#4-validate-the-id-token-and-chatgpt-plan-permission).
*/
fn verify_id_token(
    token: &str,
    client_id: &str,
    nonce: &str,
    endpoints: &Endpoints,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let refused = || REFUSED.to_string();
    let mut parts = token.split('.');
    let (Some(head), Some(body), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(refused());
    };
    let decode = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part.trim_end_matches('='))
            .map_err(|_| refused())
    };
    let header: serde_json::Value =
        serde_json::from_slice(&decode(head)?).map_err(|_| refused())?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("RS256") {
        return Err(refused());
    }
    let kid = header.get("kid").and_then(|v| v.as_str());
    let keys: serde_json::Value = http()?
        .get(&endpoints.jwks)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|_| LOST.to_string())?
        .json()
        .map_err(|_| UNREADABLE.to_string())?;
    let signature = decode(signature)?;
    let signed = format!("{head}.{body}");
    let verified = keys
        .get("keys")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|key| key.get("kty").and_then(|v| v.as_str()) == Some("RSA"))
        .filter(|key| kid.is_none() || key.get("kid").and_then(|v| v.as_str()) == kid)
        .any(|key| {
            let component = |name: &str| {
                key.get(name)
                    .and_then(|v| v.as_str())
                    .and_then(|v| URL_SAFE_NO_PAD.decode(v.trim_end_matches('=')).ok())
            };
            let (Some(n), Some(e)) = (component("n"), component("e")) else {
                return false;
            };
            ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
                .verify(
                    &ring::signature::RSA_PKCS1_2048_8192_SHA256,
                    signed.as_bytes(),
                    &signature,
                )
                .is_ok()
        });
    if !verified {
        log::warn!("[chatgpt-sign-in] the ID token's signature did not verify");
        return Err(refused());
    }
    let claims: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&decode(body)?).map_err(|_| refused())?;
    let audience_ok = match claims.get("aud") {
        Some(serde_json::Value::String(aud)) => aud == client_id,
        Some(serde_json::Value::Array(auds)) => {
            auds.iter().any(|aud| aud.as_str() == Some(client_id))
        }
        _ => false,
    };
    let issuer_ok = claims.get("iss").and_then(|v| v.as_str()) == Some(endpoints.issuer.as_str());
    let nonce_ok = claims.get("nonce").and_then(|v| v.as_str()) == Some(nonce);
    let unexpired = claims
        .get("exp")
        .and_then(|v| v.as_u64())
        .is_some_and(|exp| exp + 60 > now());
    if !(audience_ok && issuer_ok && nonce_ok && unexpired) {
        log::warn!(
            "[chatgpt-sign-in] the ID token was refused (audience {audience_ok}, issuer {issuer_ok}, nonce {nonce_ok}, unexpired {unexpired})"
        );
        return Err(refused());
    }
    Ok(claims)
}

/// The sign-in in progress on this computer. One at a time: a new one stops the last.
static ACTIVE: Mutex<Option<Arc<SignIn>>> = Mutex::new(None);

fn active() -> std::sync::MutexGuard<'static, Option<Arc<SignIn>>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start a sign-in for the installation in `root` and return the URL to open.
pub fn begin(root: &std::path::Path) -> Result<String, String> {
    begin_with(&Endpoints::configured(), root)
}

pub fn begin_with(endpoints: &Endpoints, root: &std::path::Path) -> Result<String, String> {
    let host_id = host_id(root)
        .map_err(|error| format!("OpenBot couldn't prepare the ChatGPT sign-in. ({error})"))?;
    let returning = crate::env::read_plan_store(root)
        .ok()
        .flatten()
        .and_then(|record| Registration::from_record(&record));
    let signing = Arc::new(SignIn::start(endpoints, host_id, returning)?);
    let url = signing.url().to_owned();
    if let Some(previous) = active().replace(signing) {
        previous.cancel();
    }
    Ok(url)
}

/// Finish the sign-in in progress and return its credential record. Every end ends it.
pub fn finish() -> Result<String, String> {
    let signing = active()
        .clone()
        .ok_or_else(|| NO_LONGER_RUNNING.to_string())?;
    let result = signing.finish();
    let mut current = active();
    if current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &signing))
    {
        current.take();
    }
    result
}

/// Whether a sign-in of Desktop's own is waiting for the browser on `port`.
pub fn waiting_on(port: u16) -> bool {
    active()
        .as_ref()
        .is_some_and(|signing| signing.port == port && !signing.cancelled.load(Ordering::SeqCst))
}

/// Stop the sign-in in progress, if any. Whoever waits in `finish` hears it stopped.
pub fn cancel() {
    if let Some(signing) = active().take() {
        signing.cancel();
    }
}

#[cfg(test)]
#[path = "chatgpt_sign_in_tests.rs"]
mod tests;
