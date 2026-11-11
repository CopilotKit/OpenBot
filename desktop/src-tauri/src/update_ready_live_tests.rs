/*!
Getting a release ready against real engines: OpenBot's images into Docker, the back end's into a
real k3s node, from a real registry behind a proxy that logs every request (`local_images::live`'s
lab). The release being got ready is published to that registry as a newer OpenBot server and a
newer back end API, beside the ones the "running" version uses.

Run with `cargo test --lib update_ready::live -- --ignored --test-threads=1` where Docker runs
privileged containers.
*/

use std::process::Command;

use super::*;
use crate::engine::Engine;
use crate::local_images::live::{test_limits, Lab};

fn docker(args: &[&str]) -> (bool, String) {
    let output = Command::new("docker")
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("docker should run");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

const NGINX: &str = "docker.io/library/nginx:1.31.6-alpine";
const API: &str = "127.0.0.1:5000/copilotkit/intelligence/app-api";

/**
The lab's proxy as the engine itself reaches it. Docker pulls from a registry on its own loopback
over plain HTTP, and on Docker Desktop that loopback is the VM's, where a port published from a
container does not answer. So an nginx on the engine's host network passes `127.0.0.1:<port>` to the
proxy, and the engine's pulls go through the proxy's log like the node's.
*/
struct Door {
    name: String,
    port: u16,
}

impl Door {
    fn to(lab: &Lab) -> Self {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let name = format!("{}-door", lab.stack);
        let conf = format!(
            "events {{}}\nhttp {{\n  server {{\n    listen 127.0.0.1:{port};\n    client_max_body_size 0;\n    location / {{\n      proxy_pass http://{}:5000;\n      proxy_set_header Host $http_host;\n      proxy_buffering off;\n    }}\n  }}\n}}\n",
            lab.bridge_address()
        );
        let conf_env = format!("CONF={conf}");
        assert!(
            docker(&[
                "run",
                "-d",
                "--name",
                &name,
                "--network",
                "host",
                "-e",
                &conf_env,
                NGINX,
                "sh",
                "-c",
                "printf '%s' \"$CONF\" > /etc/nginx/nginx.conf && exec nginx -g 'daemon off;'",
            ])
            .0
        );
        let door = Self { name, port };
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let ping = format!("http://127.0.0.1:{port}/v2/");
        while !docker(&["exec", &door.name, "wget", "-q", "-O-", &ping]).0 {
            assert!(std::time::Instant::now() < until, "the door did not open");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        door
    }

    /// `reference`, as `Lab::push` names it for the node, named for the engine.
    fn named(&self, reference: &str) -> String {
        reference.replacen("127.0.0.1:5000/", &format!("127.0.0.1:{}/", self.port), 1)
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        let _ = docker(&["rm", "-f", &self.name]);
    }
}

/// An installation on one release, running, with the next release published.
struct Installation {
    lab: Lab,
    _door: Door,
    engine: Address,
    version: Version,
    list: Announced,
    /// What its last install pulled into the engine.
    installed: Vec<String>,
    /// What the CLI it runs pulls into the node.
    current: CliImages,
    /// The next release's OpenBot server, and a Bot this installation does not run.
    server_next: String,
    other_bot: String,
    /// A container standing in for the OpenBot that runs, which nothing may stop or restart.
    running: String,
}

impl Installation {
    fn new(rate: &str) -> Self {
        let lab = Lab::new(rate);
        let door = Door::to(&lab);
        let engine = Address::new(Engine::Docker, None);
        let server_now = door.named(&lab.push("copilotkit/openbot-server", "now", &[300_000]));
        let server_next =
            door.named(&lab.push("copilotkit/openbot-server", "next", &[400_000, 200_000]));
        let other_bot =
            door.named(&lab.push("copilotkit/openbot-agent-mastra", "next", &[250_000]));
        lab.push("copilotkit/intelligence/app-api", "1.0.0", &[200_000]);
        lab.push("copilotkit/intelligence/app-api", "1.1.0", &[350_000]);
        // Installed and running: OpenBot's server image in the engine, the back end's in the node.
        crate::pull_metrics::pull_image(&engine, &server_now, |_| {}, |_| {}).unwrap();
        let current = CliImages {
            release: "1.0.0".into(),
            fixed: Vec::new(),
            tagged: vec![API.into()],
        };
        assert_eq!(
            local_images::download(&lab.node(), &current, test_limits(), &|| false, &mut |_| {}),
            Ok(local_images::Done::Downloaded)
        );
        let running = format!("{}-openbot", lab.stack);
        assert!(docker(&["run", "-d", "--name", &running, NGINX]).0);
        let list = Announced {
            openbot: "v9.9.2".into(),
            intelligence: "1.1.0".into(),
            images: vec![
                server_next.clone(),
                other_bot.clone(),
                format!("{API}:1.1.0"),
            ],
        };
        Self {
            lab,
            _door: door,
            engine,
            version: Version::parse("9.9.2").unwrap(),
            list,
            installed: vec![server_now],
            current,
            server_next,
            other_bot,
            running,
        }
    }

    /// Get the release ready with the engine's disk as `disk` says it is.
    fn get_ready(
        &self,
        disk: &dyn Fn() -> Option<Disk>,
        stop: &dyn Fn() -> bool,
        seen: &mut Vec<(u64, u64)>,
    ) -> Outcome {
        let node = self.lab.node();
        let ahead = Ahead {
            version: &self.version,
            list: &self.list,
            engine: &self.engine,
            installed: &self.installed,
            back_end: Some((&node, &self.current)),
            disk,
            computer_free: &|| computer_free(&self.engine),
            limits: test_limits(),
        };
        get_ready(&ahead, stop, &mut |done, total| seen.push((done, total)))
    }

    /// The engine's disk as `local_eval::engine_disk` measures it, `df -Pk /` in a container, in
    /// one whose image has a shell: the lab's own images have none.
    fn measured(&self) -> Option<Disk> {
        let (ok, out) = docker(&[
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--entrypoint",
            "/bin/sh",
            NGINX,
            "-c",
            "df -Pk /",
        ]);
        ok.then(|| crate::local_eval::parse_disk(&out)).flatten()
    }

    fn present(&self, image: &str) -> bool {
        crate::preparation::image_present(&self.engine, image).unwrap()
    }

    /// The back end's next API in the node, by the digest its tag names.
    fn api_next(&self) -> Option<String> {
        let tag = format!("{API}:1.1.0");
        let index = docker(&[
            "exec",
            &self.lab.node,
            "ctr",
            "content",
            "fetch-object",
            "--hosts-dir",
            "/var/lib/rancher/k3s/agent/etc/containerd/certs.d",
            &tag,
        ]);
        assert!(index.0, "the registry serves {tag}");
        use sha2::Digest as _;
        let digest = format!("sha256:{:x}", sha2::Sha256::digest(index.1.as_bytes()));
        Some(format!("{API}@{digest}")).filter(|named| self.lab.images().contains(named))
    }

    /// When the stand-in OpenBot and the back end's node last started, and whether both run.
    fn started(&self) -> Vec<String> {
        [&self.running, &self.lab.node]
            .iter()
            .map(|name| {
                docker(&[
                    "inspect",
                    "--format",
                    "{{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}",
                    name,
                ])
                .1
                .trim()
                .to_owned()
            })
            .collect()
    }

    /// Requests for a blob the proxy answered, after the first `from`.
    fn blobs_fetched(&self, from: usize) -> Vec<String> {
        self.lab
            .requests()
            .into_iter()
            .skip(from)
            .filter(|line| line.starts_with("GET ") && line.contains("/blobs/"))
            .collect()
    }
}

impl Drop for Installation {
    fn drop(&mut self) {
        let _ = docker(&["rm", "-f", &self.running]);
        for image in [&self.installed[0], &self.server_next, &self.other_bot] {
            let _ = docker(&["image", "rm", "-f", image]);
        }
    }
}

/**
The feed names a release, and while the version that runs stays up, the release's images arrive:
OpenBot's server in the engine and the back end's API in its node, pinned there for the update. Only
what this installation runs: not the Bot it never picked. Nothing that runs is stopped or restarted,
and the image it runs is still there. A Start or the Update click first stops it before anything.
*/
#[test]
#[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
fn an_announced_release_downloads_while_the_running_version_stays_up() {
    let installation = Installation::new("4m");
    let before = installation.started();
    assert!(
        before.iter().all(|line| line.starts_with("true ")),
        "{before:?}"
    );

    // Something the person started needs the engine: nothing downloads.
    let mut seen = Vec::new();
    assert_eq!(
        installation.get_ready(&|| installation.measured(), &|| true, &mut seen),
        Outcome::Stopped
    );
    assert!(!installation.present(&installation.server_next));

    let mut seen = Vec::new();
    assert_eq!(
        installation.get_ready(&|| installation.measured(), &|| false, &mut seen),
        Outcome::Ready
    );
    assert!(installation.present(&installation.server_next));
    let api_next = installation
        .api_next()
        .expect("the back end's next API is in the node");
    assert!(
        !installation.present(&installation.other_bot),
        "a Bot this installation does not run is not downloaded"
    );
    // Kept for the update: the kubelet does not remove a pinned image.
    let labels = docker(&[
        "exec",
        &installation.lab.node,
        "ctr",
        "images",
        "ls",
        &format!("name=={api_next}"),
    ])
    .1;
    assert!(
        labels.contains("io.cri-containerd.pinned=pinned")
            && labels.contains("ai.copilotkit.openbot.ready-for=9.9.2"),
        "{labels}"
    );
    let cri = docker(&[
        "exec",
        &installation.lab.node,
        "crictl",
        "inspecti",
        &api_next,
    ])
    .1;
    assert!(cri.contains("\"pinned\": true"), "{cri}");
    // The version that runs: the same containers, never restarted, and its own images kept.
    assert_eq!(installation.started(), before);
    assert!(installation.present(&installation.installed[0]));
    assert!(installation
        .lab
        .images()
        .iter()
        .any(|image| image.starts_with(&format!("{API}@")) && image != &api_next));
    // Said as it went, ending with every byte.
    let (done, total) = *seen.last().unwrap();
    assert!(total > 0 && done == total, "{seen:?}");

    // A newer release replacing it takes the pin off: nothing will run this one.
    let mut newer = installation.list.clone();
    newer.openbot = "v9.9.3".into();
    let node = installation.lab.node();
    assert_eq!(
        local_images::unpin_ready_for_other(&node, Some("9.9.3"), test_limits()),
        1
    );
    let cri = docker(&[
        "exec",
        &installation.lab.node,
        "crictl",
        "inspecti",
        &api_next,
    ])
    .1;
    assert!(cri.contains("\"pinned\": false"), "{cri}");
}

/**
After the release was got ready, the update's own pulls download nothing: the upgrade's pull of
OpenBot's image (`pull_metrics::pull_image`, as `upgrade` makes it), OpenBot's download before
`local update`, and the CLI's own `ctr images pull` into the node. Not one blob is fetched.
*/
#[test]
#[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
fn the_update_afterwards_downloads_no_image() {
    let installation = Installation::new("4m");
    let mut seen = Vec::new();
    assert_eq!(
        installation.get_ready(&|| installation.measured(), &|| false, &mut seen),
        Outcome::Ready
    );
    let from = installation.lab.requests().len();

    // The upgrade pulls the new release's images into the engine.
    crate::pull_metrics::pull_image(
        &installation.engine,
        &installation.server_next,
        |_| {},
        |_| {},
    )
    .unwrap();
    // The new app's `local update` downloads the back end's first, then the CLI pulls each.
    let next = back_end_images(&installation.current, &installation.list).unwrap();
    assert_eq!(
        local_images::download(
            &installation.lab.node(),
            &next,
            test_limits(),
            &|| false,
            &mut |_| {}
        ),
        Ok(local_images::Done::NothingToDo)
    );
    let api_next = installation.api_next().unwrap();
    assert!(
        docker(&[
            "exec",
            &installation.lab.node,
            "ctr",
            "images",
            "pull",
            &api_next,
        ])
        .0
    );

    assert_eq!(installation.blobs_fetched(from), Vec::<String>::new());
}

/**
A disk without room downloads nothing at all and says why: the engine would fall under the line
where the kubelet removes images. The update downloads them, as it always did.
*/
#[test]
#[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
fn a_disk_short_of_room_downloads_nothing() {
    let installation = Installation::new("4m");
    let from = installation.lab.requests().len();
    // Exactly at the kubelet's line: any download falls under it.
    let at_the_line = || {
        Some(Disk {
            size: 100_000_000_000,
            free: 15_000_000_000,
        })
    };
    let mut seen = Vec::new();
    let outcome = installation.get_ready(&at_the_line, &|| false, &mut seen);
    let Outcome::Skipped(why) = outcome else {
        panic!("{outcome:?}");
    };
    assert!(
        why.contains("15.0 GB free of 100.0 GB") && why.contains("keeps 15% free"),
        "{why}"
    );
    assert!(!installation.present(&installation.server_next));
    assert_eq!(installation.api_next(), None);
    assert_eq!(installation.blobs_fetched(from), Vec::<String>::new());
    assert!(seen.is_empty(), "{seen:?}");

    // An engine whose disk cannot be measured is not guessed at either.
    let outcome = installation.get_ready(&|| None, &|| false, &mut seen);
    assert!(matches!(outcome, Outcome::Skipped(_)), "{outcome:?}");
    assert!(!installation.present(&installation.server_next));
}
