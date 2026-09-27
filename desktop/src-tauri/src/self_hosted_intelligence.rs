//! Own the temporary browser helper across sign-in and project selection.
use crate::{
    intelligence::{Project, ProvisionedConnection},
    problem::Problem,
};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

const PATIENCE: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event {
    Projects {
        projects: Vec<Project>,
    },
    Connection {
        #[serde(rename = "apiKey")]
        api_key: String,
        #[serde(rename = "apiUrl")]
        api_url: String,
        #[serde(rename = "learningContainerId")]
        learning_container_id: String,
    },
    Error {
        message: String,
    },
}

pub struct SigningIn {
    pub root: PathBuf,
    api_url: String,
    child: Mutex<Option<Child>>,
    events: Mutex<mpsc::Receiver<Result<Event, Problem>>>,
    projects: Mutex<Vec<String>>,
    cancelled: AtomicBool,
    deadline: Instant,
}

fn stopped() -> Problem {
    Problem::plain("That Intelligence sign-in ended or was cancelled. Sign in again.")
}
fn protocol_error() -> Problem {
    Problem::plain("Intelligence sign-in returned an unexpected response. Sign in again.")
}

pub fn normalize_api_url(value: &str) -> Result<String, Problem> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| Problem::plain("Enter a valid Intelligence API URL."))?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host == "[::1]"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Problem::plain(
            "Use an HTTPS Intelligence API origin without a path, or HTTP on localhost.",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

impl SigningIn {
    pub fn begin(root: &Path, bun: &Path, api_url: &str) -> Result<Arc<Self>, Problem> {
        let api_url = normalize_api_url(api_url)?;
        let mut command = crate::quiet::command(bun);
        command
            .current_dir(root)
            .arg(root.join("scripts/self-hosted-learning.ts"))
            .args(["--desktop", "--api-url", &api_url]);
        Self::spawn(command, root, api_url, PATIENCE)
    }

    fn spawn(
        mut command: Command,
        root: &Path,
        api_url: String,
        patience: Duration,
    ) -> Result<Arc<Self>, Problem> {
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|_| Problem::plain("The Intelligence sign-in helper could not start. Finish installing OpenBot and try again."))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (sender, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let event = line
                    .ok()
                    .and_then(|line| serde_json::from_str::<Event>(&line).ok())
                    .ok_or_else(protocol_error);
                let failed = event.is_err();
                if sender.send(event).is_err() || failed {
                    break;
                }
            }
        });
        let signing = Arc::new(Self {
            root: root.to_path_buf(),
            api_url,
            child: Mutex::new(Some(child)),
            events: Mutex::new(events),
            projects: Mutex::new(Vec::new()),
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + patience,
        });
        let weak = Arc::downgrade(&signing);
        std::thread::spawn(move || loop {
            let Some(signing) = weak.upgrade() else { break };
            if signing.child.lock().unwrap().is_none() {
                break;
            }
            if Instant::now() >= signing.deadline {
                signing.cancel();
                break;
            }
            drop(signing);
            std::thread::sleep(Duration::from_millis(100));
        });
        Ok(signing)
    }

    fn next(&self) -> Result<Event, Problem> {
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(stopped());
            }
            if Instant::now() >= self.deadline {
                return Err(Problem::plain(
                    "Intelligence sign-in timed out. Sign in again.",
                ));
            }
            match self
                .events
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_millis(100))
            {
                Ok(Ok(Event::Error { message })) => return Err(Problem::plain(message)),
                Ok(event) => return event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(stopped()),
            }
        }
    }

    pub fn projects(&self) -> Result<Vec<Project>, Problem> {
        let Event::Projects { projects } = self.next()? else {
            return Err(protocol_error());
        };
        if projects
            .iter()
            .any(|p| p.id.is_empty() || p.name.is_empty())
        {
            return Err(protocol_error());
        }
        *self.projects.lock().unwrap() = projects.iter().map(|p| p.id.clone()).collect();
        Ok(projects)
    }

    pub fn connect(&self, project: &str) -> Result<ProvisionedConnection, Problem> {
        if !self.projects.lock().unwrap().iter().any(|id| id == project) {
            return Err(Problem::plain(
                "Choose a project from this Intelligence sign-in.",
            ));
        }
        {
            let mut slot = self.child.lock().unwrap();
            let stdin = slot
                .as_mut()
                .and_then(|child| child.stdin.as_mut())
                .ok_or_else(stopped)?;
            writeln!(stdin, "{}", serde_json::json!({"projectId": project}))
                .and_then(|_| stdin.flush())
                .map_err(|_| stopped())?;
        }
        let Event::Connection {
            api_key,
            api_url,
            learning_container_id,
        } = self.next()?
        else {
            return Err(protocol_error());
        };
        if api_key.trim().is_empty()
            || normalize_api_url(&api_url)? != self.api_url
            || learning_container_id != "openbot"
        {
            return Err(protocol_error());
        }
        // The helper closes its browser before exiting. Do not publish a connection before that.
        loop {
            if self.cancelled.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
                return Err(stopped());
            }
            let mut slot = self.child.lock().unwrap();
            let child = slot.as_mut().ok_or_else(stopped)?;
            if let Some(status) = child.try_wait().map_err(|_| stopped())? {
                slot.take();
                if !status.success() {
                    return Err(stopped());
                }
                break;
            }
            drop(slot);
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(ProvisionedConnection {
            api_key,
            api_url: self.api_url.clone(),
            learning_container_id,
        })
    }

    /// The stdin cancellation protocol also works on Windows, where killing a child cannot run
    /// its signal handlers. Closing stdin is a second request to retire the owned browser.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{}", serde_json::json!({"type": "cancel"}));
            let _ = stdin.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                _ if Instant::now() >= deadline => break,
                _ => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
