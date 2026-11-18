// Included by main.rs: the security floor through the shell's own commands. What the window is
// told (`security_floor`, which `desktop/src/SecurityFloor.tsx` asks), and that Start refuses below
// it. Verifying, keeping and reading the floor are tested in the library (`security_floor`).
mod security_floor_ipc {
    use super::*;
    use openbot_desktop_lib::connected::{choice, credentials};
    use std::collections::BTreeMap;

    const SETUP: &str = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    const CLOUD: &str = "https://cloud.openbot.example";
    const COMPANY: &str = "https://openbot.acme.example";

    struct Fixture {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::WebviewWindow<tauri::test::MockRuntime>,
        config: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .invoke_handler(tauri::generate_handler![security_floor, start_stack])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            *app.state::<Shell>().setup_url.lock().unwrap() = Some(SETUP.into());
            // A configuration folder of the test's own: on this computer unless a test says.
            let config = temp_root(&format!("security-floor-config-{label}"));
            std::fs::create_dir_all(&config).unwrap();
            let store = credentials::Store::of(keyring_core::mock::Store::new().unwrap());
            desktop_connected::use_for_test(app.handle(), config.clone(), store);
            let root = temp_root(&format!("security-floor-root-{label}"));
            std::fs::create_dir_all(&root).unwrap();
            Self {
                app,
                window,
                config,
                root,
            }
        }

        fn connect_to(&self, address: &str) {
            choice::write(
                &self.config,
                &choice::Choice {
                    mode: choice::Mode::Connected,
                    address: Some(address.into()),
                    organization_id: None,
                },
            )
            .unwrap();
        }

        /// A floor as the shell keeps one once it has verified it.
        fn floor(&self, desktop: &semver::Version, backend: &semver::Version) {
            let floors = BTreeMap::from([
                ("desktop".to_string(), desktop.clone()),
                ("backend".to_string(), backend.clone()),
            ]);
            self.app
                .state::<Shell>()
                .security_floor
                .record(Some(security_floor::Floor {
                    serial: 1,
                    floors,
                    cloud: vec![CLOUD.into()],
                }));
        }

        fn ask(
            &self,
            cmd: &str,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, serde_json::Value> {
            tauri::test::get_ipc_response(
                &self.window,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: SETUP.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize().unwrap())
        }

        fn blocked(&self) -> bool {
            self.ask("security_floor", serde_json::json!({})).unwrap()["blocked"] == true
        }

        fn start(&self) -> Result<serde_json::Value, serde_json::Value> {
            self.ask(
                "start_stack",
                serde_json::json!({
                    "root": self.root, "apiUrl": "https://intelligence.example.test",
                    "gatewayWsUrl": "wss://gateway.example.test",
                    "model": {"provider": "openai-compatible", "login": "endpoint", "baseUrl": "http://127.0.0.1:11434/v1", "model": "synthetic-model", "apiKey": ""},
                    "harness": null,
                }),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.config);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The app's version, as the shell reads it.
    fn this_app(fixture: &Fixture) -> semver::Version {
        fixture.app.package_info().version.clone()
    }

    fn next_patch(fixture: &Fixture) -> semver::Version {
        let mut next = this_app(fixture);
        next.patch += 1;
        next.pre = semver::Prerelease::EMPTY;
        next
    }

    /// The release this app lays out for its back end.
    fn own() -> semver::Version {
        let own = upgrade::own().version;
        semver::Version::parse(own.strip_prefix('v').unwrap_or(&own)).unwrap()
    }

    fn refusal(answer: Result<serde_json::Value, serde_json::Value>) -> String {
        answer
            .expect_err("Start refuses below the security floor")
            .to_string()
    }

    /// Below the floor the window is told to show the notice alone, and Start refuses, so the
    /// back end on this computer stays stopped. At the floor, nothing changes.
    #[test]
    fn below_the_floor_the_notice_shows_and_start_refuses() {
        let fixture = Fixture::new("below");
        assert!(!fixture.blocked(), "no floor verified yet: the app runs");
        fixture.floor(&next_patch(&fixture), &own());
        assert!(fixture.blocked());
        assert!(refusal(fixture.start()).contains(SECURITY_FLOOR_SAID));
        // A floor at this app's own release lets it run.
        let at = Fixture::new("at");
        at.floor(&this_app(&at), &own());
        assert!(!at.blocked());
    }

    /// Connected to a company's own OpenBot, the floor is not for this app. Connected to an
    /// OpenBot Cloud address the floor lists, it is.
    #[test]
    fn a_company_server_ignores_the_floor_and_a_listed_cloud_follows_it() {
        let company = Fixture::new("company");
        company.floor(&next_patch(&company), &own());
        company.connect_to(COMPANY);
        assert!(!company.blocked());
        let cloud = Fixture::new("cloud");
        cloud.floor(&next_patch(&cloud), &own());
        cloud.connect_to(CLOUD);
        assert!(cloud.blocked());
    }

    /// The app is safe but the back end laid out here is below its floor: Start refuses to run it
    /// as it is. Start upgrades it to the app's own release first (`upgrade_due`).
    #[test]
    fn a_back_end_below_its_floor_never_starts_as_it_is() {
        let fixture = Fixture::new("backend");
        fixture.floor(&this_app(&fixture), &own());
        deployment::record(&fixture.root, "v1.0.0", false).unwrap();
        assert!(!fixture.blocked(), "the app itself is at its floor");
        assert!(refusal(fixture.start()).contains(SECURITY_FLOOR_SAID));
    }
}
