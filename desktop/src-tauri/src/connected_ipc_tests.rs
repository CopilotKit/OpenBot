// Included by main.rs: the app connected to an OpenBot that runs elsewhere, through the shell's own
// registered commands, its window rules and its Stop and Quit. The sign-in and the relay themselves
// are tested in the library (`connected`), against an OpenBot stand-in these tests do not have.
mod connected_ipc {
    use super::*;
    use openbot_desktop_lib::connected::{choice, credentials};
    use std::time::{Duration, Instant};

    const SETUP: &str = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    /// A relay's origin, as `show` trusts it: 127.0.0.1 at a port the system picked.
    const RELAY: &str = "http://127.0.0.1:49200";
    const ADDRESS: &str = "https://openbot.example.com";

    struct Connected {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::WebviewWindow<tauri::test::MockRuntime>,
        config: PathBuf,
        store: credentials::Store,
    }

    impl Connected {
        /// The app as it is built, with the page's plugin stood in for under its own name so the
        /// ACL that guards the real commands guards these, and a configuration folder and
        /// credential store of the test's own.
        fn new() -> Self {
            Self::with_page_plugin(
                tauri::plugin::Builder::<tauri::test::MockRuntime>::new(desktop_page::PLUGIN)
                    .invoke_handler(|invoke| {
                        invoke.resolver.resolve(());
                        true
                    })
                    .build(),
            )
        }

        /// The same, with the page plugin's real `record_problem` and `save_logs` in place of the
        /// stand-in, under the same ACL: what OpenBot's page reaches when it records a problem.
        /// Under an identifier of its own (`identifier`), so its log folder is the test's and never
        /// the log folder of whoever runs the tests.
        fn recording_problems(identifier: &str) -> Self {
            Self::with_page_plugin_as(
                tauri::plugin::Builder::<tauri::test::MockRuntime>::new(desktop_page::PLUGIN)
                    .invoke_handler(tauri::generate_handler![
                        desktop_page::record_problem,
                        desktop_page::save_logs
                    ])
                    .build(),
                Some(identifier),
            )
        }

        fn with_page_plugin(
            stand_in: tauri::plugin::TauriPlugin<tauri::test::MockRuntime>,
        ) -> Self {
            Self::with_page_plugin_as(stand_in, None)
        }

        fn with_page_plugin_as(
            stand_in: tauri::plugin::TauriPlugin<tauri::test::MockRuntime>,
            identifier: Option<&str>,
        ) -> Self {
            let mut context = side_by_side(tauri::generate_context!(test = true));
            if let Some(identifier) = identifier {
                context.config_mut().identifier = identifier.to_owned();
            }
            let app = tauri::test::mock_builder()
                .plugin(stand_in)
                .plugin(tauri_plugin_notification::init())
                .plugin(intelligence_bridge::plugin())
                .manage(Shell::default())
                .invoke_handler(tauri::generate_handler![
                    desktop_connected::connection,
                    desktop_connected::check_openbot_address,
                    desktop_connected::connect_to_openbot,
                    desktop_connected::cancel_connect,
                    desktop_connected::show_connected,
                    desktop_connected::sign_out_of_openbot,
                    desktop_connected::use_this_computer,
                    desktop_connected::take_connection_notice,
                ])
                .build(context)
                .unwrap();
            know_app_page_grants(app.handle());
            let window = app.get_webview_window("main").unwrap_or_else(|| {
                tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                    .build()
                    .unwrap()
            });
            *app.state::<Shell>().setup_url.lock().unwrap() = Some(SETUP.into());
            let config = temp_root("openbot-connected-config");
            // keyring's own in-memory store, never the keychain of whoever runs the tests.
            let store = credentials::Store::of(keyring_core::mock::Store::new().unwrap());
            desktop_connected::use_for_test(app.handle(), config.clone(), store.clone());
            Self {
                app,
                window,
                config,
                store,
            }
        }

        fn handle(&self) -> &tauri::AppHandle<tauri::test::MockRuntime> {
            self.app.handle()
        }

        fn choose(&self, mode: choice::Mode, address: &str, organization: Option<&str>) {
            choice::write(
                &self.config,
                &choice::Choice {
                    mode,
                    address: Some(address.into()),
                    organization_id: organization.map(str::to_owned),
                },
            )
            .unwrap();
        }

        fn ask(&self, from: &str, cmd: &str) -> Result<serde_json::Value, serde_json::Value> {
            self.ask_with(from, cmd, serde_json::json!({}))
        }

        fn ask_with(
            &self,
            from: &str,
            cmd: &str,
            args: serde_json::Value,
        ) -> Result<serde_json::Value, serde_json::Value> {
            tauri::test::get_ipc_response(
                &self.window,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: from.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(args),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize().unwrap())
        }