impl Drop for SigningIn {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn fixture(mode: &str, patience: Duration) -> Arc<SigningIn> {
        static BINARY: OnceLock<PathBuf> = OnceLock::new();
        let binary = BINARY.get_or_init(|| {
            let root = crate::test_support::temp_root("self-hosted-sign-in");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("helper.rs");
            let binary = root.join(format!("helper{}", std::env::consts::EXE_SUFFIX));
            std::fs::write(&source, r##"
                use std::io::{self, BufRead, Write};
                fn main() {
                    let mode = std::env::args().nth(1).unwrap();
                    if mode == "malformed" { println!("secret-invalid-json"); return; }
                    if mode == "error" { println!("{}", r#"{"type":"error","message":"Sign-in was refused."}"#); return; }
                    if mode != "pending" { println!("{}", r#"{"type":"projects","projects":[{"id":"7","name":"Team"}]}"#); io::stdout().flush().unwrap(); }
                    for line in io::stdin().lock().lines() {
                        let line = line.unwrap();
                        if line.contains("cancel") { return; }
                        if mode == "mismatch" { println!("{}", r#"{"type":"connection","apiKey":"test-key","apiUrl":"https://other.test","learningContainerId":"openbot"}"#); }
                        else { println!("{}", r#"{"type":"connection","apiKey":"test-key","apiUrl":"https://intelligence.test/","learningContainerId":"openbot"}"#); }
                        return;
                    }
                }
            "##).unwrap();
            crate::test_support::compile_fixture(&source, &binary);
            binary
        });
        let mut command = Command::new(binary);
        command.arg(mode);
        SigningIn::spawn(
            command,
            Path::new("installation"),
            "https://intelligence.test".into(),
            patience,
        )
        .unwrap()
    }

    #[test]
    fn helper_project_selection_produces_matching_connection_after_exit() {
        let signing = fixture("success", PATIENCE);
        assert_eq!(
            signing.projects().unwrap(),
            vec![Project {
                id: "7".into(),
                name: "Team".into()
            }]
        );
        assert!(signing.connect("not-listed").is_err());
        let proof = signing.connect("7").unwrap();
        assert_eq!(proof.api_key, "test-key");
        assert_eq!(proof.api_url, "https://intelligence.test");
        assert_eq!(proof.learning_container_id, "openbot");
        assert!(signing.child.lock().unwrap().is_none());
    }
    #[test]
    fn mismatched_connection_and_malformed_output_are_not_published() {
        let signing = fixture("mismatch", PATIENCE);
        signing.projects().unwrap();
        assert!(signing.connect("7").is_err());
        let malformed = fixture("malformed", PATIENCE);
        let problem = malformed.projects().unwrap_err();
        assert!(!problem.said.contains("secret"));
        assert!(problem.detail.is_none());
        assert_eq!(
            fixture("error", PATIENCE).projects().unwrap_err().said,
            "Sign-in was refused."
        );
    }
    #[test]
    fn cancellation_closes_helper_during_login_and_project_selection() {
        for mode in ["pending", "success"] {
            let signing = fixture(mode, PATIENCE);
            if mode == "success" {
                signing.projects().unwrap();
            }
            signing.cancel();
            assert!(signing.child.lock().unwrap().is_none());
            assert!(signing.projects().is_err());
        }
    }
    #[test]
    fn abandoned_project_picker_times_out_and_reaps_helper() {
        let signing = fixture("success", Duration::from_secs(2));
        signing.projects().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !signing.cancelled.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(signing.cancelled.load(Ordering::SeqCst));
        assert!(signing.connect("7").is_err());
    }
    #[test]
    fn api_addresses_require_secure_remote_origins() {
        assert_eq!(
            normalize_api_url("https://intelligence.test/").unwrap(),
            "https://intelligence.test"
        );
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(normalize_api_url(url).is_ok());
        }
        for url in [
            "http://remote.test",
            "https://intelligence.test/base/",
            "https://user:password@remote.test",
            "https://remote.test?key=secret",
            "file:///tmp/test",
        ] {
            assert!(normalize_api_url(url).is_err());
        }
    }
    /// Run explicitly against an isolated Intelligence project; the operator completes SSO in
    /// the helper's temporary browser. Never print the runtime credential.
    #[test]
    #[ignore = "requires an isolated Intelligence server and interactive browser SSO"]
    fn live_self_hosted_browser_connection() {
        let root =
            PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_ROOT").expect("test root"));
        let bun = PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_BUN").expect("owned Bun"));
        let api = std::env::var("OPENBOT_LIVE_SELF_HOSTED_API_URL").expect("test API");
        let project = std::env::var("OPENBOT_LIVE_SELF_HOSTED_PROJECT_ID").expect("test project");
        let signing = SigningIn::begin(&root, &bun, &api).unwrap();
        let projects = signing.projects().unwrap();
        assert!(projects.iter().any(|candidate| candidate.id == project));
        println!("self-hosted project discovered: {project}");
        let connection = signing.connect(&project).unwrap();
        assert!(!connection.api_key.is_empty());
        assert_eq!(connection.api_url, normalize_api_url(&api).unwrap());
        assert_eq!(connection.learning_container_id, "openbot");
        println!("self-hosted connection provisioned; browser helper exited");
    }
    /// Observe only descendants of this helper, never the user's browsers or another sign-in.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "launches a real temporary Chrome/Edge browser against an isolated API"]
    fn live_self_hosted_browser_cancellation() {
        fn processes() -> Vec<(u32, u32, String)> {
            let output = Command::new("/bin/ps")
                .args(["-axo", "pid=,ppid=,comm="])
                .output()
                .expect("inspect child process ownership");
            assert!(output.status.success());
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .filter_map(|line| {
                    let mut columns = line.split_whitespace();
                    let pid = columns.next()?.parse().ok()?;
                    let parent = columns.next()?.parse().ok()?;
                    Some((pid, parent, columns.collect::<Vec<_>>().join(" ")))
                })
                .collect()
        }
        fn descendants(processes: &[(u32, u32, String)], parent: u32) -> Vec<u32> {
            let mut owned = vec![parent];
            loop {
                let previous = owned.len();
                for (pid, parent, _) in processes {
                    if owned.contains(parent) && !owned.contains(pid) {
                        owned.push(*pid);
                    }
                }
                if owned.len() == previous {
                    return owned;
                }
            }
        }
        let root =
            PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_ROOT").expect("test root"));
        let bun = PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_BUN").expect("owned Bun"));
        let api = std::env::var("OPENBOT_LIVE_SELF_HOSTED_API_URL").expect("test API");
        let signing = SigningIn::begin(&root, &bun, &api).unwrap();
        let helper = signing.child.lock().unwrap().as_ref().unwrap().id();
        let deadline = Instant::now() + Duration::from_secs(30);
        let observed = loop {
            let snapshot = processes();
            let owned = descendants(&snapshot, helper);
            let browser = snapshot.iter().any(|(pid, _, name)| {
                owned.contains(pid)
                    && (name.ends_with("Google Chrome") || name.ends_with("Microsoft Edge"))
            });
            let renderer = snapshot
                .iter()
                .any(|(pid, _, name)| owned.contains(pid) && name.contains("Renderer"));
            if browser && renderer {
                break owned;
            }
            assert!(
                Instant::now() < deadline,
                "owned browser and renderer did not start"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        println!("owned browser and renderer started; cancelling native sign-in");
        signing.cancel();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = processes().iter().any(|(pid, _, _)| observed.contains(pid));
            if !remaining {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned helper or browser descendant survived cancellation"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(signing.projects().is_err());
        println!("native cancellation reaped helper and all observed browser descendants");
    }
}
