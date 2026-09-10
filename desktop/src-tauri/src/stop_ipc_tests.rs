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

    fn release_compose(listener: &std::net::TcpListener, result: u8, dispatch: &Dispatch) {
        let mut stream = None;
        wait_until(|| match listener.accept() {
            Ok((accepted, _)) => {
                stream = Some(accepted);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
            Err(error) => panic!("owned Compose barrier failed: {error}"),
        });
        let pending = matches!(dispatch.response.try_recv(), Err(mpsc::TryRecvError::Empty));
        let runtime_progressed = async_runtime_progresses();
        stream.unwrap().write_all(&[result]).unwrap();
        assert!(pending, "Stop resolved before Compose finished");
        assert!(
            runtime_progressed,
            "Compose blocked the async runtime worker"
        );
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
        let cleanup = shell.children.lock().unwrap();
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
        let error = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.root,
            &fixture.root.join(".logs"),
            Path::new("must-not-launch"),
            &stack::Secrets::new(),
            |_| panic!("cancelled Start published a child"),
            |_| panic!("cancelled Start reached readiness"),
        ))
        .unwrap_err();
        assert_eq!(error.said, StartAttempt::cancelled().said);
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
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
            let _cleanup = shell.children.lock().unwrap();
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
