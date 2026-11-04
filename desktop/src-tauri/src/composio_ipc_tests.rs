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

    #[test]
    fn a_late_sign_in_cannot_replace_the_newer_native_credential() {
        let shell = Shell::default();
        shell
            .intelligence_sign_in_generation
            .store(2, std::sync::atomic::Ordering::SeqCst);
        publish_intelligence_credential(&shell, 2, "synthetic-current-product".into()).unwrap();
        let error = publish_intelligence_credential(&shell, 1, "synthetic-stale-product".into())
            .unwrap_err();
        assert_eq!(
            shell.intelligence_credential.lock().unwrap().as_deref(),
            Some("synthetic-current-product")
        );
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("synthetic-"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_broker_key_reaches_fresh_server_and_actual_supervised_replacement() {
        if crate::test_support::isolated_process("tests::composio_ipc::saved_broker_key_reaches_fresh_server_and_actual_supervised_replacement") { return; }
        for provider in ["composio", "arcade"] {
            broker_start_and_restart(provider);
        }
    }

    #[cfg(unix)]
    fn broker_start_and_restart(provider: &str) {
        for name in [
            "COMPOSIO_API_KEY",
            "ARCADE_API_KEY",
            "OPENBOT_BROKER_PROVIDER",
        ] {
            std::env::set_var(name, "   ");
        }
        std::env::remove_var("OPENBOT_INSTALLATION_ID");
        let host = InitialHostFixture::new("success");
        // Real Bun loads the migrated dotenv while inherited blank values remain in its parent.
        let bun =
            PathBuf::from(std::env::var_os("OPENBOT_TEST_BUN").unwrap_or_else(|| "bun".into()));
        let script = format!(
            r#"
import {{ writeFileSync }} from 'node:fs';
import {{ basename }} from 'node:path';
const role = basename(process.cwd());
const parent = process.ppid;
writeFileSync('child.pid', String(process.pid));
if (role === 'server') {{
  const checks = {{ composio: process.env.COMPOSIO_API_KEY === 'synthetic-native-key', arcade: process.env.ARCADE_API_KEY === 'synthetic-arcade-key', provider: process.env.OPENBOT_BROKER_PROVIDER === '{provider}' }};
  writeFileSync('broker.checks', JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) throw new Error('incorrect native broker environment');
  writeFileSync('broker.receipt', String(process.pid));
}} else if (process.env.COMPOSIO_API_KEY !== undefined || process.env.ARCADE_API_KEY !== undefined) throw new Error('broker key reached another host role');
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
        let supplied_composio = if provider == "arcade" {
            "COMPOSIO_API_KEY=\"synthetic-native-key\" # supplied\n"
        } else {
            ""
        };
        std::fs::write(&path, format!("{supplied_composio}ARCADE_API_KEY='synthetic-arcade-key'\nOPENBOT_BROKER_PROVIDER=`{provider}` # selected\n")).unwrap();
        if provider == "composio" {
            openbot_desktop_lib::vault::remember(
                &host.root,
                "COMPOSIO_API_KEY",
                "synthetic-native-key",
            )
            .unwrap();
        }
        let values = openbot_desktop_lib::composio::configured(&host.root).unwrap();
        let (settings, mut secrets) = openbot_desktop_lib::vault::split(values);
        openbot_desktop_lib::vault::write_env_after_remembering(
            &host.root, &path, &settings, &secrets, &secrets,
        )
        .unwrap();
        pin_runtime_settings(&settings, &mut secrets);
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
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("synthetic-"));
        assert!(shell.last_failure.lock().unwrap().is_none());
    }
}
