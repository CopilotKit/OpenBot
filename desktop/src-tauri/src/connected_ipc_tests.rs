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
            let stand_in =
                tauri::plugin::Builder::<tauri::test::MockRuntime>::new(desktop_page::PLUGIN)
                    .invoke_handler(|invoke| {
                        invoke.resolver.resolve(());
                        true
                    })
                    .build();
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
                .build(side_by_side(tauri::generate_context!(test = true)))
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
            tauri::test::get_ipc_response(
                &self.window,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: from.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
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
                "organizationId": "org_1"
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

        assert!(!asked_the_engine(), "{:?}", std::fs::read_to_string(&record));
        assert!(!root.exists(), "the installation's folder was made");
        assert_eq!(shell.config_files(), ["connection.json"]);
        drop(shell);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(path.bin());
    }

    /// The organisation picked in the app is kept beside the address, told back to the page, and
    /// gone at sign-out. Sign-out forgets the saved sign-in and keeps the address; back on this
    /// computer the choice is local, with the address still remembered for another time.
    #[test]
    fn the_organisation_is_kept_then_cleared_at_sign_out_and_the_address_stays() {
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
                "organizationId": null,
                "signedIn": false
            })
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
            serde_json::json!({ "mode": "local", "address": null, "organizationId": null })
        );
        // Nothing token-shaped was ever written beside the choice.
        assert_eq!(shell.config_files(), ["connection.json"]);
        let written = std::fs::read_to_string(shell.config.join("connection.json")).unwrap();
        assert!(!written.contains("obr_") && !written.contains("oba_"), "{written}");
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
        assert_eq!(kept.organization_id, None);
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
    /// other menu tests are: AppKit's menus cannot be built here.
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
            for absent in ["\"status\"", "\"logs\"", "\"state\"", "\"stop\""] {
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
        assert!(chosen
            .contains("\"stop\" | \"status\" | \"logs\" if desktop_connected::is_connected(app) => {}"));
    }
}
