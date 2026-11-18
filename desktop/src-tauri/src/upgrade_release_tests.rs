/*!
The upgrade a person's Desktop really runs, from a published release to this tree, against a real
container engine.

An installation is laid out from a real release, as Install lays it out: the release's own Compose
file from its source archive and its own image list from its GitHub release, every image pulled, and
started with the settings Start writes (`env::compose`), with its server answering. Something is
written through its API. Then this tree's release is laid over it by `upgrade::run`, the same code
Start runs: stop, `pg_dump`, set the previous version aside, lay out, pull, start. This tree's release
is laid out the way an internal build lays out the commit it was pinned to
(`deployment::fetch_pinned`): the commit's source archive from GitHub and an image list pinned by
digest. The upgrade must move, what the old release wrote must read back the same from the new one,
and the new server's migrations must each have run once.

Intelligence is a stand-in on this machine that answers the entitlement read and refuses the rest,
as an Intelligence refuses a request it cannot act on; the release's server reaches it at
`host.docker.internal`, as it reaches a local Intelligence.

```sh
OPENBOT_UPGRADE_FROM=v1.1.0 \
OPENBOT_UPGRADE_TO_COMMIT=<a commit GitHub serves> \
OPENBOT_UPGRADE_TO_IMAGES=<its container-images.json> \
cargo test --locked --lib upgrade::real_release -- --ignored --test-threads=1
```

It runs on Docker, on the default ports a fresh installation takes (`env::Ports::default`), in its
own Compose project, and removes its containers and volumes when it ends.
*/

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;

use super::*;
use crate::{engine, env as openbot_env, pull_metrics, stack};

const STAND_IN_KEY: &str = "ci-stand-in-key";
const INSTALL_TOKEN_HEADER: &str = "X-OpenBot-Install-Token";

fn required(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} must be set; see the module documentation"))
}