        /// What is in the configuration folder, by name.
        fn config_files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.config)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }
    }

    impl Drop for Connected {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.config);
        }
    }

    fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// An address nothing answers at: a loopback port that was free a moment ago.
    fn nobody_home() -> String {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        format!("http://127.0.0.1:{port}")
    }

    /// The setup window asks where OpenBot runs and drives the connection; no page from anywhere
    /// else can, OpenBot's own page through the relay included.
    #[test]
    fn the_setup_page_may_ask_the_connection_commands_and_no_other_origin_may() {
        let shell = Connected::new();
        assert_eq!(
            shell.ask(SETUP, "connection"),
            Ok(serde_json::json!({
                "mode": "local",
                "address": null,
                "organizationId": null,
                "signedIn": false
            }))
        );
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::Value::Null)
        );
        assert_eq!(
            shell.ask(SETUP, "cancel_connect"),
            Ok(serde_json::Value::Null)
        );

        desktop_connected::showing_for_test(shell.handle(), RELAY);
        for elsewhere in [
            "http://127.0.0.1:3011/",
            "https://openbot.example.com/",
            "http://127.0.0.1:49200/settings",
        ] {
            for command in [
                "connection",
                "check_openbot_address",
                "connect_to_openbot",
                "cancel_connect",
                "show_connected",
                "sign_out_of_openbot",
                "use_this_computer",
                "take_connection_notice",
            ] {
                assert!(
                    shell.ask(elsewhere, command).is_err(),
                    "{elsewhere} reached {command}"
                );
            }
        }
        // Registered in the app itself, beside the commands setup already has.
        let main = include_str!("main.rs");
        let handler = &main[main.find(".invoke_handler(tauri::generate_handler![").unwrap()..];
        let handler = &handler[..handler.find("])").unwrap()];
        for command in [
            "connection",
            "check_openbot_address",
            "connect_to_openbot",
            "cancel_connect",
            "show_connected",
            "sign_out_of_openbot",
            "use_this_computer",
            "take_connection_notice",
        ] {
            assert!(
                handler.contains(&format!("desktop_connected::{command},")),
                "{command} is not registered"
            );
        }
    }

    /// OpenBot's page, served through the relay, may ask where it runs, sign out, change the
    /// connection and name the organisation. A page on another loopback port may not.
    #[test]
    fn the_relays_page_may_ask_the_page_calls_and_another_loopback_port_may_not() {
        let shell = Connected::new();
        let calls = [
            "plugin:openbot-desktop|connection",
            "plugin:openbot-desktop|sign_out",
            "plugin:openbot-desktop|change_connection",
            "plugin:openbot-desktop|set_organization",
        ];
        let page = "http://127.0.0.1:49200/settings/computer";
        // Before the relay is up and trusted, nothing at that address reaches them.
        for call in calls {
            assert!(shell.ask(page, call).is_err(), "{call}");
        }
        desktop_connected::showing_for_test(shell.handle(), RELAY);
        for call in calls {
            assert_eq!(shell.ask(page, call), Ok(serde_json::Value::Null), "{call}");
            for other in [
                "http://127.0.0.1:49201/",
                "http://localhost:49200/",
                "http://[::1]:49200/",
                "https://openbot.example.com/",
            ] {
                assert!(shell.ask(other, call).is_err(), "{other} reached {call}");
            }
        }
        // And each is one of the plugin's own commands, built with a permission of its own.
        let build = include_str!("../build.rs");
        let page_source = include_str!("desktop_page.rs");
        for command in ["connection", "sign_out", "change_connection", "set_organization"] {
            assert!(build.contains(&format!("\"{command}\",")), "{command}");
            assert!(
                page_source.contains(&format!("async fn {command}(")),
                "{command}"
            );
            assert!(desktop_page::PERMISSIONS.contains(
                &format!("openbot-desktop:allow-{}", command.replace('_', "-")).as_str()
            ));
        }
    }

    /// The relay's page is OpenBot's own page to the window: the overlay title bar and everything
    /// that goes with it. A link from it to anywhere outside, the typed address itself included,
    /// is the person's browser's to open: it is not loaded in the window or sent through the relay.
    #[test]
    fn the_relays_page_is_openbots_own_and_a_link_to_the_typed_address_leaves_for_the_browser() {
        let shell = Connected::new();
        shell.choose(choice::Mode::Connected, ADDRESS, None);
        let page: tauri::Url = "http://127.0.0.1:49200/channel/c-1".parse().unwrap();
        assert_eq!(window_page(shell.handle(), &page), WindowPage::Other);
        desktop_connected::showing_for_test(shell.handle(), RELAY);
        assert_eq!(window_page(shell.handle(), &page), WindowPage::OwnedApp);
        assert!(is_owned_app_origin(shell.handle(), &page));
        assert_eq!(
            window_page(
                shell.handle(),
                &"http://127.0.0.1:49201/channel/c-1".parse().unwrap()
            ),
            WindowPage::Other
        );
        // The relay's own pages stay in the window.
        assert!(!outside_links::leaves(&page));
        // The OpenBot it is connected to, by its own address, is a site outside the window.
        let typed: tauri::Url = format!("{ADDRESS}/settings/api-keys").parse().unwrap();
        assert!(outside_links::leaves(&typed));
        assert!(!outside_links::loads_in_a_frame(&typed));
        let mut opened = Vec::new();
        outside_links::new_window(&typed, |to| opened.push(to.to_owned()));
        assert_eq!(opened, [typed.as_str()]);
        // The window's guard hands a site that leaves, from one of OpenBot's own pages, to the
        // browser and refuses the navigation. Read as text: the real webview cannot be built here.
        let main = include_str!("main.rs");
        let guard = &main[main.find("fn outside_links_guard").unwrap()..];
        let guard = &guard[..guard.find("\n}\n").unwrap()];
        assert!(guard.contains("window_page(webview.app_handle(), &current)"));
        assert!(guard.contains("WindowPage::OwnedApp | WindowPage::LocalApp"));
        assert!(guard.contains("open_in_browser(webview.app_handle(), destination);\n            false"));
    }

    /// Connected to an OpenBot at an address on this computer (a developer's own, or one reached
    /// through a port forward), with the relay on another port. A link to that OpenBot itself is
    /// for the person's browser, where they have a session of their own: by its host it looked
    /// like part of the window, and loaded there with no sign-in. Only the relay's own pages stay.
    #[test]
    fn while_connected_only_the_relays_own_pages_stay_in_the_window() {
        let shell = Connected::new();
        let typed = "http://127.0.0.1:20001";
        shell.choose(choice::Mode::Connected, typed, None);
        let to = |address: &str| {
            desktop_connected::leaves_for_browser(shell.handle(), &address.parse().unwrap())
        };
        let api_keys = format!("{typed}/settings/api-keys");

        // On this computer, or connected with nothing showing yet: the rule there has always been.
        assert_eq!(to(&api_keys), None);
        assert_eq!(to("https://example.com/"), None);
        assert!(!outside_links::leaves(&api_keys.parse().unwrap()));
        assert!(!outside_links::leaves(
            &"http://127.0.0.1:3010/connections".parse().unwrap()
        ));
        assert!(outside_links::leaves(&"https://example.com/".parse().unwrap()));

        desktop_connected::showing_for_test(shell.handle(), RELAY);
        // The OpenBot it is connected to, by its own address: the browser, and the window stays.
        assert_eq!(to(&api_keys), Some(true));
        assert_eq!(to(typed), Some(true));
        // Anything else on this computer that is not the relay, and any other site, as before.
        for outside in [
            "http://127.0.0.1:49201/",
            "http://localhost:49200/",
            "http://[::1]:49200/",
            "http://dashboard.localhost:8080/",
            "https://openbot.example.com/settings/api-keys",
            "https://app.hubspot.com/oauth/authorize?client_id=x",
            "http://example.com/",
        ] {
            assert_eq!(to(outside), Some(true), "{outside}");
        }
        // The relay's own pages, the setup page, the frames a page embeds, and what is no site.
        for inside in [
            "http://127.0.0.1:49200/",
            "http://127.0.0.1:49200/settings/api-keys",
            "http://127.0.0.1:49200/.openbot-relay/enter?key=k",
            SETUP,
            "https://calendly.com/d/dwfr-k64-8d2/openbot-for-business?embed_type=Inline",
            "https://js.stripe.com/v3/m-outer.html",
            "about:blank",
            "blob:http://127.0.0.1:49200/0b0e0c0a",
            "openbot://open?path=/channel/c-1",
        ] {
            assert_eq!(to(inside), Some(false), "{inside}");
        }

        // The window's guard asks this first, opens what leaves in the browser and refuses the
        // navigation; a new window asked for is opened the same way and never in the app. Read as
        // text: the real webview cannot be built here.
        let main = include_str!("main.rs");
        let guard = &main[main.find("fn outside_links_guard").unwrap()..];
        let guard = &guard[..guard.find("\n}\n").unwrap()];
        let connected = guard
            .find("desktop_connected::leaves_for_browser(webview.app_handle(), destination)")
            .expect("the guard asks the connected rule");
        assert!(connected < guard.find("outside_links::leaves(destination)").unwrap());
        assert!(guard[connected..].contains("return !leaves;"));
        let new_window = &main[main.find(".on_new_window(").unwrap()..];
        let new_window = &new_window[..new_window.find(".build()?").unwrap()];
        assert!(new_window.contains("desktop_connected::leaves_for_browser(&opener, &destination)"));
        assert!(new_window.contains("tauri::webview::NewWindowResponse::Deny"));
    }

    /// With the choice on record saying connected, nothing of an installation on this computer is
    /// asked, read or made: not by the page's status, Restart or Stop, not by Show, not by Quit.
    /// The installation's folder is a path that does not exist and must still not exist after,
    /// and the only engine on the PATH records every command it is given.
    #[test]
    fn connected_launch_status_and_quit_never_touch_the_local_installation() {
        if crate::test_support::isolated_process(
            "tests::connected_ipc::connected_launch_status_and_quit_never_touch_the_local_installation",
        ) {
            return;
        }
        let path = SerializedPath::set_only_with("docker", "stop-ipc");
        let base = temp_root("openbot-connected-local");
        std::fs::create_dir_all(&base).unwrap();
        let record = base.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let root = base.join("OpenBot");
        let asked_the_engine = || record.exists();

        // On this computer, as before: the same status question asks the engine.
        let local = Connected::new();
        let local_root = base.join("OpenBot on this computer");
        remember_selected_root(&local.app.state::<Shell>(), &local_root);
        let status = tauri::async_runtime::block_on(desktop_status(local.handle().clone(), None))
            .unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap()["root"],
            local_root.display().to_string()
        );
        assert!(asked_the_engine(), "a local status asks the engine");
        std::fs::remove_file(&record).unwrap();
        drop(local);

        let shell = Connected::new();
        shell.choose(choice::Mode::Connected, ADDRESS, Some("org_1"));
        remember_selected_root(&shell.app.state::<Shell>(), &root);
        assert!(desktop_connected::is_connected(shell.handle()));

        // The page's status: the app's own facts, and nothing of an OpenBot here.
        let status = tauri::async_runtime::block_on(desktop_status(shell.handle().clone(), None))
            .unwrap();
        let status = serde_json::to_value(&status).unwrap();
        assert_eq!(status["openbotRunning"], false);
        assert_eq!(status["openbotHeld"], false);
        assert_eq!(status["processes"], serde_json::json!([]));
        assert_eq!(status["containers"], serde_json::json!([]));
        assert_eq!(status["intelligenceStack"], serde_json::Value::Null);
        assert_eq!(status["intelligenceContainers"], serde_json::json!([]));
        assert_eq!(status["engine"], serde_json::Value::Null);
        assert_eq!(status["root"], "");
        assert_eq!(status["appPort"], serde_json::Value::Null);
        assert_eq!(status["version"], desktop_version(shell.handle()));
        assert!(status["build"].as_str().unwrap().starts_with("Built "));
        assert_eq!(
            status["logFolder"],
            logging::folder(shell.handle()).unwrap().display().to_string()
        );

        // What is about this computer's own OpenBot is refused, in the agreed words.
        let refused = "This app is connected to an OpenBot that runs somewhere else, so there's nothing to do here on this computer.";
        assert_eq!(
            tauri::async_runtime::block_on(desktop_page::restart(shell.handle().clone())),
            Err(refused.to_owned())
        );
        assert_eq!(
            tauri::async_runtime::block_on(desktop_page::stop(shell.handle().clone())),
            Err(refused.to_owned())
        );
        let shown = tauri::async_runtime::block_on(show_openbot(shell.handle().clone()))
            .expect_err("there is no OpenBot here to show");
        assert_eq!(shown.said, refused);
        assert_eq!(
            desktop_connected::local_only(shell.handle()).unwrap_err().said,
            refused
        );

        // The page is told where it runs, and the window still knows its own pages.
        assert_eq!(
            serde_json::to_value(desktop_connected::connection_now(shell.handle(), false)).unwrap(),
            serde_json::json!({
                "mode": "connected",
                "address": ADDRESS,
                "organizationId": "org_1",
                "moveToCloud": false
            })
        );
        desktop_connected::showing_for_test(shell.handle(), RELAY);
        assert_eq!(
            window_page(shell.handle(), &"http://127.0.0.1:49200/".parse().unwrap()),
            WindowPage::OwnedApp
        );

        // Quit: nothing to stop, so no Shutting down screen and no failures.
        let showing = shell.window.url().unwrap();
        assert_eq!(quit_cleanup_shown(shell.handle()), Vec::<String>::new());
        assert_eq!(quit_status(shell.handle().clone()), None);
        assert_eq!(shell.window.url().unwrap(), showing);

        // The Cloud sign-in uses the same direct-quit path, with no local stack or progress page.
        let cloud = Connected::new();
        cloud.choose(choice::Mode::Connected, "https://api.open.bot", None);
        remember_selected_root(&cloud.app.state::<Shell>(), &root);
        let showing = cloud.window.url().unwrap();
        assert_eq!(quit_cleanup_shown(cloud.handle()), Vec::<String>::new());
        assert_eq!(quit_status(cloud.handle().clone()), None);
        assert_eq!(cloud.window.url().unwrap(), showing);
        assert!(
            desktop_connected::is_connected(cloud.handle()),
            "Quit does not sign out"
        );
        drop(cloud);

        assert!(!asked_the_engine(), "{:?}", std::fs::read_to_string(&record));
        assert!(!root.exists(), "the installation's folder was made");
        assert_eq!(shell.config_files(), ["connection.json"]);
        drop(shell);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(path.bin());
    }

    /// The organisation picked in the app is kept beside the address, told back to the page, and
    /// kept through a sign-out, so the next sign-in at that address works where the person left
    /// off: a token remembers nothing, so the app is what remembers. Sign-out forgets the saved
    /// sign-in and keeps the address; back on this computer the choice is local, with the address
    /// still remembered for another time and the organisation gone.
    #[test]
    fn the_organisation_is_kept_through_sign_out_and_cleared_back_on_this_computer() {
        let _ports = crate::test_support::hold_ports();
        let shell = Connected::new();
        let address = nobody_home();
        // On this computer there is no organisation to name.
        assert!(desktop_connected::set_organization_now(shell.handle(), Some("org_1".into()))
            .is_err());
        assert_eq!(shell.config_files(), Vec::<String>::new());

        shell.choose(choice::Mode::Connected, &address, None);
        // Built at run time, so no token-shaped literal sits in the source.
        let saved = format!("obr_{}", "Kq7m".repeat(8));
        shell.store.set(&address, &saved).unwrap();
        desktop_connected::set_organization_now(shell.handle(), Some("org_A1-b".into())).unwrap();
        assert_eq!(
            choice::read(&shell.config).organization_id.as_deref(),
            Some("org_A1-b")
        );
        for bad in ["", "two words", "../etc", "org\r\nX-Injected: 1"] {
            assert!(
                desktop_connected::set_organization_now(shell.handle(), Some(bad.into())).is_err(),
                "{bad:?}"
            );
        }
        assert_eq!(
            choice::read(&shell.config).organization_id.as_deref(),
            Some("org_A1-b"),
            "a refused id changes nothing"
        );
        assert_eq!(
            serde_json::to_value(desktop_connected::connection_now(shell.handle(), true)).unwrap(),
            serde_json::json!({
                "mode": "connected",
                "address": address,
                "organizationId": "org_A1-b",
                "signedIn": true
            })
        );

        desktop_connected::sign_out_now(shell.handle());
        assert_eq!(shell.store.get(&address).unwrap(), None);
        assert_eq!(
            serde_json::to_value(desktop_connected::connection_now(shell.handle(), true)).unwrap(),
            serde_json::json!({
                "mode": "connected",
                "address": address,
                "organizationId": "org_A1-b",
                "signedIn": false
            })
        );
        // Signing in again at the same address carries it into the new sign-in, which the relay
        // then names; at another address it is gone.
        let kept = choice::read(&shell.config);
        assert_eq!(
            choice::signed_in_at(&kept, &address)
                .organization_id
                .as_deref(),
            Some("org_A1-b")
        );
        assert_eq!(
            choice::signed_in_at(&kept, "https://another.example.com").organization_id,
            None
        );

        // Settings' Change signs out the same way, and keeps it too.
        shell.store.set(&address, &saved).unwrap();
        desktop_connected::change_connection_now(shell.handle()).unwrap();
        assert_eq!(shell.store.get(&address).unwrap(), None);
        assert_eq!(
            choice::read(&shell.config).organization_id.as_deref(),
            Some("org_A1-b")
        );

        // Back to OpenBot on this computer, from the setup window.
        desktop_connected::set_organization_now(shell.handle(), Some("org_2".into())).unwrap();
        tauri::async_runtime::block_on(desktop_connected::use_this_computer(
            shell.handle().clone(),
        ))
        .unwrap();
        assert!(!desktop_connected::is_connected(shell.handle()));
        let kept = choice::read(&shell.config);
        assert_eq!(kept.mode, choice::Mode::Local);
        assert_eq!(kept.address.as_deref(), Some(address.as_str()));
        assert_eq!(kept.organization_id, None);
        assert_eq!(shell.window.url().unwrap().as_str(), SETUP);
        // OpenBot's page on this computer is told local, and no address.
        assert_eq!(
            serde_json::to_value(desktop_connected::connection_now(shell.handle(), false)).unwrap(),
            serde_json::json!({
                "mode": "local",
                "address": null,
                "organizationId": null,
                "moveToCloud": false
            })
        );
        // Nothing token-shaped was ever written beside the choice.
        assert_eq!(shell.config_files(), ["connection.json"]);
        let written = std::fs::read_to_string(shell.config.join("connection.json")).unwrap();
        assert!(!written.contains("obr_") && !written.contains("oba_"), "{written}");
    }

    /// Once the browser has been opened for a sign-in, the app comes forward however it ended: on
    /// the Mac a sign-in whose save to the Keychain failed left the app behind the browser, and the
    /// person saw only the browser's line. Before the browser opens (a bad or unreachable address)
    /// the app is in front already, and nothing is asked of the window.
    #[test]
    fn every_outcome_after_the_browser_brings_the_app_forward() {
        use openbot_desktop_lib::connected::Kind;
        let shell = Connected::new();
        let host = "openbot.example.com";
        let outcomes: Vec<Result<(), Problem>> = vec![
            Ok(()),
            Err(Kind::AccessRefused.problem(host, "it answered 403")),
            Err(Kind::SignInFailed.problem(host, "it answered 500")),
            Err(Kind::CredentialStore.problem(host, "the keychain refused")),
            Err(Kind::SignInCancelled.problem(host, "the person denied consent")),
            Err(Kind::TooOld.problem(host, "the token exchange gave no refresh token")),
        ];
        let said: Vec<Option<String>> = outcomes
            .iter()
            .map(|outcome| desktop_connected::forward_after_sign_in(true, outcome))
            .collect();
        assert_eq!(
            said,
            [
                "signed in",
                "access-refused",
                "sign-in-failed",
                "credential-store",
                "sign-in-cancelled",
                "too-old",
            ]
            .map(|ended| Some(format!("the browser sign-in ended: {ended}")))
        );
        // The browser never opened: the window is left as it is.
        assert_eq!(
            desktop_connected::forward_after_sign_in(
                false,
                &Err(Kind::Unreachable.problem(host, "connection refused")),
            ),
            None
        );
        // Through the shell and its mock window, which keeps no record of being in front, so the
        // decision above is what is checked; this only shows the call runs on the real app type.
        for outcome in &outcomes {
            desktop_connected::come_forward_after_sign_in(shell.handle(), true, outcome);
        }
        // The command does it for every outcome, before it answers the setup page.
        let source = include_str!("desktop_connected.rs");
        let command = &source[source.find("pub async fn connect_to_openbot").unwrap()..];
        let command = &command[..command.find("\n}\n").unwrap()];
        assert!(
            command.contains("come_forward_after_sign_in(\n        &forward,\n        opened.load("),
            "{command}"
        );
    }

    /// The sign-in ended while OpenBot was showing: the setup window is back, it is told so once
    /// in the agreed words, and the event went out for a page that was listening.
    #[test]
    fn an_ended_session_puts_setup_back_and_keeps_its_sentence_for_it_once() {
        use tauri::Listener;
        let shell = Connected::new();
        shell.choose(choice::Mode::Connected, ADDRESS, None);
        let (heard, events) = std::sync::mpsc::channel();
        shell.app.listen(desktop_connected::ENDED_EVENT, move |event| {
            let _ = heard.send(event.payload().to_owned());
        });

        desktop_connected::session_ended(shell.handle(), "openbot.example.com");

        assert_eq!(shell.window.url().unwrap().as_str(), SETUP);
        let said = serde_json::json!({
            "kind": "session-ended",
            "message": "Your sign-in to openbot.example.com has ended. Sign in again to keep going."
        });
        let event: serde_json::Value =
            serde_json::from_str(&events.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert_eq!(event, said);
        assert_eq!(shell.ask(SETUP, "take_connection_notice"), Ok(said));
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::Value::Null)
        );
        // Still the choice: setup shows the connect screen with the address filled in.
        assert_eq!(choice::read(&shell.config).connected_to(), Some(ADDRESS));
    }

    /// Settings' Change, while connected: signed out, still connected to the address, and setup
    /// told once to open at the choice.
    #[test]
    fn change_connection_while_connected_signs_out_and_asks_setup_to_choose() {
        let _ports = crate::test_support::hold_ports();
        let shell = Connected::new();
        let address = nobody_home();
        shell.choose(choice::Mode::Connected, &address, Some("org_1"));
        shell
            .store
            .set(&address, &format!("obr_{}", "Zt4w".repeat(8)))
            .unwrap();

        desktop_connected::change_connection_now(shell.handle()).unwrap();

        assert_eq!(shell.store.get(&address).unwrap(), None);
        assert_eq!(shell.window.url().unwrap().as_str(), SETUP);
        let kept = choice::read(&shell.config);
        assert_eq!(kept.connected_to(), Some(address.as_str()));
        // Kept for signing in again at the same address; another address or this computer clears it.
        assert_eq!(kept.organization_id.as_deref(), Some("org_1"));
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::json!({ "kind": "choose", "message": null }))
        );
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::Value::Null)
        );
    }

    /// Settings' Change, while OpenBot runs on this computer: OpenBot is stopped exactly as
    /// Settings' Stop stops it, setup comes back told once to open at the choice, and the choice
    /// on record is not changed by asking.
    #[test]
    fn change_connection_on_this_computer_stops_openbot_and_asks_setup_to_choose() {
        if crate::test_support::isolated_process(
            "tests::connected_ipc::change_connection_on_this_computer_stops_openbot_and_asks_setup_to_choose",
        ) {
            return;
        }
        let path = SerializedPath::set_only_with("docker", "stop-ipc");
        let root = temp_root("openbot-connected-change");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let shell = Connected::new();
        *shell.app.state::<Shell>().root.lock().unwrap() = Some(root.clone());
        *shell.app.state::<Shell>().containers.lock().unwrap() = Some(ContainerDeployment {
            root: root.clone(),
            address: engine::Address::new(engine::Engine::Docker, None),
        });
        // Compose down waits here, so the test sees what is true before it finishes.
        let compose = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(
            root.join("stop-barrier-address"),
            compose.local_addr().unwrap().to_string(),
        )
        .unwrap();

        desktop_connected::change_connection_now(shell.handle()).unwrap();
        let (mut stopping, _) = compose.accept().unwrap();
        // Not asked to choose until OpenBot has stopped.
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::Value::Null)
        );
        stopping.write_all(&[0]).unwrap();

        wait_until("setup came back", || {
            shell.window.url().unwrap().as_str() == SETUP
        });
        assert_compose_down_ran_under(&record, &root);
        assert!(shell.app.state::<Shell>().root.lock().unwrap().is_none());
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::json!({ "kind": "choose", "message": null }))
        );
        assert_eq!(
            shell.ask(SETUP, "take_connection_notice"),
            Ok(serde_json::Value::Null)
        );
        // The choice is not changed by asking: still none on record, so still this computer.
        assert_eq!(shell.config_files(), Vec::<String>::new());
        assert!(!desktop_connected::is_connected(shell.handle()));
        assert!(last_failure_now(shell.handle()).is_none());
        drop(shell);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.bin());
    }

    /// The menus of a connected app carry Show Window, the app's log folder, Sign Out and Quit, and
    /// nothing that starts, stops or reports on an OpenBot on this computer. Read as text, as the
    /// other menu tests are: AppKit's menus cannot be built here. Get Troubleshooting Logs… is
    /// there too: `a_connected_apps_menus_offer_the_troubleshooting_logs`.
    #[test]
    fn a_connected_apps_menus_offer_sign_out_and_the_log_folder_and_no_status() {
        let main = include_str!("main.rs");
        let at = |pieces: &[&str]| main.find(&pieces.concat()).unwrap();
        let menus = &main[at(&["\nfn install", "_menus"])..];
        let menus = &menus[..menus.find("app.set_menu(").unwrap()];
        for entries in ["let tray_entries = ", "let window_entries = "] {
            // From where the menu starts to where a connected app's menu is handed back.
            let built = &menus[menus.find(entries).unwrap()..];
            let connected = &built[..built.find("return Ok(entries);").unwrap()];
            assert!(connected.contains("if connected {"), "{entries}");
            for carried in [
                "\"Show Window\"",
                "CONNECTED_LOG_FOLDER_MENU_ID",
                "CONNECTED_SIGN_OUT_MENU_ID",
                "\"quit\"",
            ] {
                assert!(connected.contains(carried), "{entries} lacks {carried}");
            }
            for absent in ["\"status\"", "\"state\"", "\"stop\""] {
                assert!(!connected.contains(absent), "{entries} carries {absent}");
            }
        }
        assert_eq!(CONNECTED_SIGN_OUT_MENU_LABEL, "Sign Out");
        assert_eq!(CONNECTED_LOG_FOLDER_MENU_LABEL, "Open Log Folder");
        let chosen = &main[at(&["\nfn cho", "se(app"])..];
        let chosen = &chosen[..chosen.find("\n}\n").unwrap()];
        assert!(chosen.contains(
            "CONNECTED_SIGN_OUT_MENU_ID => desktop_connected::sign_out_from_menu(app.clone()),"
        ));
        assert!(chosen.contains("\"stop\" | \"status\" if desktop_connected::is_connected(app) => {}"));
    }

    /**
    FOUND IN DOGFOODING, OpenBot Desktop 1.2.0-rc.4 signed in to OpenBot Cloud: "Logs are not
    generating when I use the product. The previous version had a Menu item to generate the logs...
    That menu item is gone." Connected, both menus carried Open Log Folder in place of Get
    Troubleshooting Logs…, and a stale menu or a shortcut asking for `logs` did nothing.

    Now both menus carry it beside Open Log Folder, under the same label and the same id as on this
    computer, and choosing it gathers and saves the file however the app runs OpenBot. Read as text,
    as the other menu tests are: AppKit's menus cannot be built here.
    */
    #[test]
    fn a_connected_apps_menus_offer_the_troubleshooting_logs() {
        let main = include_str!("main.rs");
        let at = |pieces: &[&str]| main.find(&pieces.concat()).unwrap();
        let menus = &main[at(&["\nfn install", "_menus"])..];
        let menus = &menus[..menus.find("app.set_menu(").unwrap()];
        for entries in ["let tray_entries = ", "let window_entries = "] {
            let built = &menus[menus.find(entries).unwrap()..];
            let connected = &built[..built.find("return Ok(entries);").unwrap()];
            let folder = connected
                .find("CONNECTED_LOG_FOLDER_MENU_ID")
                .unwrap_or_else(|| panic!("{entries} lacks Open Log Folder"));
            let logs = connected
                .find("\"logs\",\n")
                .unwrap_or_else(|| panic!("{entries} lacks Get Troubleshooting Logs…"));
            assert!(folder < logs, "{entries}: the logs come after Open Log Folder");
            assert!(
                connected[logs..].starts_with("\"logs\",\n")
                    && connected[logs..].contains("logs_label,")
                    && connected[logs..].contains("logs_enabled,"),
                "{entries}: the same item as on this computer, Gathering Logs… included"
            );
        }
        assert_eq!(troubleshooting_menu_item(false), ("Get Troubleshooting Logs…", true));
        let chosen = &main[at(&["\nfn cho", "se(app"])..];
        let chosen = &chosen[..chosen.find("\n}\n").unwrap()];
        let guard = chosen
            .lines()
            .find(|line| line.contains("if desktop_connected::is_connected(app) => {}"))
            .expect("a connected app still refuses Stop and Status");
        assert!(!guard.contains("\"logs\""), "a connected app swallows the logs: {guard}");
        assert!(chosen.contains("\"logs\" => save_troubleshooting_logs_from_menu(app.clone()),"));
    }

    /// An OpenBot stand-in on 127.0.0.1 that answers `GET /health` as a real one does, with a request
    /// id, for as many requests as it gets until the test ends.
    fn health_answering() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                    line.clear();
                }
                let body = r#"{"status":"ok"}"#;
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-request-id: \
                         req_health\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        address
    }

    /**
    The whole path, connected: OpenBot's page, through the relay's origin, records a request the
    server refused with its request id and an error the page threw; then the menu's Get
    Troubleshooting Logs… saves a file that holds them, with the connected OpenBot's address and
    what it answered, the relay's recent lines and the end of this app's log, and none of the
    query's token, the key or the email address the page's words and the log carried. A page on any
    other origin is refused, and what it sent is nowhere.

    In a process of its own: it points the home folder, and with it this app's log folder, at a
    folder of the test's own.
    */
    #[test]
    fn a_connected_app_saves_what_its_page_recorded_from_the_menu() {
        if crate::test_support::isolated_process(
            "tests::connected_ipc::a_connected_app_saves_what_its_page_recorded_from_the_menu",
        ) {
            return;
        }
        // Windows finds the local data folder through the system, never the environment, so there
        // the app's own identifier is what keeps its log folder the test's.
        let home = temp_root("openbot-connected-logs-home");
        if !cfg!(windows) {
            std::env::set_var("HOME", &home);
            std::env::set_var("XDG_DATA_HOME", home.join(".local/share"));
        }
        let identifier = format!(
            "ai.copilotkit.openbot.desktop.test-{}",
            std::process::id()
        );
        let shell = Connected::recording_problems(&identifier);
        let address = health_answering();
        // As Better Auth makes an organization's id: 32 letters and digits, both cases.
        let organization = "Kd8fJ2pQKd8fJ2pQKd8fJ2pQKd8fJ2pQ";
        shell.choose(choice::Mode::Connected, &address, Some(organization));
        desktop_connected::showing_for_test(shell.handle(), RELAY);
        let folder = logging::folder(shell.handle()).unwrap();
        assert!(
            folder.components().any(|part| part.as_os_str() == identifier.as_str()),
            "{} is not the test's",
            folder.display()
        );
        std::fs::create_dir_all(&folder).unwrap();
        // This app's log as it reads after a reply broke: the relay's lines among the others.
        std::fs::write(
            folder.join("openbot-desktop.log"),
            "2026-11-24T09:59:58.000Z INFO  [connect] showing the OpenBot at 127.0.0.1\n\
             2026-11-24T09:59:59.000Z WARN  [relay] the connection to OpenBot closed before it \
             answered GET /api/v2/organizations/default/control; sending it once more\n\
             2026-11-24T10:00:00.000Z INFO  [account] signed in as dana.rivera@acme-robotics.io\n",
        )
        .unwrap();

        let key = format!("sk-ant-api03-{}", "Ab9_".repeat(12));
        let recorded = shell.ask_with(
            RELAY,
            "plugin:openbot-desktop|record_problem",
            serde_json::json!({ "problem": {
                "kind": "request",
                "method": "POST",
                "path": format!("/api/v2/organizations/{organization}/conversations?token=Zq3Kp8x7Zq3Kp8x7Zq3Kp8x7&email=dana@acme-robotics.io"),
                "outcome": "failed",
                "status": 500,
                "requestId": "req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10",
                "appVersion": "1.2.0-rc.4",
            }}),
        );
        assert_eq!(recorded, Ok(serde_json::Value::Null));
        assert_eq!(
            shell.ask_with(
                RELAY,
                "plugin:openbot-desktop|record_problem",
                serde_json::json!({ "problem": {
                    "kind": "page-error",
                    "message": format!("TypeError: Couldn't read {key} for dana.rivera@acme-robotics.io"),
                    "source": format!("{RELAY}/assets/index-abc.js:12:345"),
                    "appVersion": "1.2.0-rc.4",
                }}),
            ),
            Ok(serde_json::Value::Null)
        );
        // A page anywhere else, which a link in a reply can open in this window, is refused.
        assert!(shell
            .ask_with(
                "http://127.0.0.1:3011/",
                "plugin:openbot-desktop|record_problem",
                serde_json::json!({ "problem": {
                    "kind": "page-error",
                    "message": "Error: planted by another page",
                }}),
            )
            .is_err());

        // Get Troubleshooting Logs…, as both menus ask for it.
        save_troubleshooting_logs_from_menu(shell.handle().clone());
        let mut saved = None;
        wait_until("the troubleshooting logs were saved", || {
            saved = std::fs::read_dir(&folder)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("openbot-troubleshooting-"))
                });
            saved.is_some()
        });
        // Written whole before it is shown: wait until the gathering says it is done.
        wait_until("the gathering finished", || {
            !GATHERING_LOGS.load(std::sync::atomic::Ordering::SeqCst)
        });
        let text = std::fs::read_to_string(saved.as_ref().unwrap()).unwrap();

        for expected in [
            "connected to 127.0.0.1".to_owned(),
            format!("Address: {address}"),
            "Health (GET /health): answered 200".to_owned(),
            format!("Organization id: {organization}"),
            "Front end: 1.2.0-rc.4".to_owned(),
            format!(
                "request POST /api/v2/organizations/{organization}/conversations: answered 500, \
                 request id req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10"
            ),
            "page error: TypeError: Couldn't read [redacted] for [email] (at \
             http://127.0.0.1:49200/assets/index-abc.js:12:345)"
                .to_owned(),
            "## Relay (recent lines)".to_owned(),
            "[relay] the connection to OpenBot closed before it answered GET \
             /api/v2/organizations/default/control; sending it once more"
                .to_owned(),
            "## OpenBot Desktop log (end)".to_owned(),
            "[account] signed in as [email]".to_owned(),
        ] {
            assert!(text.contains(&expected), "{expected:?} not in\n{text}");
        }
        for absent in [
            "Zq3Kp8x7Zq3Kp8x7Zq3Kp8x7",
            "acme-robotics.io",
            key.as_str(),
            "planted by another page",
            "No container engine",
        ] {
            assert!(!text.contains(absent), "{absent:?} in\n{text}");
        }

        // The web app's own Get troubleshooting logs, inside this app, saves the same file. Another
        // page may not ask for it.
        let saved_by_menu = saved.unwrap();
        std::fs::remove_file(&saved_by_menu).unwrap();
        assert!(shell
            .ask(
                "http://127.0.0.1:3011/",
                "plugin:openbot-desktop|save_logs"
            )
            .is_err());
        assert!(!saved_by_menu.exists());
        assert_eq!(
            shell.ask(RELAY, "plugin:openbot-desktop|save_logs"),
            Ok(serde_json::Value::Null)
        );
        let from_page = std::fs::read_dir(&folder)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with("openbot-troubleshooting-")
                })
            })
            .expect("the page's ask saved the file");
        let text = std::fs::read_to_string(from_page).unwrap();
        assert!(
            text.contains("request id req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10"),
            "{text}"
        );
        assert!(!text.contains(key.as_str()));
        drop(shell);
        // The app's own folder under its test identifier, wherever the system put it.
        if let Some(own) = folder
            .ancestors()
            .find(|dir| dir.file_name().is_some_and(|name| name == identifier.as_str()))
        {
            let _ = std::fs::remove_dir_all(own);
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Sign-out sends the browser the sign-in went through to end its session at the OpenBot, when
    /// the OpenBot publishes where (the library's tests drive that against an OpenBot stand-in).
    /// Here, the wiring: the sign-in and both of `sign_out_now`'s sign-outs, which the menu, the
    /// page's and the setup window's Sign Out, Change and Use This Computer all go through, hand
    /// the library the same opener. Only a sign-in the app could not use leaves the browser alone.
    /// Read as text: a test opens no browser.
    #[test]
    fn every_sign_out_opens_the_browser_the_sign_in_used() {
        let source = include_str!("desktop_connected.rs");
        let body = |name: &str| {
            let start = source.find(&format!("fn {name}")).unwrap();
            let rest = &source[start..];
            &rest[..rest.find("\n}\n").unwrap()]
        };
        let connect = body("connect_now");
        assert!(connect.contains("open_in_browser(authorize)"));
        assert_eq!(connect.matches(".sign_out(keep_browser)").count(), 2);
        let sign_out = body("sign_out_now");
        assert!(sign_out.contains("live.session.sign_out(open_in_browser)"));
        let saved = &sign_out[sign_out.find("sign_in::sign_out_saved(").unwrap()..];
        assert!(saved[..saved.find(") {").unwrap()].contains("open_in_browser"));
        assert_eq!(source.matches("tauri_plugin_opener::open_url(").count(), 1);
        assert!(body("open_in_browser").contains("if cfg!(test) {"));
        for caller in [
            "sign_out_of_openbot",
            "use_this_computer",
            "change_connection_now",
            "sign_out_from_menu",
        ] {
            assert!(body(caller).contains("sign_out_now("), "{caller}");
        }
        let page = include_str!("desktop_page.rs");
        let page = &page[page.find("async fn sign_out(").unwrap()..];
        assert!(page[..page.find("\n}\n").unwrap()].contains("sign_out_now(&app)"));
    }
}
