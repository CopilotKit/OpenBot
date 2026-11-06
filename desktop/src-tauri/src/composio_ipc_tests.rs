// Included by main.rs, so these regressions run its registered commands and its Start environment.
mod composio_ipc {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    /// The broker settings a developer's own shell could carry into a test.
    const BROKER_ENVIRONMENT: [&str; 4] = [
        "COMPOSIO_API_KEY",
        "ARCADE_API_KEY",
        "OPENBOT_BROKER_PROVIDER",
        "OPENBOT_INSTALLATION_ID",
    ];

    /// The project key the fake Ops makes. Synthetic: no real key is ever used here.
    const PROJECT_KEY: &str = "synthetic-project-key";
    /// The CopilotKit session the fake CLI's sign-in left in its own store.
    const SESSION: &str = "synthetic-cli-session";

    /// What the fake Ops was sent: the request line and headers, and the body.
    type Received = Arc<StdMutex<Vec<(String, Vec<u8>)>>>;

    /**
    CopilotKit Ops, for `POST /api/cli/integrations/composio/project`, as
    `docs/contracts/openbot-composio-provisioning.md` in Intelligence describes it.

    In: a CLI session bearer and exactly `{"installationId": "<UUID>"}`. Out, on `200`:
    `installationId` (the one asked for), `projectId`, `apiKey` and `reused`, with
    `Cache-Control: private, no-store`. A second request for the same installation replays the same
    key with `reused: true`. A `status` other than `200 OK` answers with the Ops error envelope.
    */
    fn fake_ops(status: &'static str) -> (String, Received) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let received: Received = Arc::default();
        let log = received.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, Read, Write};
            let mut made: Vec<String> = Vec::new();
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    head.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().ok())?
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                log.lock().unwrap().push((head, body.clone()));
                let answer = if status == "200 OK" {
                    let asked: serde_json::Value =
                        serde_json::from_slice(&body).unwrap_or_default();
                    let id = asked["installationId"].as_str().unwrap_or_default().to_owned();
                    let reused = made.contains(&id);
                    made.push(id.clone());
                    serde_json::json!({
                        "installationId": id,
                        "projectId": "pr_fixture",
                        "apiKey": PROJECT_KEY,
                        "reused": reused,
                    })
                } else {
                    serde_json::json!({
                        "error": { "code": "COMPOSIO_PROVISIONING_UNAVAILABLE", "message": "synthetic-private-ops-error" }
                    })
                }
                .to_string();
                let _ = write!(
                    reader.get_mut(),
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: private, no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
            }
        });
        (origin, received)
    }

    /**
    A stand-in for `copilotkit integrations composio provision`, as Intelligence's
    `apps/cli/src/commands/integrations.ts` behaves.

    It takes exactly `--installation-id <UUID> --env-path <absolute path> --json`, reads the session
    `copilotkit login` saved (`session` beside it, standing in for the CLI's own store), posts the
    installation id to Ops (`ops` beside it), checks the answer is for that installation, writes
    `COMPOSIO_API_KEY=<key>` into the env file, owner-only, and prints only metadata. Without a
    session, or on an Ops error, it says why on stderr and exits 1, and writes nothing.
    */
    const FAKE_CLI: &str = r#"