/// Intelligence as far as a server's start-up needs it: the entitlement read answered for the
/// stand-in key, and every other request refused as Intelligence refuses one it cannot act on (401
/// to a key it does not know, 400 to an empty request), never 404, which the server reads as a route
/// Intelligence lacks. Listening on every interface, so a container reaches it through the engine's
/// host gateway.
fn stand_in_intelligence() -> u16 {
    let listener = TcpListener::bind("0.0.0.0:0").expect("a port for the stand-in");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                let accepted = text.contains(&format!("authorization: bearer {STAND_IN_KEY}"));
                let (status, body) = match (path.split('?').next(), accepted) {
                    (Some("/api/entitlements/runtime"), true) => (
                        "200 OK",
                        r#"{"status":"ready","entitlement":{"active":true}}"#,
                    ),
                    (Some("/api/entitlements/runtime"), false) => {
                        ("401 Unauthorized", "unauthorized")
                    }
                    (_, true) => (
                        "400 Bad Request",
                        r#"{"error":{"code":"VALIDATION_ERROR"}}"#,
                    ),
                    (_, false) => (
                        "401 Unauthorized",
                        r#"{"error":{"code":"AUTH_UNAUTHENTICATED"}}"#,
                    ),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    port
}

/// Which release a `lay_out` puts down: a published one by its tag, or this tree by its pin.
enum Target {
    Release(String),
    Pinned(deployment::Pin),
}

struct Installation {
    root: PathBuf,
    project: String,
    address: engine::Address,
    intelligence: u16,
    target: Target,
    ran: Vec<&'static str>,
}

impl Installation {
    fn new(intelligence: u16) -> Self {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let project = format!("openbot-upgrade-release-{unique}");
        let root = std::env::temp_dir().join(&project);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(stack::PROJECT_FILE),
            serde_json::json!({ "project": project }).to_string(),
        )
        .unwrap();
        let address = engine::Address::new(engine::Engine::Docker, None)
            .pin()
            .expect("Docker answers");
        Self {
            root,
            project,
            address,
            intelligence,
            target: Target::Release(String::new()),
            ran: Vec::new(),
        }
    }

    /// The settings Start writes for what is laid out now (`env::compose`), keeping what an earlier
    /// start of this installation minted, as Start does: its encryption key and install token above
    /// all, without which the new release could read nothing the old one wrote.
    fn settings(&self) -> Result<stack::Secrets, Problem> {
        let env_file = self.root.join(".env");
        let kept = openbot_env::read_already_set(&env_file, &openbot_env::MINTED[..])
            .map_err(|error| Problem::from(error.to_string()))?;
        let images = deployment::image_variables(&self.root).map_err(Problem::from)?;
        let mut settings = openbot_env::compose(
            &openbot_env::Intelligence {
                api_url: format!("http://127.0.0.1:{}", self.intelligence),
                gateway_ws_url: format!("ws://127.0.0.1:{}", self.intelligence),
                api_key: STAND_IN_KEY.into(),
            },
            &openbot_env::Model {
                credential: openbot_env::ModelCredential::None,
            },
            &self.address.status(),
            &openbot_env::Ports::default(),
            &images,
            None,
            &kept,
        );
        settings.insert(
            "COMPUTER_NETWORK".into(),
            format!("{}_default", self.project),
        );
        // As Start runs it on Linux with Docker: the server as the folder's owner.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            let owner = std::fs::metadata(&self.root).unwrap();
            settings.insert(
                "OPENBOT_SERVER_USER".into(),
                format!("{}:{}", owner.uid(), owner.gid()),
            );
        }
        settings.extend(openbot_env::Ports::default().settings());
        openbot_env::write(&env_file, &settings, &BTreeMap::new())
            .map_err(|error| Problem::from(error.to_string()))?;
        Ok(settings)
    }

    fn down(&self) -> Result<(), Problem> {
        stack::down(&self.address, &self.root).map_err(Problem::from)
    }

    fn compose(&self, args: &[&str]) -> String {
        let output = self
            .address
            .command()
            .current_dir(&self.root)
            .args(["compose", "-p", &self.project])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn sql(&self, query: &str) -> String {
        self.compose(&[
            "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot", "-tAc", query,
        ])
    }

    fn install_token(&self) -> String {
        openbot_env::read_already_set(&self.root.join(".env"), &[crate::install_token::NAME])
            .unwrap()
            .remove(crate::install_token::NAME)
            .expect("Start minted an install token")
    }

    /// The person's own preferences, through the API, as the window's pages call it.
    fn api(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> serde_json::Value {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap();
        let ports = openbot_env::Ports::default();
        let mut request = client
            .request(method, format!("http://127.0.0.1:{}{path}", ports.server))
            .header(INSTALL_TOKEN_HEADER, self.install_token());
        if let Some(body) = body {
            request = request
                .header("Idempotency-Key", format!("upgrade-{}", std::process::id()))
                .json(&body);
        }
        let response = request.send().expect("the server answers");
        let status = response.status();
        let text = response.text().unwrap_or_default();
        assert!(status.is_success(), "{path} answered {status}: {text}");
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
    }

    fn server_log(&self) -> String {
        stack::service_log(&self.address, &self.root, "server", 80)
    }
}

impl Drop for Installation {
    fn drop(&mut self) {
        let _ = self
            .address
            .command()
            .current_dir(&self.root)
            .args([
                "compose",
                "-p",
                &self.project,
                "--profile",
                "openbot",
                "down",
                "--volumes",
                "--remove-orphans",
            ])
            .output();
        let label = format!("label=com.docker.compose.project={}", self.project);
        for (list, remove) in [
            (
                ["ps", "--all", "--quiet"].as_slice(),
                ["rm", "--force"].as_slice(),
            ),
            (
                ["volume", "ls", "--quiet"].as_slice(),
                ["volume", "rm", "--force"].as_slice(),
            ),
            (
                ["network", "ls", "--quiet"].as_slice(),
                ["network", "rm"].as_slice(),
            ),
        ] {
            let mut listing = list.to_vec();
            listing.extend(["--filter", label.as_str()]);
            let listed = self.address.command().args(&listing).output();
            if let Ok(listed) = listed {
                for id in String::from_utf8_lossy(&listed.stdout).split_whitespace() {
                    let mut removing = remove.to_vec();
                    removing.push(id);
                    let _ = self.address.command().args(&removing).output();
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Each step as the window's (`DesktopSteps` in main.rs) runs it, through the same functions.
impl Steps for Installation {
    fn stop(&mut self) -> Result<(), Problem> {
        self.ran.push("stop");
        self.down()
    }

    fn has_database(&mut self) -> Result<bool, Problem> {
        let settings = self.settings()?;
        stack::postgres_volume_exists(&self.address, &self.root, &settings)
    }

    fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
        self.ran.push("back_up");
        let settings = self.settings()?;
        let backed_up = stack::backup_runtime_database(&self.address, &self.root, &settings, to);
        self.down()?;
        backed_up.map_err(Problem::from)
    }

    fn lay_out(&mut self) -> Result<(), Problem> {
        self.ran.push("lay_out");
        match &self.target {
            Target::Release(version) => deployment::fetch(&self.root, version),
            Target::Pinned(pin) => deployment::fetch_pinned(&self.root, pin),
        }
        .map_err(Problem::from)
    }

    fn install(&mut self) -> Result<(), Problem> {
        self.ran.push("install");
        let settings = self.settings()?;
        let mut images = stack::installation_images(&self.address, &self.root, false, &settings)?;
        images.sort();
        images.dedup();
        for image in images {
            pull_metrics::pull_image(&self.address, &image, |_| {}, |_| {})?;
        }
        Ok(())
    }

    fn start(&mut self) -> Result<(), Problem> {
        self.ran.push("start");
        let settings = self.settings()?;
        stack::make_sign_in_folder(&self.root)?;
        stack::up(&self.address, &self.root, false, &settings)?;
        let ports = openbot_env::Ports::default();
        stack::wait_until_healthy(
            &stack::Ready {
                api: ports.server,
                app: ports.app,
            },
            std::time::Duration::from_secs(300),
            || true,
        )
        .map_err(|error| Problem::with(error, self.server_log()))
    }

    fn restore(&mut self, from: &Path) -> Result<(), Problem> {
        self.ran.push("restore");
        let settings = self.settings()?;
        let restored = stack::start_runtime_database(&self.address, &self.root, &settings)
            .and_then(|()| {
                stack::restore_runtime_database(&self.address, &self.root, &settings, from)
            });
        self.down()?;
        restored.map_err(Problem::from)
    }
}

#[test]
#[ignore = "lays out a published release and this tree's commit from GitHub, pulls their images and runs them on Docker"]
fn an_installation_on_a_release_upgrades_to_this_tree_with_its_data_and_each_migration_once() {
    let from = required("OPENBOT_UPGRADE_FROM");
    let commit = required("OPENBOT_UPGRADE_TO_COMMIT");
    let images: &'static str = Box::leak(
        std::fs::read_to_string(required("OPENBOT_UPGRADE_TO_IMAGES"))
            .expect("the image list for this tree")
            .into_boxed_str(),
    );
    let pin = deployment::pin_from(images, &commit).expect("a readable image list");

    let mut installation = Installation::new(stand_in_intelligence());

    // The release, laid out, installed and started as a first Install and Start leave it.
    installation.target = Target::Release(from.clone());
    installation.lay_out().expect("the release lays out");
    installation.install().expect("the release's images pull");
    if let Err(problem) = installation.start() {
        panic!(
            "{from} did not start: {}\n{}",
            problem.said,
            detail(&problem)
        );
    }
    assert_eq!(
        deployment::installed(&installation.root).unwrap().version,
        from
    );

    // Something the person set, written by the old release.
    let preferences = "/api/v2/organizations/default/people/me/preferences";
    installation.api(
        reqwest::Method::PATCH,
        preferences,
        Some(serde_json::json!({ "skin": "opendots" })),
    );
    assert_eq!(
        installation.api(reqwest::Method::GET, preferences, None)["skin"],
        "opendots",
        "{from} kept the preference it was given"
    );
    let applied_before: u64 = installation
        .sql("select count(*) from drizzle.__drizzle_migrations")
        .parse()
        .unwrap();

    // This tree's release over it, by Start's own upgrade.
    installation.target = Target::Pinned(pin.clone());
    installation.ran.clear();
    let ran = run(&installation.root.clone(), &mut installation);
    match ran {
        Ran::Moved => {}
        other => panic!(
            "the upgrade from {from} to {} did not move: {other:?}\n--- server log ---\n{}",
            pin.version,
            installation.server_log()
        ),
    }
    assert_eq!(
        installation.ran,
        ["stop", "back_up", "lay_out", "install", "start"]
    );
    assert_eq!(
        deployment::installed(&installation.root).unwrap().version,
        pin.version
    );
    assert!(!interrupted(&installation.root));

    // What the old release wrote, read back from the new one.
    assert_eq!(
        installation.api(reqwest::Method::GET, preferences, None)["skin"],
        "opendots",
        "the preference {from} wrote survived the upgrade"
    );

    // Each migration once: none twice, and none of the old release's lost.
    let counted = installation
        .sql("select count(*) || ' ' || count(distinct hash) from drizzle.__drizzle_migrations");
    let (applied, distinct) = counted.split_once(' ').unwrap();
    let applied: u64 = applied.parse().unwrap();
    assert_eq!(applied.to_string(), distinct, "a migration ran twice");
    assert!(
        applied >= applied_before,
        "{applied} migrations recorded after the upgrade, {applied_before} before"
    );
    println!(
        "{from} -> {} ({commit}): moved; {applied_before} migrations before, {applied} after, each once",
        pin.version
    );
}
