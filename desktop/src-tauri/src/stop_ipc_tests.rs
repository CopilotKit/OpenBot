// Included by main.rs so these regressions exercise its registered command and lifecycle state.
mod stop_ipc {
    use super::*;
    use std::sync::{atomic::Ordering::SeqCst, mpsc};
    use std::time::{Duration, Instant};
    use tauri::Listener;

    const DEADLINE: Duration = Duration::from_secs(5);

    struct Fixture {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::WebviewWindow<tauri::test::MockRuntime>,
        root: PathBuf,
        path: SerializedPath,
    }

    impl Fixture {
        fn new() -> Self {
            // Every caller uses isolated_process, so the runtime starts fresh in this child.
            // One async worker makes blocking that worker observable independently of IPC return.
            std::env::set_var("TOKIO_WORKER_THREADS", "1");
            let path = SerializedPath::set_only_with("docker", "stop-ipc");
            let root = temp_root("stop-ipc");
            std::fs::create_dir_all(root.join(".logs")).unwrap();
            std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", root.join("commands.log"));
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .invoke_handler(tauri::generate_handler![stop_stack])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            *app.state::<Shell>().root.lock().unwrap() = Some(root.clone());
            *app.state::<Shell>().containers.lock().unwrap() = Some(ContainerDeployment {
                root: root.clone(),
                address: engine::Address::new(engine::Engine::Docker, None),
            });
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            Self {
                app,
                window,
                root,
                path,
            }
        }

        fn compose_barrier(&self) -> std::net::TcpListener {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            std::fs::write(
                self.root.join("stop-barrier-address"),
                listener.local_addr().unwrap().to_string(),
            )
            .unwrap();
            listener
        }

        fn dispatch(&self) -> Dispatch {
            let (sent, response) = mpsc::channel();
            let (event, progressed) = mpsc::channel();
            self.app.listen("stop-ipc-progress", move |_| {
                event.send(()).unwrap();
            });
            let window = self.window.clone();
            // Active-root precedence must keep this deliberately different caller root unused.
            let fallback = self
                .root
                .join("unused-fallback")
                .to_string_lossy()
                .into_owned();
            let thread = std::thread::spawn(move || {
                window.as_ref().clone().on_message(
                    tauri::webview::InvokeRequest {
                        cmd: "stop_stack".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: if cfg!(any(windows, target_os = "android")) {
                            "http://tauri.localhost"
                        } else {
                            "tauri://localhost"
                        }
                        .parse()
                        .unwrap(),
                        body: tauri::ipc::InvokeBody::Json(serde_json::json!({"root":fallback})),
                        headers: Default::default(),
                        invoke_key: tauri::test::INVOKE_KEY.into(),
                    },
                    Box::new(move |_, _, result, _, _| {
                        let result = match result {
                            tauri::ipc::InvokeResponse::Ok(body) => body
                                .deserialize::<serde_json::Value>()
                                .map_err(|e| serde_json::json!(e.to_string())),
                            tauri::ipc::InvokeResponse::Err(error) => Err(error.0),
                        };
                        sent.send(result).unwrap();
                    }),
                );
                // This runs on the same mock dispatch thread, after the real generated handler.
                window.app_handle().emit("stop-ipc-progress", ()).unwrap();
            });
            Dispatch {
                response,
                progressed,
                thread,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).expect("remove owned Stop fixture");
            std::fs::remove_dir_all(self.path.bin()).expect("remove owned fake engine");
        }
    }

    struct Dispatch {
        response: mpsc::Receiver<Result<serde_json::Value, serde_json::Value>>,
        progressed: mpsc::Receiver<()>,
        thread: std::thread::JoinHandle<()>,
    }

