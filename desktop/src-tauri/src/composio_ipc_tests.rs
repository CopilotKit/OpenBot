// The real generated IPC handler must reject a changed root before browser/network work.
mod composio_ipc {
    use super::*;

    #[test]
    fn finish_sign_in_rejects_a_different_installation_without_provisioning() {
        if crate::test_support::isolated_process("tests::composio_ipc::finish_sign_in_rejects_a_different_installation_without_provisioning") { return; }
        let root = temp_root("composio-ipc-root");
        let other = root.join("other");
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![finish_intelligence_sign_in])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (signing, _) =
            openbot_desktop_lib::intelligence::SigningInToIntelligence::begin().unwrap();
        *app.state::<Shell>()
            .signing_in_to_intelligence
            .lock()
            .unwrap() = Some((root.clone(), 0, signing));
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let result = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: "finish_intelligence_sign_in".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "root": other })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let error = result.expect_err("a different root cannot finish this sign-in");
        assert_eq!(
            error["said"],
            "Where OpenBot lives changed. Sign in again for this folder."
        );
        assert!(app
            .state::<Shell>()
            .intelligence_credential
            .lock()
            .unwrap()
            .is_none());
        assert!(!root.exists());
    }

    fn signed_in(credential: &str, session: &str) -> openbot_desktop_lib::intelligence::SignedIn {
        openbot_desktop_lib::intelligence::SignedIn {
            credential: credential.into(),
            projects: Vec::new(),
            session: openbot_desktop_lib::intelligence::OpsSession::new(session.into()),
        }
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

    /**
    AN ABANDONED SIGN-IN KEEPS NOTHING.

    Composio provisioning ran inside the browser sign-in, before the newer-attempt check. Pressing
    "Sign in again" and then finishing the older tab under another account saved that account's
    key, and the newer attempt saw a key and skipped provisioning. Now the check comes first, and
    again before a provisioned key is saved, on the real protected store.
    */
    #[test]
    fn an_abandoned_sign_in_keeps_no_credential_and_saves_no_app_key() {
        if crate::test_support::isolated_process("tests::composio_ipc::an_abandoned_sign_in_keeps_no_credential_and_saves_no_app_key") { return; }
        for name in ["COMPOSIO_API_KEY", "ARCADE_API_KEY", "OPENBOT_BROKER_PROVIDER"] {
            std::env::remove_var(name);
        }
        let root = temp_root("composio-abandoned-sign-in");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Shell::default();
        let older = supersede_managed_sign_in(&shell);
        let newer = supersede_managed_sign_in(&shell);
        publish_intelligence_sign_in(
            &shell,
            newer,
            root.clone(),
            signed_in("synthetic-current-product", "synthetic-current-session"),
        )
        .unwrap();
        let error = publish_intelligence_sign_in(
            &shell,
            older,
            root.clone(),
            signed_in("synthetic-stale-product", "synthetic-stale-session"),
        )
        .unwrap_err();
        assert!(!serde_json::to_string(&error).unwrap().contains("synthetic-"));
        let (_, credential, _) = managed_sign_in_for(&shell, &root).unwrap();
        assert_eq!(credential, "synthetic-current-product");

        // A newer sign-in starts while this one's apps are being provisioned.
        let error = connect_apps(&shell, &root, |_, _| {
            supersede_managed_sign_in(&shell);
            Ok(openbot_desktop_lib::composio::Provisioned::New(
                openbot_desktop_lib::composio::ProvisionedKey::new("synthetic-stale-key".into()),
            ))
        })
        .unwrap_err();
        assert_eq!(
            error.said,
            "A newer sign-in was started. Finish that sign-in instead."
        );
        let brokers = openbot_desktop_lib::composio::resolve(&root).unwrap();
        assert_eq!(brokers.composio_source(), None);
        assert!(!brokers.runtime().contains_key("COMPOSIO_API_KEY"));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Apps are a follow-on step that can only add a key. A failure keeps the sign-in usable, and
    /// a retry with the same held session saves the key for this folder only.
    #[test]
    fn an_apps_failure_keeps_the_sign_in_and_a_retry_adds_the_key() {
        if crate::test_support::isolated_process("tests::composio_ipc::an_apps_failure_keeps_the_sign_in_and_a_retry_adds_the_key") { return; }
        for name in ["COMPOSIO_API_KEY", "ARCADE_API_KEY", "OPENBOT_BROKER_PROVIDER"] {
            std::env::remove_var(name);
        }
        let root = temp_root("composio-apps-retry");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Shell::default();
        let generation = supersede_managed_sign_in(&shell);
        publish_intelligence_sign_in(
            &shell,
            generation,
            root.clone(),
            signed_in("synthetic-product", "synthetic-session"),
        )
        .unwrap();
        let unavailable = Problem::plain("Apps are not provisioned here yet.");
        let error = connect_apps(&shell, &root, |_, _| Err(unavailable.clone())).unwrap_err();
        assert_eq!(error.said, unavailable.said);
        let (_, credential, _) = managed_sign_in_for(&shell, &root).unwrap();
        assert_eq!(credential, "synthetic-product");
        assert_eq!(
            openbot_desktop_lib::composio::resolve(&root)
                .unwrap()
                .composio_source(),
            None
        );

        connect_apps(&shell, &root, |_, _| {
            Ok(openbot_desktop_lib::composio::Provisioned::New(
                openbot_desktop_lib::composio::ProvisionedKey::new("synthetic-app-key".into()),
            ))
        })
        .unwrap();
        let brokers = openbot_desktop_lib::composio::resolve(&root).unwrap();
        assert_eq!(
            brokers.composio_source(),
            Some(openbot_desktop_lib::composio::KeySource::Provisioned)
        );
        assert_eq!(brokers.runtime()["COMPOSIO_API_KEY"], "synthetic-app-key");
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    A SIGN-IN BELONGS TO THE FOLDER IT WAS STARTED FOR.

    Changing the folder after signing in and then picking a project made the other folder's key,
    and that folder started without its apps. Every command that uses the held sign-in now names
    the folder, through the real generated handlers, and a different one is refused before any
    request is made.
    */
    #[test]
    fn a_sign_in_for_one_folder_cannot_make_keys_or_apps_for_another() {
        let root = temp_root("composio-ipc-bound-root");
        let other = root.join("other");
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![
                intelligence_key_for,
                connect_intelligence_apps
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        {
            let shell = app.state::<Shell>();
            let generation = supersede_managed_sign_in(&shell);
            publish_intelligence_sign_in(
                &shell,
                generation,
                root.clone(),
                signed_in("synthetic-product", "synthetic-session"),
            )
            .unwrap();
        }
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for (cmd, body) in [
            (
                "intelligence_key_for",
                serde_json::json!({ "root": other, "project": "7" }),
            ),
            (
                "connect_intelligence_apps",
                serde_json::json!({ "root": other }),
            ),
        ] {
            let error = ipc(&window, cmd, body).expect_err("another folder is refused");
            assert_eq!(
                error["said"],
                "Where OpenBot lives changed. Sign in again for this folder.",
                "{cmd}"
            );
        }
        assert!(app.state::<Shell>().intelligence_learning.lock().unwrap().is_none());
        assert!(!root.exists());
    }

    /**
    THE START HAND-OFF, AS START RUNS IT.

    Both cases go through `persist_start_environment`, the function Start calls, into a real Bun
    server and its supervised replacement. A key the person put in `.env` reaches the server over a
    provisioned one and stays in `.env` line for line. A provisioned key reaches the server and is
    never written to `.env`.
    */
    #[cfg(unix)]
    #[test]
    fn saved_broker_key_reaches_fresh_server_and_actual_supervised_replacement() {
        if crate::test_support::isolated_process("tests::composio_ipc::saved_broker_key_reaches_fresh_server_and_actual_supervised_replacement") { return; }
        for supplied in [false, true] {
            broker_start_and_restart(supplied);
        }
    }

    #[cfg(unix)]
    fn broker_start_and_restart(supplied: bool) {
        for name in [
            "COMPOSIO_API_KEY",
            "ARCADE_API_KEY",
            "OPENBOT_BROKER_PROVIDER",
        ] {
            std::env::set_var(name, "   ");
        }
        std::env::remove_var("OPENBOT_INSTALLATION_ID");
        let host = InitialHostFixture::new("success");
        // Real Bun loads the dotenv while inherited blank values remain in its parent.
        let bun =
            PathBuf::from(std::env::var_os("OPENBOT_TEST_BUN").unwrap_or_else(|| "bun".into()));
        let (provider, expected) = if supplied {
            ("arcade", "synthetic-person-key")
        } else {
            ("composio", "synthetic-native-key")
        };
        let script = format!(
            r#"
import {{ writeFileSync }} from 'node:fs';
import {{ basename }} from 'node:path';
const role = basename(process.cwd());
const parent = process.ppid;
writeFileSync('child.pid', String(process.pid));
if (role === 'server') {{
  const checks = {{ composio: process.env.COMPOSIO_API_KEY === '{expected}', arcade: process.env.ARCADE_API_KEY === 'synthetic-arcade-key', provider: process.env.OPENBOT_BROKER_PROVIDER === '{provider}' }};
  writeFileSync('broker.checks', JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) throw new Error('incorrect native broker environment');
  writeFileSync('broker.receipt', String(process.pid));
}} else if (process.env.COMPOSIO_API_KEY === 'synthetic-native-key') throw new Error('the provisioned key reached another host role');
setInterval(() => {{ if (process.ppid !== parent) process.exit(0); }}, 50);
"#
        );
        for process in stack::host_processes(false) {
            let path = host
                .root
                .join(process.cwd)
                .join(if process.script.is_empty() {
                    "fixture.ts"
                } else {
                    process.script
                });
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, &script).unwrap();
        }
        std::fs::write(
            host.root.join("app/package.json"),
            r#"{"scripts":{"serve":"bun fixture.ts"}}"#,
        )
        .unwrap();
        let path = host.root.join(".env");
        let supplied_line = "COMPOSIO_API_KEY=\"synthetic-person-key\" # supplied";
        let broker_lines = format!(
            "{}ARCADE_API_KEY='synthetic-arcade-key'\nOPENBOT_BROKER_PROVIDER=`{provider}` # selected\n",
            if supplied {
                format!("{supplied_line}\n")
            } else {
                String::new()
            }
        );
        std::fs::write(&path, &broker_lines).unwrap();
        // Provisioned in both cases. With a supplied key it must lose.
        openbot_desktop_lib::composio::save(
            &host.root,
            openbot_desktop_lib::composio::ProvisionedKey::new("synthetic-native-key".into()),
        )
        .unwrap();
        let (_, secrets) = persist_start_environment(
            &host.root,
            std::collections::BTreeMap::from([("APP_PORT".to_string(), "52110".to_string())]),
            &openbot_env::ModelCredential::None,
        )
        .unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        for line in broker_lines.lines() {
            assert!(written.lines().any(|kept| kept == line), "{line} left .env: {written}");
        }
        assert!(!written.contains("synthetic-native-key"));
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let mut fixture = SupervisionFixture {
            host,
            app,
            watcher: None,
        };
        let shell = fixture.app.state::<Shell>();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let generation = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.host.root,
            &fixture.host.root.join(".logs"),
            &bun,
            &secrets,
            None,
            |name| fixture.host.observe(name),
            |_| Ok(()),
        ))
        .unwrap_or_else(|problem| {
            panic!(
                "broker startup failed: {problem:?}; checks: {:?}",
                std::fs::read_to_string(fixture.host.root.join("server/broker.checks"))
            )
        });
        drop(attempt);
        fixture.watcher = Some(supervise_host_processes(
            fixture.app.handle().clone(),
            fixture.host.root.clone(),
            fixture.host.root.join(".logs"),
            bun,
            secrets,
            generation,
            openbot_env::Ports::default(),
            None,
        ));
        let receipt = fixture.host.root.join("server/broker.receipt");
        let original = {
            let mut children = shell.children.lock().unwrap();
            let (_, server) = children
                .iter_mut()
                .find(|(name, _)| *name == "server")
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !receipt.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "initial server did not receive resolved broker settings: {:?}",
                    std::fs::read_to_string(fixture.host.root.join("server/broker.checks"))
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(
                std::fs::read_to_string(&receipt).unwrap(),
                server.id().to_string()
            );
            server.kill().unwrap();
            server.id()
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            let replacement = shell
                .children
                .lock()
                .unwrap()
                .iter_mut()
                .find(|(name, child)| *name == "server" && child.id() != original)
                .and_then(|(_, child)| child.try_wait().unwrap().is_none().then_some(child.id()));
            if let Some(pid) = replacement {
                if std::fs::read_to_string(&receipt).ok().as_deref() == Some(&pid.to_string()) {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "replacement did not receive resolved broker settings"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("synthetic-native-key"));
        assert_eq!(written.contains(supplied_line), supplied);
        assert!(shell.last_failure.lock().unwrap().is_none());
    }
}
