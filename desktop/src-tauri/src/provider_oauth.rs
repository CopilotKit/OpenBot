//! Desktop provider authorization. Tokens stay in the installation's private runtime store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "provider_oauth_lock.rs"]
mod credential_lock;

pub const FILE: &str = ".openbot/model-oauth.json";
const XAI_CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub version: u8,
    pub session_id: String,
    pub provider: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_project: Option<String>,
    pub proxy_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub attempt_id: String,
    pub url: String,
    pub user_code: Option<String>,
}

struct Flow {
    id: String,
    root: PathBuf,
    canceled: AtomicBool,
    pending: Mutex<Option<Pending>>,
}
enum Pending {
    Google {
        listener: TcpListener,
        verifier: String,
        state: String,
        redirect: String,
        client_id: String,
        client_secret: Option<String>,
        project: String,
    },
    Xai {
        client_id: String,
        device_code: String,
        interval: u64,
        expires: Instant,
    },
}
static ACTIVE: OnceLock<Mutex<Option<Arc<Flow>>>> = OnceLock::new();
fn active() -> &'static Mutex<Option<Arc<Flow>>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}
fn random() -> String {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn configured(name: &str) -> Option<String> {
    let embedded = match name {
        "OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID")
        }
        "OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET")
        }
        "OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT")
        }
        "OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID" => option_env!("OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID"),
        _ => None,
    };
    std::env::var(name)
        .ok()
        .or_else(|| embedded.map(str::to_owned))
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}
fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("OpenBot/desktop-provider-oauth")
        .build()
        .map_err(|e| e.to_string())
}
fn response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .map_err(|_| "The provider returned an unreadable sign-in response.".to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Provider sign-in failed ({}): {}",
            status.as_u16(),
            value
                .get("error_description")
                .or_else(|| value.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("request refused")
        ));
    }
    Ok(value)
}
fn required(value: &serde_json::Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("The provider omitted {field} from its sign-in response."))
}
fn reserve(root: &Path) -> Arc<Flow> {
    let flow = Arc::new(Flow {
        id: random(),
        root: root.to_owned(),
        canceled: AtomicBool::new(false),
        pending: Mutex::new(None),
    });
    if let Some(previous) = active().lock().unwrap().replace(flow.clone()) {
        previous.canceled.store(true, Ordering::SeqCst);
    }
    flow
}
pub fn begin(root: &Path, provider: &str) -> Result<Authorization, String> {
    // Reserve before blocking network work so a late response cannot replace a newer sign-in.
    let flow = reserve(root);
    let (pending, url, user_code) = match provider {
        "google" => {
            let client_id = configured("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID").ok_or("Google sign-in needs this OpenBot build's registered desktop OAuth client. Use an API key until it is configured.")?;
            let project = configured("OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT").ok_or(
                "Google sign-in needs a Google Cloud quota project with the Gemini API enabled.",
            )?;
            let client_secret = configured("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET");
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let redirect = format!(
                "http://127.0.0.1:{}/oauth/callback",
                listener.local_addr().map_err(|e| e.to_string())?.port()
            );
            let verifier = random();
            let state = random();
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let mut url =
                reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
            url.query_pairs_mut().extend_pairs([
                ("client_id", client_id.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", GOOGLE_SCOPE),
                ("access_type", "offline"),
                ("prompt", "consent"),
                ("state", state.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
            ]);
            (
                Pending::Google {
                    listener,
                    verifier,
                    state,
                    redirect,
                    client_id,
                    client_secret,
                    project,
                },
                url.to_string(),
                None,
            )
        }
        "xai" => {
            let client_id = configured("OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID")
                .unwrap_or_else(|| XAI_CLIENT.into());
            let body = response_json(
                http()?
                    .post("https://auth.x.ai/oauth2/device/code")
                    .form(&[
                        ("client_id", client_id.as_str()),
                        ("scope", XAI_SCOPE),
                        ("referrer", "openbot"),
                    ])
                    .send()
                    .map_err(|e| e.to_string())?,
            )?;
            let url = xai_verification_url(&body)?;
            let user_code = required(&body, "user_code")?;
            let device_code = required(&body, "device_code")?;
            let interval = body
                .get("interval")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .max(1);
            let expires = Instant::now()
                + Duration::from_secs(
                    body.get("expires_in")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(600)
                        .min(1800),
                );
            (
                Pending::Xai {
                    client_id,
                    device_code,
                    interval,
                    expires,
                },
                url,
                Some(user_code),
            )
        }
        _ => return Err("That provider does not support this sign-in flow.".into()),
    };
    check(&flow)?;
    *flow.pending.lock().unwrap() = Some(pending);
    Ok(Authorization {
        attempt_id: flow.id.clone(),
        url,
        user_code,
    })
}

pub fn cancel(id: &str) {
    let mut current = active().lock().unwrap();
    if current.as_ref().is_some_and(|flow| flow.id == id) {
        if let Some(flow) = current.take() {
            flow.canceled.store(true, Ordering::SeqCst);
        }
    }
}
fn check(flow: &Flow) -> Result<(), String> {
    if flow.canceled.load(Ordering::SeqCst) {
        Err("Sign-in was canceled.".into())
    } else {
        Ok(())
    }
}
fn wait(flow: &Flow, duration: Duration) -> Result<(), String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        check(flow)?;
        std::thread::sleep(
            Duration::from_millis(100).min(end.saturating_duration_since(Instant::now())),
        );
    }
    check(flow)
}