    impl Dispatch {
        fn finish(self) -> Result<serde_json::Value, serde_json::Value> {
            let result = self
                .response
                .recv_timeout(DEADLINE)
                .expect("Stop IPC response");
            self.thread.join().unwrap();
            result
        }
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + DEADLINE;
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "Stop did not reach the controlled boundary"
            );
            std::thread::yield_now();
        }
    }

    fn await_compose(listener: &std::net::TcpListener) -> std::net::TcpStream {
        let mut stream = None;
        wait_until(|| match listener.accept() {
            Ok((accepted, _)) => {
                stream = Some(accepted);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
            Err(error) => panic!("owned Compose barrier failed: {error}"),
        });
        stream.unwrap()
    }

    fn release_compose(listener: &std::net::TcpListener, result: u8, dispatch: &Dispatch) {
        let mut stream = await_compose(listener);
        let pending = matches!(dispatch.response.try_recv(), Err(mpsc::TryRecvError::Empty));
        let runtime_progressed = async_runtime_progresses();
        stream.write_all(&[result]).unwrap();
        assert!(pending, "Stop resolved before Compose finished");
        assert!(
            runtime_progressed,
            "Compose blocked the async runtime worker"
        );
    }

    /// The app's own logger, writing into a folder of its own for the rest of this process, and
    /// the file it writes. Only in an isolated process: a process has one logger.
    fn log_to_a_file() -> PathBuf {
        let folder = temp_root("stop-log");
        let app = tauri::test::mock_app();
        let (_, level, logger) = logging::builder(
            tauri_plugin_log::TargetKind::Folder {
                path: folder.clone(),
                file_name: Some(logging::FILE_NAME.into()),
            },
            logging::MAX_FILE_BYTES,
            logging::KEPT_FILES,
        )
        .split(app.handle())
        .expect("the logger builds");
        log::set_boxed_logger(logger).expect("nothing else logs in this process");
        log::set_max_level(level);
        folder.join(format!("{}.log", logging::FILE_NAME))
    }

    /// The log's entries without their timestamps: `INFO  [stop] finished in 3.1s`.
    fn entries(file: &Path) -> Vec<String> {
        std::fs::read_to_string(file)
            .unwrap()
            .lines()
            .filter_map(|line| line.split_once(' ').map(|(_, entry)| entry.to_owned()))
            .collect()
    }

    /// Where `wanted` first is in `entries`, or a failure that shows the whole log.
    fn position(entries: &[String], wanted: impl Fn(&str) -> bool, what: &str) -> usize {
        entries
            .iter()
            .position(|entry| wanted(entry))
            .unwrap_or_else(|| panic!("no {what} in the log:\n{}", entries.join("\n")))
    }

    /// Stop's own two entries bracket the work: who asked and where, the engine's commands, then
    /// how Stop ended and how long it took. The same as Start, whichever way Stop was asked.
    fn assert_stop_logged(file: &Path, root: &Path, from: &str) {
        let entries = entries(file);
        let folder = root.file_name().unwrap().to_string_lossy().into_owned();
        let asked = position(
            &entries,
            |entry| {
                entry.starts_with("INFO  [stop] asked in ")
                    && entry.ends_with(&format!("{folder} {from}"))
            },
            &format!("[stop] asked line ending \"{folder} {from}\""),
        );
        let down = position(
            &entries,
            |entry| entry.starts_with("INFO  [compose down] finished in "),
            "[compose down] line",
        );
        let took = regex::Regex::new(r"^INFO  \[stop\] finished in \d+\.\ds$").unwrap();
        let finished = position(
            &entries,
            |entry| took.is_match(entry),
            "[stop] finished line",
        );
        assert!(
            asked < down && down < finished,
            "out of order:\n{}",
            entries.join("\n")
        );
    }

    /// Settings > This computer's Stop on Windows logged only the menu's own lines and the engine's
    /// commands: no `[stop]` entry, so no outcome or duration for the Stop somebody pressed.
    #[test]
    fn stop_from_settings_logs_who_asked_how_it_ended_and_how_long_it_took() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_from_settings_logs_who_asked_how_it_ended_and_how_long_it_took",
        ) {
            return;
        }
        let log = log_to_a_file();
        let fixture = Fixture::new();
        let setup = "tauri://localhost/settings-stop";
        *fixture.app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.into());
        let compose = fixture.compose_barrier();

        // The command Settings > This computer invokes.
        tauri::async_runtime::block_on(desktop_page::stop(fixture.app.handle().clone()));
        await_compose(&compose).write_all(&[0]).unwrap();
        wait_until(|| fixture.window.url().unwrap().as_str() == setup);

        assert_stop_logged(&log, &fixture.root, "from Settings");
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    /// Quit stops everything too, and logged only its screen's rows.
    #[test]
    fn stop_by_quit_logs_who_asked_how_it_ended_and_how_long_it_took() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_by_quit_logs_who_asked_how_it_ended_and_how_long_it_took",
        ) {
            return;
        }
        let log = log_to_a_file();
        let fixture = Fixture::new();
        let compose = fixture.compose_barrier();

        let app = fixture.app.handle().clone();
        let quitting = std::thread::spawn(move || quit_cleanup_shown(&app));
        await_compose(&compose).write_all(&[0]).unwrap();
        assert_eq!(quitting.join().unwrap(), Vec::<String>::new());

        assert_stop_logged(&log, &fixture.root, "by Quit");
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    /// Restart is asked from Settings and from the Status window, and its entry says which. Show
    /// says it was asked, as every other action does, before how it ended.
    #[test]
    fn restart_and_show_log_who_asked_and_how_they_ended() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::restart_and_show_log_who_asked_and_how_they_ended",
        ) {
            return;
        }
        let log = log_to_a_file();
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        // Nothing running, so both end at once, and say why.
        tauri::async_runtime::block_on(desktop_page::restart(app.handle().clone()))
            .expect_err("nothing to restart");
        tauri::async_runtime::block_on(show_openbot(app.handle().clone()))
            .expect_err("nothing to show");

        let entries = entries(&log);
        let failed = |tag: &str| {
            let failed = regex::Regex::new(&format!(r"^ERROR \[{tag}\] failed after \d+\.\ds: "))
                .unwrap();
            move |entry: &str| failed.is_match(entry)
        };
        let asked = position(
            &entries,
            |entry| entry == "INFO  [restart] asked from Settings",
            "[restart] asked from Settings",
        );
        let ended = position(&entries, failed("restart"), "[restart] failed line");
        assert!(asked < ended, "{}", entries.join("\n"));
        let asked = position(
            &entries,
            |entry| entry == "INFO  [show] asked",
            "[show] asked",
        );
        let ended = position(&entries, failed("show"), "[show] failed line");
        assert!(asked < ended, "{}", entries.join("\n"));
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    fn async_runtime_progresses() -> bool {
        let (sent, received) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = sent.send(());
        });
        received.recv_timeout(Duration::from_millis(200)).is_ok()
    }

    #[test]
    fn stop_ipc_returns_to_dispatch_while_cleanup_is_blocked() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_ipc_returns_to_dispatch_while_cleanup_is_blocked",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let compose = fixture.compose_barrier();
        let shell = fixture.app.state::<Shell>();
        // The first lock host cleanup takes; held here, it keeps that cleanup waiting.
        let cleanup = shell.host_access.lock().unwrap();
        let dispatch = fixture.dispatch();
        wait_until(|| shell.generation.load(SeqCst) == 1);
        // Always release both barriers before asserting against the old synchronous command.
        let event_progressed = dispatch
            .progressed
            .recv_timeout(Duration::from_millis(200))
            .is_ok();
        let runtime_progressed = async_runtime_progresses();
        let cleanup_pending =
            matches!(dispatch.response.try_recv(), Err(mpsc::TryRecvError::Empty));
        drop(cleanup);
        release_compose(&compose, 0, &dispatch);
        let response = dispatch.finish();
        assert!(
            event_progressed,
            "generated Stop IPC blocked its dispatch thread during cleanup"
        );
        assert!(
            runtime_progressed,
            "host cleanup blocked the async runtime worker"
        );
        assert!(
            cleanup_pending,
            "Stop resolved before host cleanup finished"
        );
        assert_eq!(response.unwrap(), serde_json::Value::Null);
        assert!(shell.root.lock().unwrap().is_none());
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&fixture.root)
        );
        assert_compose_down_ran_under(&fixture.root.join("commands.log"), &fixture.root);
    }

    #[test]
    fn stop_ipc_preserves_cleanup_and_compose_errors() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_ipc_preserves_cleanup_and_compose_errors",
        ) {
            return;
        }
        let fixture = Fixture::new();
        std::fs::write(
            stack::host_pids_path(&fixture.root),
            "invalid ownership json",
        )
        .unwrap();
        let compose = fixture.compose_barrier();
        let dispatch = fixture.dispatch();
        release_compose(&compose, 71, &dispatch);
        let error = dispatch.finish().unwrap_err();
        let error = error.as_str().unwrap();
        assert!(error.contains("host-pids.json"), "{error}");
        assert!(error.contains("Compose down failed:"), "{error}");
        assert!(error.contains("synthetic Compose refusal"), "{error}");
        assert_eq!(
            fixture.app.state::<Shell>().root.lock().unwrap().as_ref(),
            Some(&fixture.root)
        );
        assert_eq!(
            std::fs::read_to_string(stack::host_pids_path(&fixture.root)).unwrap(),
            "invalid ownership json"
        );
    }

    #[test]
    fn stop_ipc_cancels_start_before_waiting_for_its_side_effect() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_ipc_cancels_start_before_waiting_for_its_side_effect",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let compose = fixture.compose_barrier();
        let shell = fixture.app.state::<Shell>();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let startup = attempt.lock_current().unwrap();
        let dispatch = fixture.dispatch();
        wait_until(|| attempt.require_current().is_err());
        let cancelled = attempt.require_current().is_err();
        let pending = matches!(dispatch.response.try_recv(), Err(mpsc::TryRecvError::Empty));
        drop(startup);
        release_compose(&compose, 0, &dispatch);
        assert_eq!(dispatch.finish().unwrap(), serde_json::Value::Null);
        assert!(
            cancelled,
            "Stop must retire Start before waiting for its lock"
        );
        assert!(
            pending,
            "Stop finished while Start still held the side-effect lock"
        );
        let error = attempt
            .lock_current()
            .expect_err("a cancelled Start resumed a side effect");
        assert_eq!(error.said, StartAttempt::cancelled().said);
        assert!(shell.root.lock().unwrap().is_none());
    }

    #[test]
    fn menu_stop_retains_failure_for_setup_after_navigation() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::menu_stop_retains_failure_for_setup_after_navigation",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let setup = "tauri://localhost/menu-stop-failure";
        *fixture.app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.into());
        let compose = fixture.compose_barrier();

        stop_from_menu(fixture.app.handle().clone(), AskedFrom::Menu);
        await_compose(&compose).write_all(&[71]).unwrap();

        let shell = fixture.app.state::<Shell>();
        wait_until(|| fixture.window.url().unwrap().as_str() == setup);
        assert_compose_down_ran_under(&fixture.root.join("commands.log"), &fixture.root);
        let problem = last_failure_now(fixture.app.handle())
            .expect("menu Stop failure should be retained for setup");
        assert_eq!(
            problem.said,
            "OpenBot could not finish stopping. Try Stop OpenBot again."
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("Compose down failed:")
                    && detail.contains("synthetic Compose refusal")),
            "{problem:?}"
        );
        assert!(last_failure_now(fixture.app.handle()).is_none());
        assert!(
            recovery_required(&shell, &fixture.root),
            "reading the retained notice must not clear recovery-required state"
        );
    }

    #[test]
    fn successful_menu_stop_leaves_no_retained_failure_or_recovery_marker() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::successful_menu_stop_leaves_no_retained_failure_or_recovery_marker",
        ) {
            return;
        }
        let fixture = Fixture::new();
        std::fs::write(
            fixture.root.join(".openbot-prepared.json"),
            "completed preparation",
        )
        .unwrap();
        preparation::record_launch(&fixture.root, None).unwrap();
        // A launch is offered only with its local Intelligence stack; a shared one is never stopped.
        local_eval_state::begin(
            &fixture.root,
            &local_eval::StackId::parse("local-abc123").unwrap(),
            local_eval_state::Ownership::Shared,
            LOCAL_EVAL_PIN,
        )
        .unwrap();
        let configured = || {
            already_configured(
                fixture.app.handle().clone(),
                fixture.root.to_string_lossy().into_owned(),
            )
        };
        assert!(configured().launch.is_some());
        let setup = "tauri://localhost/menu-stop-success";
        *fixture.app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.into());
        let compose = fixture.compose_barrier();
        stop_from_menu(fixture.app.handle().clone(), AskedFrom::Menu);
        await_compose(&compose).write_all(&[0]).unwrap();

        wait_until(|| fixture.window.url().unwrap().as_str() == setup);
        assert_compose_down_ran_under(&fixture.root.join("commands.log"), &fixture.root);
        let shell = fixture.app.state::<Shell>();
        assert!(last_failure_now(fixture.app.handle()).is_none());
        assert!(!recovery_required(&shell, &fixture.root));
        let stopped = configured();
        assert!(stopped.launch.is_some(), "Stop retains the installed setup");
        assert!(!stopped.auto_start, "Stop must survive setup reloading");
        let reopened = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let resumed = already_configured(
            reopened.handle().clone(),
            fixture.root.to_string_lossy().into_owned(),
        );
        assert!(resumed.launch.is_some());
        assert!(
            resumed.auto_start,
            "a fresh app session may resume the saved installation"
        );
    }

    /// Settings' Change on the AI model row: OpenBot stops, the window goes to setup, and setup
    /// is told once to open at its AI screen. A Stop that failed tells it nothing: OpenBot may
    /// still be running, and setup shows the failure with Start, as after any failed Stop.
    #[test]
    fn change_ai_connection_from_settings_stops_then_opens_the_ai_screen_once() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::change_ai_connection_from_settings_stops_then_opens_the_ai_screen_once",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let setup = "tauri://localhost/change-ai-connection";
        *fixture.app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.into());
        let compose = fixture.compose_barrier();

        change_ai_connection_from_settings(fixture.app.handle().clone());
        // Nothing to open at until OpenBot has stopped.
        assert!(!take_ai_connection_change(fixture.app.handle().clone()));
        await_compose(&compose).write_all(&[0]).unwrap();

        wait_until(|| fixture.window.url().unwrap().as_str() == setup);
        assert_compose_down_ran_under(&fixture.root.join("commands.log"), &fixture.root);
        assert!(take_ai_connection_change(fixture.app.handle().clone()));
        assert!(
            !take_ai_connection_change(fixture.app.handle().clone()),
            "a later visit to setup opens at Start"
        );
    }

    #[test]
    fn change_ai_connection_after_a_failed_stop_opens_setup_as_usual() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::change_ai_connection_after_a_failed_stop_opens_setup_as_usual",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let setup = "tauri://localhost/change-ai-connection-failed";
        *fixture.app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.into());
        let compose = fixture.compose_barrier();

        change_ai_connection_from_settings(fixture.app.handle().clone());
        await_compose(&compose).write_all(&[71]).unwrap();

        wait_until(|| fixture.window.url().unwrap().as_str() == setup);
        assert!(!take_ai_connection_change(fixture.app.handle().clone()));
        assert!(last_failure_now(fixture.app.handle()).is_some());
    }

    #[test]
    fn stop_ipc_reports_shutdown_worker_panics() {
        if crate::test_support::isolated_process(
            "tests::stop_ipc::stop_ipc_reports_shutdown_worker_panics",
        ) {
            return;
        }
        let fixture = Fixture::new();
        let shell = fixture.app.state::<Shell>();
        // A poisoned cleanup lock is a real panic boundary; it must reject IPC, not abandon it.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _cleanup = shell.host_access.lock().unwrap();
            panic!("synthetic cleanup lock poisoning");
        }))
        .expect_err("poison the cleanup lock");
        let error = fixture.dispatch().finish().unwrap_err();
        let error = error.as_str().unwrap();
        assert!(error.starts_with("the shutdown did not run:"), "{error}");
        assert!(error.contains("panicked"), "{error}");
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&fixture.root));
        assert!(
            !fixture.root.join("commands.log").exists(),
            "panic must precede engine access"
        );
    }
}