use std::io::{Read, Write};
fn field<'a>(json: &'a str, name: &str) -> Option<&'a str> {
    let start = json.find(&format!("\"{name}\":"))? + name.len() + 3;
    let rest = json[start..].trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        return quoted.split('"').next();
    }
    rest.split(|c| c == ',' || c == '}').next().map(str::trim)
}
fn main() {
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--warm") {
        return;
    }
    std::fs::write(dir.join("argv"), args.join("\n")).unwrap();
    let shape = args.len() == 8
        && args[..3] == ["integrations", "composio", "provision"]
        && args[3] == "--installation-id"
        && args[5] == "--env-path"
        && args[7] == "--json";
    if !shape {
        eprintln!("Usage: copilotkit integrations composio provision --installation-id <UUID> --env-path <absolute path> --json");
        std::process::exit(1);
    }
    let (id, env_path) = (&args[4], std::path::PathBuf::from(&args[6]));
    if !env_path.is_absolute() || !env_path.parent().map_or(false, |parent| parent.is_dir()) {
        eprintln!("--env-path must be an absolute path to an env file in an existing directory.");
        std::process::exit(1);
    }
    let Ok(session) = std::fs::read_to_string(dir.join("session")) else {
        eprintln!("Sign in with `copilotkit login --json`, then retry with the same --installation-id.");
        std::process::exit(1);
    };
    let origin = std::fs::read_to_string(dir.join("ops")).unwrap();
    let address = origin.trim().trim_start_matches("http://").to_owned();
    let body = format!("{{\"installationId\":\"{id}\"}}");
    let mut stream = std::net::TcpStream::connect(&address).unwrap();
    write!(
        stream,
        "POST /api/cli/integrations/composio/project HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        session.trim(),
        body.len()
    )
    .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let (head, json) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
    if !head.starts_with("HTTP/1.1 200") {
        eprintln!("Composio provisioning could not finish. No credential was printed.");
        std::process::exit(1);
    }
    if field(json, "installationId") != Some(id.as_str()) {
        eprintln!("Composio provisioning could not finish. No credential was printed.");
        std::process::exit(1);
    }
    let key = field(json, "apiKey").unwrap();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&env_path).unwrap();
    writeln!(file, "COMPOSIO_API_KEY={key}").unwrap();
    println!(
        "{{\"type\":\"completed\",\"installation_id\":\"{id}\",\"project_id\":\"{}\",\"environment_file_written\":true,\"reused\":{}}}",
        field(json, "projectId").unwrap(),
        field(json, "reused").unwrap()
    );
}
"#;

    /// The fake CLI, compiled once per process, beside its `session` and `ops`.
    struct FakeCli {
        dir: PathBuf,
    }

    impl FakeCli {
        /// Pinned as this debug build's developer CLI, exactly as `local_eval::installed` checks
        /// one: by path and SHA-256. Only for a test in its own process.
        fn pinned(label: &str, ops: &str, signed_in: bool) -> Self {
            let dir = crate::test_support::temp_root(label);
            std::fs::create_dir_all(&dir).unwrap();
            let source = dir.join("cli.rs");
            std::fs::write(&source, FAKE_CLI).unwrap();
            let program = dir.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &program);
            assert!(std::process::Command::new(&program)
                .arg("--warm")
                .status()
                .unwrap()
                .success());
            std::fs::write(dir.join("ops"), ops).unwrap();
            if signed_in {
                std::fs::write(dir.join("session"), SESSION).unwrap();
            }
            use sha2::Digest;
            let digest: String = sha2::Sha256::digest(std::fs::read(&program).unwrap())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
            std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", digest);
            Self { dir }
        }

        fn argv(&self) -> Option<String> {
            std::fs::read_to_string(self.dir.join("argv")).ok()
        }
    }

    /// An installation a 0.3.0 first run left: local Intelligence recorded, no Composio key
    /// anywhere, and no installation identity yet.
    fn signed_in_installation(label: &str) -> PathBuf {
        for name in BROKER_ENVIRONMENT {
            std::env::remove_var(name);
        }
        let root = crate::test_support::temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".env"), "COMPOSIO_API_KEY=\nOPENBOT_ORIGIN=http://127.0.0.1:3010\n")
            .unwrap();
        local_eval_state::begin(
            &root,
            &local_eval::StackId::parse("local-abc123").unwrap(),
            local_eval_state::Ownership::Created,
            &"a".repeat(64),
        )
        .unwrap();
        root
    }

    fn start_environment(root: &Path) -> stack::Secrets {
        let (_, secrets) = persist_start_environment(
            root,
            std::collections::BTreeMap::new(),
            &openbot_env::ModelCredential::None,
        )
        .unwrap();
        secrets
    }

    fn installation_id(root: &Path) -> String {
        std::fs::read_to_string(root.join(".env.openbot-installation-id"))
            .unwrap()
            .trim()
            .trim_start_matches("OPENBOT_INSTALLATION_ID=")
            .to_owned()
    }

    /**
    SIGNING IN TO COPILOTKIT GIVES OPENBOT ITS APPS AT START.

    0.3.0 replaced the app's own CopilotKit sign-in with the CLI's and dropped the step that asked
    Ops for this installation's Composio project. Nothing else asked, so every desktop install ran
    with `COMPOSIO_API_KEY` empty and apps unavailable. An installation signed in under 0.3.0 has
    the CLI's session and no key: its next Start gets the key from Ops through the CLI, keeps it in
    the protected store and never in `.env`, and hands it to the server.
    */
    #[test]
    fn a_copilotkit_sign_in_gives_start_a_composio_key() {
        if crate::test_support::isolated_process(
            "tests::composio_ipc::a_copilotkit_sign_in_gives_start_a_composio_key",
        ) {
            return;
        }
        let (ops, received) = fake_ops("200 OK");
        let cli = FakeCli::pinned("composio-start-cli", &ops, true);
        let root = signed_in_installation("composio-start");

        let secrets = start_environment(&root);

        assert_eq!(
            secrets.get("COMPOSIO_API_KEY").map(String::as_str),
            Some(PROJECT_KEY),
            "Start must hand the server the key the CopilotKit sign-in provisions"
        );
        let id = installation_id(&root);
        assert_eq!(
            cli.argv().unwrap(),
            format!(
                "integrations\ncomposio\nprovision\n--installation-id\n{id}\n--env-path\n{}\n--json",
                root.join(".openbot-apps").join("composio.env").display()
            )
        );
        let sent = received.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        let (head, body) = &sent[0];
        assert!(head.starts_with("POST /api/cli/integrations/composio/project HTTP/1.1\r\n"));
        assert!(head.contains(&format!("Authorization: Bearer {SESSION}\r\n")));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body).unwrap(),
            serde_json::json!({ "installationId": id })
        );
        // Kept in the protected store, under its own name. Never in `.env`, and nothing left in
        // the folder the CLI wrote it to.
        assert_eq!(
            openbot_desktop_lib::vault::recall(&root, "COMPOSIO_PROVISIONED_API_KEY").unwrap(),
            Some(PROJECT_KEY.to_owned())
        );
        assert!(!std::fs::read_to_string(root.join(".env"))
            .unwrap()
            .contains(PROJECT_KEY));
        assert!(!root.join(".openbot-apps").exists());

        // The next Start uses the kept key and asks nobody.
        let again = start_environment(&root);
        assert_eq!(
            again.get("COMPOSIO_API_KEY").map(String::as_str),
            Some(PROJECT_KEY)
        );
        assert_eq!(received.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn ipc(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|response| response.deserialize::<serde_json::Value>().unwrap())
    }

    fn window() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![connect_copilotkit_apps])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, window)
    }

    /**
    THE SIGN-IN STEP CONNECTS APPS, AND CONNECT APPS TRIES AGAIN.

    The window calls `connect_copilotkit_apps` once the person is signed in. Signed out, it fails
    with the sentence the window shows beside Connect apps, keeps nothing and leaves no handoff.
    After signing in, Connect apps gets the key; another call asks nobody. Nothing secret crosses.
    */
    #[test]
    fn connect_apps_after_sign_in_keeps_the_key_and_a_retry_works() {
        if crate::test_support::isolated_process(
            "tests::composio_ipc::connect_apps_after_sign_in_keeps_the_key_and_a_retry_works",
        ) {
            return;
        }
        let (ops, received) = fake_ops("200 OK");
        let cli = FakeCli::pinned("composio-ipc-cli", &ops, false);
        let root = signed_in_installation("composio-ipc");
        let (_app, window) = window();
        let body = serde_json::json!({ "attempt": "apps-ipc-1", "root": root });

        let error = ipc(&window, "connect_copilotkit_apps", body.clone())
            .expect_err("signed out, there is no key to get");
        assert_eq!(
            error["said"],
            "OpenBot couldn't connect your apps. Check your connection, then choose Connect apps. If it keeps happening, ask an admin."
        );
        assert!(!error.to_string().contains("copilotkit login"));
        assert!(received.lock().unwrap().is_empty());
        assert!(!root.join(".openbot-apps").exists());
        assert_eq!(
            openbot_desktop_lib::vault::recall(&root, "COMPOSIO_PROVISIONED_API_KEY").unwrap(),
            None
        );

        std::fs::write(cli.dir.join("session"), SESSION).unwrap();
        let connected = ipc(&window, "connect_copilotkit_apps", body.clone()).unwrap();
        assert_eq!(connected, serde_json::Value::Null);
        assert!(!connected.to_string().contains(PROJECT_KEY));
        assert_eq!(
            openbot_desktop_lib::vault::recall(&root, "COMPOSIO_PROVISIONED_API_KEY").unwrap(),
            Some(PROJECT_KEY.to_owned())
        );
        assert!(!root.join(".openbot-apps").exists());

        std::fs::remove_file(cli.dir.join("argv")).unwrap();
        ipc(&window, "connect_copilotkit_apps", body).unwrap();
        assert_eq!(cli.argv(), None, "a kept key is never asked for again");
        assert_eq!(received.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    A KEY THE PERSON SUPPLIED WINS, AND APPS NEVER STOP START.

    With `COMPOSIO_API_KEY` in `.env`, Start asks nobody and hands the server that key, and `.env`
    is left as it was. When Ops cannot provision, Start still succeeds, with apps unavailable.
    */
    #[test]
    fn a_supplied_key_wins_and_a_failure_never_stops_start() {
        if crate::test_support::isolated_process(
            "tests::composio_ipc::a_supplied_key_wins_and_a_failure_never_stops_start",
        ) {
            return;
        }
        let (ops, received) = fake_ops("503 Service Unavailable");
        let cli = FakeCli::pinned("composio-supplied-cli", &ops, true);

        let root = signed_in_installation("composio-supplied");
        let env = "COMPOSIO_API_KEY=synthetic-person-key\nOPENBOT_ORIGIN=http://127.0.0.1:3010\n";
        std::fs::write(root.join(".env"), env).unwrap();
        let secrets = start_environment(&root);
        assert_eq!(
            secrets.get("COMPOSIO_API_KEY").map(String::as_str),
            Some("synthetic-person-key")
        );
        assert_eq!(cli.argv(), None);
        assert!(std::fs::read_to_string(root.join(".env"))
            .unwrap()
            .contains("COMPOSIO_API_KEY=synthetic-person-key"));
        std::fs::remove_dir_all(root).unwrap();

        let root = signed_in_installation("composio-ops-down");
        let secrets = start_environment(&root);
        assert_eq!(secrets.get("COMPOSIO_API_KEY"), None);
        assert_eq!(received.lock().unwrap().len(), 1);
        assert!(!root.join(".openbot-apps").exists());
        assert_eq!(
            openbot_desktop_lib::vault::recall(&root, "COMPOSIO_PROVISIONED_API_KEY").unwrap(),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
