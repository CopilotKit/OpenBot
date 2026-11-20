// Included by main.rs, so these regressions run the window's own `run_local_eval` command.
#[cfg(unix)]
mod local_eval_ipc {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    const STACK: &str = "local-abc123";
    /// The release the stack runs, and the one its update did not finish moving to.
    const INSTALLED: &str = "0.16.0-rc.5";
    const ATTEMPTED: &str = "0.16.0-rc.9";
    /// The organization the minted licence and the stack's project share. Synthetic.
    const ORGANIZATION: &str = "org_local_evaluation";
    /// The ports the window's answers are compared at. The servers listen on whatever is free.
    const FIXED: [(&str, u16); 3] = [("api", 18082), ("dashboard", 18080), ("gateway", 14401)];

    /**
    The CLI this app pins in `desktop/intelligence-cli.json`, exactly as published, unpacked once
    per checkout into the build folder. `npm pack` fetches the same tarball `cli-bundle.ts` puts in
    the installer.
    */
    fn pinned_cli() -> PathBuf {
        let choice: serde_json::Value =
            serde_json::from_str(include_str!("../../intelligence-cli.json")).unwrap();
        let cli = choice["cli"].as_str().unwrap();
        let spec = if cli.starts_with("https://") {
            cli.to_owned()
        } else {
            format!("copilotkit@{cli}")
        };
        let name: String = cli
            .rsplit(['@', '/'])
            .next()
            .unwrap()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            .collect();
        let build = std::env::current_exe().unwrap();
        let cache = build.parent().unwrap().parent().unwrap().join("intelligence-cli").join(name);
        let entry = cache.join("package").join("index.js");
        if entry.is_file() {
            return entry;
        }
        // Each test process downloads into its own folder: two tests fetching the same pin at once
        // must not delete each other's tarball. The first to finish keeps its copy.
        let download = cache.with_extension(format!("download-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&download);
        std::fs::create_dir_all(&download).unwrap();
        let packed = std::process::Command::new("npm")
            .args(["pack", &spec, "--json", "--pack-destination"])
            .arg(&download)
            .output()
            .expect("npm should run to fetch the pinned CLI");
        assert!(
            packed.status.success(),
            "npm pack {spec} failed:\n{}",
            String::from_utf8_lossy(&packed.stderr)
        );
        let listing: serde_json::Value = serde_json::from_slice(&packed.stdout).unwrap();
        let tarball = download.join(listing[0]["filename"].as_str().unwrap());
        let unpacked = std::process::Command::new("tar")
            .arg("-xzf")
            .arg(&tarball)
            .arg("-C")
            .arg(&download)
            .status()
            .unwrap();
        assert!(unpacked.success(), "the pinned CLI did not unpack");
        // A complete copy is never removed: the rename fails over a folder another process filled.
        // One left without its entry by an interrupted run is.
        if !entry.is_file() {
            let _ = std::fs::remove_dir_all(&cache);
        }
        let moved = std::fs::rename(&download, &cache);
        let _ = std::fs::remove_dir_all(&download);
        assert!(entry.is_file(), "the pinned CLI was not kept: {moved:?}");
        entry
    }

    /// `name` on this process's PATH, before the test replaces PATH.
    fn on_path(name: &str) -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
            .unwrap_or_else(|| panic!("{name} should be on PATH to run the pinned CLI"))
    }

    fn sha256(path: &Path) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(std::fs::read(path).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /**
    One loopback HTTP server, answering each request's path with a status and a JSON or text body.
    The CLI asks the back end's health and the engine's API this way.
    */
    fn serve(answer: impl Fn(&str) -> (&'static str, String) + Send + 'static) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream);
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let (status, body) = answer(&path);
                let _ = write!(
                    reader.get_mut(),
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    /// A release manifest in the shape `local-release.ts` validates, with synthetic digests.
    fn release(version: &str, schema: &str, compatible_from: &str) -> serde_json::Value {
        let image = |name: &str| {
            serde_json::json!({
                "repository": format!("ghcr.io/copilotkit/intelligence/{}", name.to_lowercase()),
                "digest": format!("sha256:{}", "b".repeat(64)),
            })
        };
        let images: serde_json::Map<String, serde_json::Value> = [
            "appApi",
            "appFrontend",
            "realtimeGateway",
            "migrations",
            "bootstrap",
            "postgresql",
            "redis",
            "objectStorage",
            "objectStorageInit",
            "k3s",
            "k3dProxy",
            "k3dTools",
        ]
        .into_iter()
        .map(|name| (name.to_owned(), image(name)))
        .collect();
        let tool = |name: &str, version: &str| {
            serde_json::json!({
                "version": version,
                "url": format!("https://github.com/example/{name}/releases/{version}"),
                "sha256": "c".repeat(64),
            })
        };
        serde_json::json!({
            "schemaVersion": 1,
            "version": version,
            "cliVersion": "4.34.0",
            "chart": {
                "reference": "oci://ghcr.io/copilotkit/charts/intelligence",
                "version": version,
                "sha256": "a".repeat(64),
            },
            "schema": { "version": schema, "compatibleFrom": [compatible_from] },
            "images": images,
            "kubernetesImages": [{
                "repository": "docker.io/rancher/mirrored-pause",
                "digest": format!("sha256:{}", "d".repeat(64)),
                "reference": "docker.io/rancher/mirrored-pause:3.6",
            }],
            "platforms": [{
                "os": "darwin",
                "arch": "arm64",
                "tools": { "k3d": tool("k3d", "5.8.3"), "helm": tool("helm", "3.18.4") },
            }],
        })
    }

    /// A licence for local evaluation signed with a key made for this test, and the key's public
    /// half for the CLI to trust (`BAKED_LICENSE_KEYS_JSON`, the CLI's own harness seam).
    fn minted_licence(node: &Path) -> (String, String) {
        let script = format!(
            r#"
const {{ generateKeyPairSync, sign }} = require("node:crypto");
const signing = generateKeyPairSync("ed25519");
const kid = "test-local-update";
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const body = part({{ alg: "EdDSA", typ: "LIC", kid }}) + "." + part({{
  version: 1, license_id: "lic-local-update", key_id: kid, telemetry_id: "test",
  owner: {{ org_id: "{ORGANIZATION}", org_name: "Test organization", contact_email: "test@example.com" }},
  issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2099-12-31T00:00:00.000Z",
  tier: "free", seat_limit: 0, features: {{}}, remove_branding: false, purpose: "local_evaluation",
}});
const token = body + "." + sign(null, Buffer.from(body), signing.privateKey).toString("base64url");
const key = signing.publicKey.export({{ type: "spki", format: "der" }}).toString("base64");
process.stdout.write(JSON.stringify({{ token, keys: JSON.stringify({{ [kid]: key }}) }}));
"#
        );
        let output = std::process::Command::new(node)
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let minted: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        (
            minted["token"].as_str().unwrap().to_owned(),
            minted["keys"].as_str().unwrap().to_owned(),
        )
    }

    /// `run_local_eval` for `status`, and the JSON the window receives: Tauri serializes the
    /// command's answer with serde, as here.
    fn status_answer(root: &Path) -> serde_json::Value {
        let stack = local_eval::StackId::parse(STACK).unwrap();
        local_eval_answer(root, "local-update-status", local_eval::Action::Status, &stack)
            .map(|report| serde_json::to_value(report).unwrap())
            .unwrap_or_else(|failure| panic!("status failed: {failure:?}"))
    }

    /**
    AN UPDATE THAT DID NOT FINISH LEAVES THE BACK END READY ON THE RELEASE IT HAD.

    Found on OpenBot Desktop 0.3.3 on a slow connection. Start began updating the back end from
    0.16.0-rc.5 to 0.16.0-rc.9. The CLI stopped downloading one image at its own ten-minute limit
    and recorded `failedStep: "image-download"` with the update still `prepared`. Nothing in the
    cluster changed and every check passed, but `local status` says `degraded` while that record
    stays. The window said "The back end is running but not healthy." and stopped OpenBot.

    The real CLI this app pins answers `local status` here, over a record for exactly that case,
    against health and engine endpoints served on 127.0.0.1 (a stand-in `docker` lists the pods).
    The window's `run_local_eval` answer for each case is compared with
    `test-fixtures/local-eval/update-did-not-finish.json`, which the window's own tests start
    OpenBot from (`App.test.tsx`). So the window is tested against what the CLI really says:
    - every check passing, the update on record and still due, so the next Start resumes it;
    - the API failing its check, which stays not healthy;
    - the stack stopped by Quit, with the update on record and due.
    */
    #[test]
    fn the_cli_reports_an_update_that_did_not_finish_and_the_window_is_told_so() {
        if crate::test_support::isolated_process(
            "tests::local_eval_ipc::the_cli_reports_an_update_that_did_not_finish_and_the_window_is_told_so",
        ) {
            return;
        }
        let entry = pinned_cli();
        let node = on_path("node");
        let root = crate::test_support::temp_root("local-update-did-not-finish");
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("installation")).unwrap();

        let api_healthy = Arc::new(AtomicBool::new(true));
        let node_running = Arc::new(AtomicBool::new(true));
        let healthy = api_healthy.clone();
        let api = serve(move |path| match path {
            "/api/health" if healthy.load(Ordering::SeqCst) => ("200 OK", r#"{"status":"ok"}"#.into()),
            "/api/health" => ("503 Service Unavailable", r#"{"status":"unavailable"}"#.into()),
            _ => ("404 Not Found", "{}".into()),
        });
        let gateway = serve(|path| match path {
            "/health/ready" => ("200 OK", r#"{"status":"ready"}"#.into()),
            _ => ("404 Not Found", "{}".into()),
        });
        let dashboard = serve(|_| ("200 OK", "<!doctype html><title>Intelligence</title>".into()));
        // The engine API, in Docker Desktop's (or on Linux, Docker Engine's) shape.
        let running = node_running.clone();
        let engine_api = serve(move |path| {
            let desktop = cfg!(target_os = "macos");
            match path {
                "/_ping" => ("200 OK", "OK".into()),
                "/info" => ("200 OK", serde_json::json!({
                    "NCPU": 8,
                    "OperatingSystem": if desktop { "Docker Desktop" } else { "Ubuntu 24.04 LTS" },
                    "OSType": "linux",
                    "SecurityOptions": ["name=seccomp,profile=builtin"],
                }).to_string()),
                "/version" => ("200 OK", serde_json::json!({
                    "Platform": { "Name": if desktop { "Docker Desktop 4.71.0 (210000)" } else { "Docker Engine - Community" } },
                    "Os": "linux",
                    "Components": [{ "Name": "Engine" }],
                }).to_string()),
                path if path == format!("/containers/k3d-{STACK}-server-0/json") => ("200 OK", serde_json::json!({
                    "Id": "a".repeat(64),
                    "Config": { "Labels": { "copilotkit.local-stack": STACK } },
                    "State": { "Running": running.load(Ordering::SeqCst), "StartedAt": "2026-11-07T09:00:00.000000000Z" },
                }).to_string()),
                _ => ("404 Not Found", r#"{"message":"page not found"}"#.into()),
            }
        });

        // `docker exec <node> kubectl get pods -o json`, the one engine command `status` runs: the
        // pods of 0.16.0-rc.5, every one running and ready.
        let items: Vec<serde_json::Value> = [
            "cpki-app-api-6d9f7c8b5-x2k4p",
            "cpki-app-frontend-7c8d9f6b4-m8q2r",
            "cpki-realtime-gateway-5b7c9d8f6-t4n7w",
            "cpki-postgresql-0",
            "cpki-redis-subchart-master-0",
            "cpki-local-object-storage-0",
        ]
        .into_iter()
        .map(|name| {
            serde_json::json!({
                "metadata": { "name": name },
                "status": { "phase": "Running", "containerStatuses": [{ "ready": true }] },
            })
        })
        .collect();
        let pods = serde_json::json!({ "items": items });
        std::fs::write(root.join("pods.json"), pods.to_string()).unwrap();
        let docker = bin.join("docker");
        std::fs::write(
            &docker,
            format!(
                "#!/bin/sh\nif [ \"$*\" = \"exec k3d-{STACK}-server-0 kubectl get pods -o json\" ]; then cat '{}'; exit 0; fi\necho \"docker $* is not part of local status\" >&2\nexit 1\n",
                root.join("pods.json").display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The CLI's own record, as `local update` left it: still on rc.5, its update to rc.9
        // `prepared`, stopped at the image download.
        let configuration = if cfg!(target_os = "macos") {
            home.join("Library/Preferences/copilotkit-config-nodejs")
        } else {
            home.join(".config/copilotkit-config-nodejs")
        };
        let record = serde_json::json!({
            "id": STACK,
            "appPaths": [root.join("installation")],
            "release": release(INSTALLED, "41", "40"),
            "ports": { "api": api, "dashboard": dashboard, "gateway": gateway, "kubernetes": 46443 },
            "step": "cluster",
            "failedStep": "image-download",
            "project": { "organizationId": ORGANIZATION, "projectId": "1", "projectSlug": "local-app" },
            "update": { "attemptedRelease": release(ATTEMPTED, "42", "41"), "state": "prepared" },
        });
        let stack_folder = configuration.join("local-evaluation").join(STACK);
        std::fs::create_dir_all(&stack_folder).unwrap();
        std::fs::write(
            configuration.join("config.json"),
            serde_json::json!({ "localStacks": { STACK: record } }).to_string(),
        )
        .unwrap();
        let (token, keys) = minted_licence(&node);
        std::fs::write(
            stack_folder.join("setup.json"),
            serde_json::json!({ "licenseToken": token }).to_string(),
        )
        .unwrap();

        // The runtime the window pins, with the test's licence key: the CLI inherits only a fixed
        // list of variables, and this is not one of them.
        let program = root.join("node");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\nBAKED_LICENSE_KEYS_JSON='{keys}'\nexport BAKED_LICENSE_KEYS_JSON\nexec '{}' \"$@\"\n",
                node.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", sha256(&program));
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY", &entry);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY_SHA256", sha256(&entry));
        // The release this app's CLI installs.
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_INTELLIGENCE", ATTEMPTED);
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
        std::env::set_var(
            "PATH",
            std::env::join_paths(
                std::iter::once(bin.clone()).chain(std::env::split_paths(
                    &std::env::var_os("PATH").unwrap_or_default(),
                )),
            )
            .unwrap(),
        );
        std::env::set_var("DOCKER_HOST", format!("tcp://127.0.0.1:{engine_api}"));
        std::env::remove_var("DOCKER_CONTEXT");
        std::env::set_var("DO_NOT_TRACK", "1");
        std::env::set_var("COPILOTKIT_TELEMETRY_DISABLED", "1");
        local_eval::use_engine(&engine::Address::new(engine::Engine::Docker, None));

        let ports = [("api", api), ("dashboard", dashboard), ("gateway", gateway)];
        let answer = |label: &str| {
            let mut answer = status_answer(&root.join("installation"));
            // The servers' ports, pinned so the answer reads the same on every run.
            for ((field, port), (_, fixed)) in ports.iter().zip(FIXED) {
                let url = &mut answer["stack"]["urls"][field];
                let said = url.as_str().unwrap().to_owned();
                assert!(said.ends_with(&format!(":{port}")), "{label}: {field} is {said}");
                *url = serde_json::json!(said.replace(&format!(":{port}"), &format!(":{fixed}")));
            }
            answer
        };

        let mut answers = serde_json::Map::new();
        answers.insert("updateDidNotFinish".into(), answer("update did not finish"));
        api_healthy.store(false, Ordering::SeqCst);
        answers.insert("apiCheckFails".into(), answer("API check fails"));
        api_healthy.store(true, Ordering::SeqCst);
        node_running.store(false, Ordering::SeqCst);
        answers.insert("stoppedByQuit".into(), answer("stopped by Quit"));

        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../test-fixtures/local-eval/update-did-not-finish.json"
        ))
        .unwrap();
        let actual = serde_json::Value::Object(answers);
        assert_eq!(
            actual,
            expected,
            "the window's answers changed:\n{}",
            serde_json::to_string_pretty(&actual).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    CONNECTING THE SAME FOLDER AGAIN AFTER OPENBOT TOOK UP ITS CONNECTION.

    `local connect` writes the stack's addresses at `localhost`. OpenBot then writes them at
    `127.0.0.1` (`numeric_loopback`) and moves the key to the credential store. Connecting the same
    folder again, which setup Retry, Back and forward through setup, and a reinstall over an
    existing install all do, got "App settings changed after connection was planned" from the CLI
    pinned at f5c45eb, every time, and the person could not get past setup.

    The real CLI this app pins, through the window's own `connect_local_eval`, over a ready stack
    recorded for the installation (connect only changes files, so no engine is needed): it connects,
    Start writes the `.env` its own way, it connects again, and Start still finds the key and the
    stack's own addresses. An address changed to another port is still refused.
    */
    #[test]
    fn connecting_again_after_openbot_took_up_the_connection_succeeds() {
        if crate::test_support::isolated_process(
            "tests::local_eval_ipc::connecting_again_after_openbot_took_up_the_connection_succeeds",
        ) {
            return;
        }
        const READY: &str = "local-0123456789abcdef01234567";
        let entry = pinned_cli();
        let node = on_path("node");
        let root = crate::test_support::temp_root("local-eval-connect-again");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let installation = home.join("OpenBot");
        std::fs::create_dir_all(installation.join(".copilotkit")).unwrap();
        std::fs::write(installation.join(".env"), "SERVER_PORT=3001\n").unwrap();

        // The CLI's own record of a ready stack for the installation, as `local setup` leaves it,
        // with its private files (synthetic) and the installation's reference to it.
        let configuration = if cfg!(target_os = "macos") {
            home.join("Library/Preferences/copilotkit-config-nodejs")
        } else {
            home.join(".config/copilotkit-config-nodejs")
        };
        let record = serde_json::json!({
            "id": READY,
            "appPaths": [installation],
            "release": release("0.16.0-rc.10", "42", "41"),
            "ports": { "api": 51796, "dashboard": 51798, "gateway": 51797, "kubernetes": 46443 },
            "step": "ready",
            "project": { "organizationId": ORGANIZATION, "projectId": "42", "projectSlug": "local-app" },
        });
        let stack_folder = configuration.join("local-evaluation").join(READY);
        std::fs::create_dir_all(&stack_folder).unwrap();
        std::fs::write(
            configuration.join("config.json"),
            serde_json::json!({ "localStacks": { READY: record } }).to_string(),
        )
        .unwrap();
        std::fs::write(
            stack_folder.join("setup.json"),
            r#"{"licenseToken":"synthetic"}"#,
        )
        .unwrap();
        let mut secrets: serde_json::Map<String, serde_json::Value> = [
            "database",
            "databaseAdmin",
            "redis",
            "oidcClient",
            "session",
            "serviceToken",
            "learningToken",
            "objectAccess",
            "objectSecret",
            "gatewayRunner",
            "gatewaySession",
            "beamCookie",
            "channelEncryption",
        ]
        .into_iter()
        .map(|name| (name.to_owned(), serde_json::json!("e".repeat(64))))
        .collect();
        secrets.insert(
            "apiKey".into(),
            serde_json::json!(format!("cpk-local_1111111111111111_{}", "e".repeat(64))),
        );
        std::fs::write(
            stack_folder.join("secrets.json"),
            serde_json::Value::Object(secrets).to_string(),
        )
        .unwrap();
        std::fs::write(
            installation.join(".copilotkit/local.json"),
            serde_json::json!({ "stackId": READY, "appPath": installation }).to_string(),
        )
        .unwrap();
        local_eval_state::begin(
            &installation,
            &local_eval::StackId::parse(READY).unwrap(),
            local_eval_state::Ownership::Created,
            LOCAL_EVAL_PIN,
        )
        .unwrap();
        // The runtime key `local connect` writes for project 42 from that stack key.
        let key = format!("cpk-42_1111111111111111_{}", "e".repeat(64));

        let program = root.join("node");
        std::fs::write(
            &program,
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", node.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", sha256(&program));
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY", &entry);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY_SHA256", sha256(&entry));
        std::env::remove_var("OPENBOT_DEV_LOCAL_EVAL_INTELLIGENCE");
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
        std::env::set_var("DO_NOT_TRACK", "1");
        std::env::set_var("COPILOTKIT_TELEMETRY_DISABLED", "1");

        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                crate::test_support::temp_root("local-eval-connect-again-telemetry"),
                false,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let env_file = installation.join(".env");
        let connect = |label: &str| {
            tauri::async_runtime::block_on(connect_local_eval(
                app.handle().clone(),
                format!("local-eval-connect-again-{label}"),
                installation.display().to_string(),
            ))
            .unwrap_or_else(|error| panic!("{label}: {error:?}"))
        };
        // What Start takes: the key from the credential store, and the stack's own addresses at
        // 127.0.0.1, each once, with no key and no `localhost` left in the file.
        let start_takes_the_connection = |label: &str| {
            let env = std::fs::read_to_string(&env_file).unwrap();
            for line in [
                "INTELLIGENCE_API_URL=http://127.0.0.1:51796",
                "INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:51797",
                "SERVER_PORT=3001",
            ] {
                assert_eq!(
                    env.lines().filter(|found| *found == line).count(),
                    1,
                    "{label}: {line}\n{env}"
                );
            }
            assert!(!env.contains("localhost"), "{label}:\n{env}");
            assert!(!env.contains("CPK_INTELLIGENCE_API_KEY"), "{label}:\n{env}");
            assert!(local_eval_state::read(&installation, None).unwrap().connected);
            let kept = intelligence_key_for_start(&installation, |root, name| {
                Ok(openbot_desktop_lib::vault::recall(root, name)?.unwrap_or_default())
            })
            .unwrap_or_else(|problem| panic!("{label}: {problem:?}"));
            assert_eq!(kept, key, "{label}");
        };

        let connection = connect("first");
        assert_eq!(
            connection.outcome,
            local_eval::Outcome::Completed,
            "{connection:?}"
        );
        start_takes_the_connection("first");

        // Start writes the file its own way: the addresses as settings, the key purged.
        let (settings, purged) = openbot_desktop_lib::vault::split(
            [
                ("INTELLIGENCE_API_URL", "http://127.0.0.1:51796"),
                ("INTELLIGENCE_GATEWAY_WS_URL", "ws://127.0.0.1:51797"),
                ("INTELLIGENCE_API_KEY", key.as_str()),
                ("SERVER_PORT", "3001"),
            ]
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        );
        openbot_env::write(&env_file, &settings, &purged).unwrap();

        // Retry, Back and forward, or a reinstall: the same folder connected again.
        for label in ["again", "and again"] {
            let connection = connect(label);
            assert_eq!(
                connection.outcome,
                local_eval::Outcome::Completed,
                "{label}: {connection:?}"
            );
            assert!(!connection.conflicted, "{label}: {connection:?}");
            start_takes_the_connection(label);
        }

        // Another port is a change somebody made, not the connection: still refused, file kept.
        let changed = std::fs::read_to_string(&env_file)
            .unwrap()
            .replace("http://127.0.0.1:51796", "http://127.0.0.1:9999");
        std::fs::write(&env_file, &changed).unwrap();
        let connection = connect("changed");
        assert_eq!(
            connection.outcome,
            local_eval::Outcome::Failed,
            "{connection:?}"
        );
        assert_eq!(std::fs::read_to_string(&env_file).unwrap(), changed);
        std::fs::remove_dir_all(root).unwrap();
    }
}