fn xai_verification_url(body: &serde_json::Value) -> Result<String, String> {
    let value = body
        .get("verification_uri_complete")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .map(Ok)
        .unwrap_or_else(|| required(body, "verification_uri"))?;
    let invalid = "xAI returned an unsupported sign-in URL.";
    let parsed = reqwest::Url::parse(&value).map_err(|_| invalid)?;
    // The provider's device verification page is https://accounts.x.ai/oauth2/device.
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("accounts.x.ai")
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(invalid.into());
    }
    Ok(parsed.into())
}

pub fn finish(id: &str) -> Result<(), String> {
    let flow = active()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|flow| flow.id == id)
        .cloned()
        .ok_or("That sign-in is no longer active.")?;
    let pending = flow
        .pending
        .lock()
        .unwrap()
        .take()
        .ok_or("That sign-in is already being completed.")?;
    let result = finish_flow(&flow, pending);
    let mut current = active().lock().unwrap();
    if current.as_ref().is_some_and(|current| current.id == id) {
        current.take();
    }
    result
}
pub(crate) fn read_callback_request(
    stream: &mut TcpStream,
    timeout: Duration,
) -> std::io::Result<String> {
    // Winsock accept inherits the listener's nonblocking mode; a timeout does not clear it.
    stream.set_nonblocking(false)?;
    let deadline = Instant::now() + timeout;
    let mut bytes = [0; 8192];
    let mut length = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Sign-in callback timed out.",
            ));
        }
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(&mut bytes[length..])?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Incomplete sign-in callback.",
            ));
        }
        length += count;
        if let Some(end) = bytes[..length].iter().position(|byte| *byte == b'\n') {
            return Ok(String::from_utf8_lossy(&bytes[..=end]).into_owned());
        }
        if length == bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Sign-in callback is too large.",
            ));
        }
    }
}

fn receive_callback(stream: &mut TcpStream, state: &str) -> Result<Option<String>, String> {
    let request =
        read_callback_request(stream, Duration::from_secs(2)).map_err(|error| error.to_string())?;
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let parsed = reqwest::Url::parse(&format!("http://localhost{path}"))
        .map_err(|_| "Invalid sign-in callback.")?;
    let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    if parsed.path() != "/oauth/callback" || query.get("state").map(String::as_str) != Some(state) {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid sign-in callback.",
        );
        return Ok(None);
    }
    if let Some(error) = query.get("error") {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nSign-in was not approved. Return to OpenBot.");
        return Err(format!("Google sign-in was not approved: {error}"));
    }
    let code = query
        .get("code")
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or("Google did not return an authorization code.")?;
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nReturn to OpenBot to finish signing in.").map_err(|e| e.to_string())?;
    Ok(Some(code))
}

