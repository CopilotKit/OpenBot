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

    Both cases go through `persist_start_environment`, the function Start calls. The server is a
    container, so what Start hands Compose is what reaches it, and Compose passes on only what the
    server service names. A key the person put in `.env` wins over a provisioned one and stays in
    `.env` line for line. A provisioned key is handed over and never written to `.env`.
    */
    #[test]
    fn saved_broker_key_reaches_the_server_container_and_never_env() {
        if crate::test_support::isolated_process("tests::composio_ipc::saved_broker_key_reaches_the_server_container_and_never_env") { return; }
        for supplied in [false, true] {
            broker_start(supplied);
        }
        let compose = include_str!("../../../docker-compose.yml");
        for name in ["COMPOSIO_API_KEY", "ARCADE_API_KEY", "OPENBOT_BROKER_PROVIDER"] {
            assert!(
                compose.contains(&format!("      {name}: ${{{name}:-}}")),
                "the server service must name {name}, or a provisioned key never reaches it"
            );
        }
    }

    fn broker_start(supplied: bool) {
        for name in [
            "COMPOSIO_API_KEY",
            "ARCADE_API_KEY",
            "OPENBOT_BROKER_PROVIDER",
        ] {
            std::env::set_var(name, "   ");
        }
        std::env::remove_var("OPENBOT_INSTALLATION_ID");
        let root = temp_root(if supplied { "broker-supplied" } else { "broker-provisioned" });
        std::fs::create_dir_all(&root).unwrap();
        let (provider, expected) = if supplied {
            ("arcade", "synthetic-person-key")
        } else {
            ("composio", "synthetic-native-key")
        };
        let path = root.join(".env");
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
            &root,
            openbot_desktop_lib::composio::ProvisionedKey::new("synthetic-native-key".into()),
        )
        .unwrap();
        let (_, secrets) = persist_start_environment(
            &root,
            std::collections::BTreeMap::from([("APP_PORT".to_string(), "52110".to_string())]),
            &openbot_env::ModelCredential::None,
        )
        .unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        for line in broker_lines.lines() {
            assert!(written.lines().any(|kept| kept == line), "{line} left .env: {written}");
        }
        assert!(!written.contains("synthetic-native-key"));
        assert_eq!(written.contains(supplied_line), supplied);
        assert_eq!(secrets.get("COMPOSIO_API_KEY").map(String::as_str), Some(expected));
        assert_eq!(
            secrets.get("ARCADE_API_KEY").map(String::as_str),
            Some("synthetic-arcade-key")
        );
        assert_eq!(
            secrets.get("OPENBOT_BROKER_PROVIDER").map(String::as_str),
            Some(provider)
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