fn finish_flow(flow: &Flow, pending: Pending) -> Result<(), String> {
    let (provider, client_id, client_secret, project, scope, tokens) = match pending {
        Pending::Google {
            listener,
            verifier,
            state,
            redirect,
            client_id,
            client_secret,
            project,
        } => {
            let deadline = Instant::now() + Duration::from_secs(600);
            let code = loop {
                check(flow)?;
                if Instant::now() >= deadline {
                    return Err("Google sign-in timed out. Try signing in again.".into());
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if let Some(code) = receive_callback(&mut stream, &state)? {
                            break code;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        wait(flow, Duration::from_millis(100))?
                    }
                    Err(error) => return Err(error.to_string()),
                }
            };
            let mut form = vec![
                ("client_id", client_id.as_str()),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
            ];
            if let Some(secret) = &client_secret {
                form.push(("client_secret", secret));
            }
            let tokens = response_json(
                http()?
                    .post("https://oauth2.googleapis.com/token")
                    .form(&form)
                    .send()
                    .map_err(|e| e.to_string())?,
            )?;
            (
                "google",
                client_id,
                client_secret,
                Some(project),
                GOOGLE_SCOPE,
                tokens,
            )
        }
        Pending::Xai {
            client_id,
            device_code,
            mut interval,
            expires,
        } => {
            let tokens = loop {
                if Instant::now() >= expires {
                    return Err("xAI sign-in expired. Try signing in again.".into());
                }
                wait(flow, Duration::from_secs(interval))?;
                let response = http()?
                    .post("https://auth.x.ai/oauth2/token")
                    .form(&[
                        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                        ("client_id", client_id.as_str()),
                        ("device_code", device_code.as_str()),
                    ])
                    .send()
                    .map_err(|e| e.to_string())?;
                let status = response.status();
                let body: serde_json::Value = response
                    .json()
                    .map_err(|_| "xAI returned an unreadable sign-in response.")?;
                if status.is_success() {
                    break body;
                }
                match body.get("error").and_then(|v| v.as_str()) {
                    Some("authorization_pending") => continue,
                    Some("slow_down") => {
                        interval = interval.saturating_add(5);
                        continue;
                    }
                    Some("access_denied") => return Err("xAI sign-in was not approved.".into()),
                    Some("expired_token") => {
                        return Err("xAI sign-in expired. Try signing in again.".into())
                    }
                    _ => {
                        return Err(format!(
                            "xAI sign-in failed ({}). Try signing in again.",
                            status.as_u16()
                        ))
                    }
                }
            };
            ("xai", client_id, None, None, XAI_SCOPE, tokens)
        }
    };
    check(flow)?;
    let credentials =
        credentials_from_tokens(provider, client_id, client_secret, project, scope, &tokens)?;
    write(&flow.root, &credentials, || check(flow))
}
fn credentials_from_tokens(
    provider: &str,
    client_id: String,
    client_secret: Option<String>,
    quota_project: Option<String>,
    scope: &str,
    tokens: &serde_json::Value,
) -> Result<Credentials, String> {
    let duration = tokens
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .or_else(|| (provider == "xai").then_some(3600))
        .ok_or("The provider did not return a token expiry.")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(Credentials {
        version: 1,
        session_id: random(),
        provider: provider.into(),
        client_id,
        client_secret,
        access_token: required(tokens, "access_token")?,
        refresh_token: required(tokens, "refresh_token")?,
        expires_at: now.saturating_add(duration.saturating_mul(1000)),
        scope: tokens
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or(scope)
            .into(),
        quota_project,
        proxy_token: random(),
    })
}
pub fn read(root: &Path, provider: &str) -> Result<Credentials, String> {
    let bytes = std::fs::read(root.join(FILE))
        .map_err(|_| "The saved provider sign-in is unavailable. Sign in again.")?;
    let saved: Credentials = serde_json::from_slice(&bytes)
        .map_err(|_| "The saved provider sign-in is unreadable. Sign in again.")?;
    if saved.version != 1
        || saved.provider != provider
        || saved.refresh_token.is_empty()
        || saved.proxy_token.is_empty()
    {
        return Err("The saved sign-in does not match this provider. Sign in again.".into());
    }
    Ok(saved)
}
fn write(
    root: &Path,
    credentials: &Credentials,
    current: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let path = root.join(FILE);
    let directory = path.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The provider credential directory must be a plain directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, process::CommandExt};
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The provider credential directory cannot be redirected.".into());
        }
        // Give new atomically replaced files an owner-only inherited DACL, including runtime refreshes.
        let script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:OPENBOT_OAUTH_DIRECTORY -AclObject $acl";
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("OPENBOT_OAUTH_DIRECTORY", directory)
            // A PowerShell 7 parent passes its incompatible modules through Cargo/OpenBot.
            // Let Windows PowerShell rebuild its own default module search path.
            .env_remove("PSModulePath")
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "OpenBot could not make the provider sign-in private to your Windows account. {}",
                crate::quiet::said(&output.stderr)
            ));
        }
    }
    let _lock = credential_lock::acquire(&path)
        .map_err(|error| format!("Could not save provider sign-in: {error}"))?;
    current().and_then(|()| {
        serde_json::to_vec(credentials)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                crate::env::write_private_file(&path, &bytes).map_err(|e| e.to_string())
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xai_verification_url_rejects_unsafe_or_foreign_destinations() {
        for url in [
            "http://accounts.x.ai/oauth2/device",
            "https://accounts.x.ai.evil.example/oauth2/device",
            "https://evil.example/oauth2/device",
            "https://user@accounts.x.ai/oauth2/device",
            "https://user:password@accounts.x.ai/oauth2/device",
            "https://accounts.x.ai:444/oauth2/device",
            "javascript:alert(1)",
            "file:///tmp/signin",
            "mailto:signin@example.com",
            "/oauth2/device",
        ] {
            for field in ["verification_uri", "verification_uri_complete"] {
                let body = serde_json::json!({field: url});
                assert!(
                    xai_verification_url(&body).is_err(),
                    "accepted {field}: {url}"
                );
            }
        }
    }

    #[test]
    fn xai_verification_url_preserves_the_provider_code() {
        let plain = "https://accounts.x.ai/oauth2/device";
        let complete = "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH&referrer=openbot";
        assert_eq!(
            xai_verification_url(&serde_json::json!({"verification_uri": plain})).unwrap(),
            plain
        );
        assert_eq!(xai_verification_url(&serde_json::json!({"verification_uri": plain, "verification_uri_complete": complete})).unwrap(), complete);
        assert_eq!(
            xai_verification_url(&serde_json::json!({"verification_uri_complete": complete}))
                .unwrap(),
            complete
        );
    }

    #[test]
    fn callback_read_keeps_its_time_and_size_bounds() {
        for (payload, expected) in [
            (Vec::new(), std::io::ErrorKind::TimedOut),
            (vec![b'x'; 8192], std::io::ErrorKind::InvalidData),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let mut browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            browser.write_all(&payload).unwrap();
            let started = Instant::now();
            let error = read_callback_request(&mut stream, Duration::from_millis(100)).unwrap_err();
            if expected == std::io::ErrorKind::TimedOut {
                assert!(matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ));
                assert!(started.elapsed() >= Duration::from_millis(80));
            } else {
                assert_eq!(error.kind(), expected);
            }
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    fn callback_over_tcp(nonblocking: bool, fragmented: bool) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        browser
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "browser connection was not accepted"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("browser connection failed: {error}"),
            }
        };
        // Unix does not consistently inherit this flag; model the Windows accept behavior.
        if nonblocking {
            stream.set_nonblocking(true).unwrap();
        } else {
            stream.set_nonblocking(false).unwrap();
        }
        let request = b"GET /oauth/callback?state=expected&code=synthetic HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let split = if fragmented { 18 } else { 0 };
        if fragmented {
            browser.write_all(&request[..split]).unwrap();
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender
                .send(receive_callback(&mut stream, "expected"))
                .unwrap();
        });
        let early = receiver.recv_timeout(Duration::from_millis(100));
        if !matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
            worker.join().unwrap();
            panic!("callback completed before its request line arrived: {early:?}");
        }
        browser.write_all(&request[split..]).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            Some("synthetic".into())
        );
        let mut response = String::new();
        browser.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        worker.join().unwrap();
    }

    #[test]
    fn callback_waits_for_delayed_get_on_nonblocking_stream() {
        callback_over_tcp(true, false);
    }

    #[test]
    fn callback_waits_for_fragmented_request_line() {
        callback_over_tcp(false, true);
    }

    #[test]
    fn tokens_require_refresh_and_expiry() {
        let missing = serde_json::json!({"access_token":"synthetic", "expires_in":3600});
        assert!(
            credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &missing)
                .is_err()
        );
        let complete = serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh", "expires_in":3600});
        let saved =
            credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &complete)
                .unwrap();
        assert_eq!(saved.provider, "xai");
        assert!(saved.expires_at > 0);
        assert_ne!(saved.proxy_token, saved.access_token);
    }
    #[test]
    fn xai_tokens_accept_documented_missing_expiry() {
        let tokens =
            serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh"});
        assert!(
            credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens).is_ok()
        );
        assert!(credentials_from_tokens(
            "google",
            "client".into(),
            None,
            Some("project".into()),
            GOOGLE_SCOPE,
            &tokens
        )
        .is_err());
    }
    #[test]
    fn late_begin_cannot_cancel_newer_authorization() {
        let root = crate::test_support::temp_root("oauth-out-of-order");
        let delayed = reserve(&root);
        let newer = reserve(&root);
        assert!(check(&delayed).is_err());
        assert!(check(&newer).is_ok());
        cancel(&delayed.id);
        assert_eq!(active().lock().unwrap().as_ref().unwrap().id, newer.id);
        assert!(check(&newer).is_ok());
        cancel(&newer.id);
    }
    #[cfg(windows)]
    #[test]
    fn windows_oauth_persistence_ignores_incompatible_parent_powershell_modules() {
        let root = crate::test_support::temp_root("oauth-parent-modules");
        let module = root.join("Microsoft.PowerShell.Security");
        std::fs::create_dir_all(&module).unwrap();
        // A module with a newer engine requirement models the PS7 path inherited through Cargo.
        std::fs::write(
            module.join("Microsoft.PowerShell.Security.psd1"),
            "@{ModuleVersion='99.0';PowerShellVersion='99.0';CmdletsToExport=@('Set-Acl')}",
        )
        .unwrap();
        let output = crate::quiet::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider_oauth::tests::persisted_credentials_remain_provider_bound",
                "--nocapture",
            ])
            .env("PSModulePath", &root)
            .output()
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            crate::quiet::said(&output.stdout),
            crate::quiet::said(&output.stderr)
        );
    }
    #[test]
    fn persisted_credentials_remain_provider_bound() {
        let root = crate::test_support::temp_root("provider-oauth");
        let tokens = serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh", "expires_in":3600});
        let saved = credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens)
            .unwrap();
        write(&root, &saved, || Ok(())).unwrap();
        assert_eq!(read(&root, "xai").unwrap().session_id, saved.session_id);
        assert!(read(&root, "google").is_err());
        assert!(root.join(format!("{FILE}.lock/owner.lock")).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
    struct LockChild(std::process::Child);
    impl Drop for LockChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn credential_lock_child_process() {
        let Some(path) = std::env::var_os("OPENBOT_TEST_CREDENTIAL_LOCK_CHILD") else {
            return;
        };
        let _lock = credential_lock::acquire(Path::new(&path)).unwrap();
        println!("locked");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_line(&mut String::new()).unwrap();
    }

    fn lock_child_ready(child: &mut LockChild) -> std::sync::mpsc::Receiver<String> {
        use std::io::BufRead;
        let stdout = child.0.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = String::new();
            loop {
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = send.send("child exited without a lock".into());
                        return;
                    }
                    Ok(_) if line.trim() == "locked" => {
                        let _ = send.send("locked".into());
                        return;
                    }
                    Ok(_) => line.clear(),
                    Err(error) => {
                        let _ = send.send(error.to_string());
                        return;
                    }
                }
            }
        });
        receive
    }

    #[test]
    fn credential_lock_excludes_bun_in_both_directions_and_recovers_after_kill() {
        use std::process::Stdio;
        let root = crate::test_support::temp_root("provider-oauth-cross-writer");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("model-oauth.json");
        let native = credential_lock::acquire(&path).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../server/tests/fixtures/provider-oauth-lock-owner.ts");
        let bun = std::env::var_os("OPENBOT_TEST_BUN").unwrap_or_else(|| "bun".into());
        let mut child = LockChild(
            crate::quiet::command(bun)
                .args([fixture.as_os_str(), path.as_os_str()])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let ready = lock_child_ready(&mut child);
        assert!(matches!(
            ready.recv_timeout(Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        drop(native);
        assert_eq!(
            ready.recv_timeout(Duration::from_secs(15)).unwrap(),
            "locked"
        );
        let other_path = path.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            send.send(credential_lock::acquire(&other_path)).unwrap();
        });
        assert!(matches!(
            receive.recv_timeout(Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        drop(
            receive
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
        );
        waiter.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_lock_recovers_after_native_process_is_killed() {
        use std::process::Stdio;
        let root = crate::test_support::temp_root("provider-oauth-native-kill");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("model-oauth.json");
        let mut child = LockChild(
            crate::quiet::command(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_oauth::tests::credential_lock_child_process",
                    "--nocapture",
                ])
                .env("OPENBOT_TEST_CREDENTIAL_LOCK_CHILD", &path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let ready = lock_child_ready(&mut child);
        assert_eq!(
            ready.recv_timeout(Duration::from_secs(5)).unwrap(),
            "locked"
        );
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        drop(credential_lock::acquire(&path).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_replacement_waits_for_existing_rotation_owner() {
        let root = crate::test_support::temp_root("provider-oauth-replacement");
        let tokens = serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh", "expires_in":3600});
        let old = credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens)
            .unwrap();
        write(&root, &old, || Ok(())).unwrap();
        let lock = credential_lock::acquire(&root.join(FILE)).unwrap();
        let new = credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens)
            .unwrap();
        let newer_session = new.session_id.clone();
        let other_root = root.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let writer =
            std::thread::spawn(move || send.send(write(&other_root, &new, || Ok(()))).unwrap());
        assert!(matches!(
            receive.recv_timeout(Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(read(&root, "xai").unwrap().session_id, old.session_id);
        drop(lock);
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        writer.join().unwrap();
        assert_eq!(read(&root, "xai").unwrap().session_id, newer_session);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_save_recovers_abandoned_legacy_lock_directory() {
        let root = crate::test_support::temp_root("provider-oauth-orphan");
        std::fs::create_dir_all(root.join(format!("{FILE}.lock"))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join(format!("{FILE}.lock")),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let tokens = serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh", "expires_in":3600});
        let saved = credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens)
            .unwrap();
        let result = write(&root, &saved, || Ok(()));
        assert!(
            result.is_ok(),
            "abandoned directory blocked sign-in: {result:?}"
        );
        assert_eq!(read(&root, "xai").unwrap().session_id, saved.session_id);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canceled_sign_in_cannot_replace_current_credentials() {
        let root = crate::test_support::temp_root("provider-oauth-canceled");
        let tokens = serde_json::json!({"access_token":"synthetic", "refresh_token":"synthetic-refresh", "expires_in":3600});
        let saved = credentials_from_tokens("xai", "client".into(), None, None, XAI_SCOPE, &tokens)
            .unwrap();
        write(&root, &saved, || Ok(())).unwrap();
        let mut replacement = saved.clone();
        replacement.session_id = "canceled".into();
        assert!(write(&root, &replacement, || Err("canceled".into())).is_err());
        assert_eq!(read(&root, "xai").unwrap().session_id, saved.session_id);
        assert!(root.join(format!("{FILE}.lock/owner.lock")).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}
