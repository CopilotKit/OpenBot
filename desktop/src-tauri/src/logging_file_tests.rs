// Included by main.rs: the log file written by the real logger. These build a mock app for the
// plugin's logger, and only the app binary carries the Windows manifest such an app needs to load
// (a library test that made one stopped with STATUS_ENTRYPOINT_NOT_FOUND on Windows).
mod logging_file {
    use super::*;
    use crate::test_support::temp_root;
    use logging::{FILE_NAME, KEPT_FILES, MAX_FILE_BYTES};
    use tauri_plugin_log::TargetKind;

    /// A logger exactly as the app builds it, but writing into `folder`.
    fn logger_in(folder: &Path, max_file_bytes: u64, kept_files: usize) -> Box<dyn log::Log> {
        let app = tauri::test::mock_app();
        let (_, _, logger) = logging::builder(
            TargetKind::Folder {
                path: folder.to_path_buf(),
                file_name: Some(FILE_NAME.into()),
            },
            max_file_bytes,
            kept_files,
        )
        .split(app.handle())
        .expect("the logger builds");
        logger
    }

    fn info(logger: &dyn log::Log, target: &str, message: &str) {
        logger.log(
            &log::Record::builder()
                .level(log::Level::Info)
                .target(target)
                .args(format_args!("{message}"))
                .build(),
        );
    }

    fn current(folder: &Path) -> String {
        std::fs::read_to_string(folder.join(format!("{FILE_NAME}.log"))).unwrap()
    }

    fn set_aside(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name != &format!("{FILE_NAME}.log"))
            .collect();
        names.sort();
        names
    }

    // Built at run time, so no key-shaped literal sits in the source for a scanner to stop.
    fn fake(prefix: &str, body: &str, times: usize) -> String {
        format!("{prefix}{}", body.repeat(times))
    }

    #[test]
    fn a_line_lands_in_the_file_with_a_timestamp_and_its_level() {
        let folder = temp_root("log-line");
        let logger = logger_in(&folder, MAX_FILE_BYTES, KEPT_FILES);
        info(
            logger.as_ref(),
            "openbot_desktop",
            "[start] Start finished in 41.2s",
        );
        logger.log(
            &log::Record::builder()
                .level(log::Level::Warn)
                .target("openbot_desktop_lib::stack")
                .args(format_args!(
                    "[compose] up failed (exit status: 1)\nport is already allocated"
                ))
                .build(),
        );
        let written = current(&folder);
        let lines: Vec<&str> = written.lines().collect();
        let stamp = regex::Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z ").unwrap();
        assert_eq!(lines.len(), 3, "{written}");
        assert!(stamp.is_match(lines[0]), "{}", lines[0]);
        assert!(
            lines[0].ends_with(" INFO  [start] Start finished in 41.2s"),
            "{}",
            lines[0]
        );
        assert!(stamp.is_match(lines[1]), "{}", lines[1]);
        assert!(
            lines[1].ends_with(" WARN  [compose] up failed (exit status: 1)"),
            "{}",
            lines[1]
        );
        // The rest of a message stays under it, so every entry starts with its time.
        assert_eq!(lines[2], "    port is already allocated");
        let _ = std::fs::remove_dir_all(folder);
    }

    /// Another crate's information is noise; its warnings are kept and say whose they are.
    #[test]
    fn other_crates_keep_only_their_warnings() {
        let folder = temp_root("log-levels");
        let logger = logger_in(&folder, MAX_FILE_BYTES, KEPT_FILES);
        info(
            logger.as_ref(),
            "reqwest::connect",
            "starting new connection",
        );
        logger.log(
            &log::Record::builder()
                .level(log::Level::Warn)
                .target("tauri::manager")
                .args(format_args!("asset not found"))
                .build(),
        );
        let written = current(&folder);
        assert!(!written.contains("starting new connection"), "{written}");
        assert!(
            written.contains(" WARN  tauri::manager: asset not found"),
            "{written}"
        );
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_key_or_token_in_a_line_is_redacted_in_the_file() {
        let folder = temp_root("log-redact");
        let logger = logger_in(&folder, MAX_FILE_BYTES, KEPT_FILES);
        let key = fake("sk-ant-api03-", "Ab3_", 20);
        let token = fake("", "Zq9x", 10);
        info(
            logger.as_ref(),
            "openbot_desktop_lib::stack",
            &format!("[compose] up failed: invalid value in OPENAI_API_KEY={key} for server"),
        );
        info(
            logger.as_ref(),
            "openbot_desktop",
            &format!("[watch] refused: Authorization: Bearer {token}"),
        );
        let written = current(&folder);
        assert!(!written.contains(&key), "{written}");
        assert!(!written.contains(&token), "{written}");
        assert!(
            written.contains("OPENAI_API_KEY=[redacted] for server"),
            "{written}"
        );
        assert!(written.contains("Bearer [redacted]"), "{written}");
        let _ = std::fs::remove_dir_all(folder);
    }

    /// The folder never holds more than the current file and `kept` set-aside ones, the oldest
    /// going first, whatever earlier sessions left there.
    #[test]
    fn rotation_keeps_the_folder_under_its_cap() {
        let folder = temp_root("log-rotate");
        std::fs::create_dir_all(&folder).unwrap();
        // Five set aside by earlier sessions.
        for second in 1..=5 {
            std::fs::write(
                folder.join(format!("{FILE_NAME}_2000-01-01_00-00-0{second}.log")),
                "old\n",
            )
            .unwrap();
        }
        let max = 4_000;
        let kept = 2;
        let logger = logger_in(&folder, max, kept);
        // Opening the log already trims what earlier sessions left to `kept`.
        assert_eq!(
            set_aside(&folder),
            [
                format!("{FILE_NAME}_2000-01-01_00-00-04.log"),
                format!("{FILE_NAME}_2000-01-01_00-00-05.log"),
            ]
        );
        // About one and a half files' worth (each line is 132 bytes): one rotation.
        let entry = format!("[compose] pulled {}", "image ".repeat(14));
        for _ in 0..45 {
            info(logger.as_ref(), "openbot_desktop_lib::stack", &entry);
        }
        let aside = set_aside(&folder);
        assert_eq!(aside.len(), kept, "{aside:?}");
        assert_eq!(aside[0], format!("{FILE_NAME}_2000-01-01_00-00-05.log"));
        assert!(
            !aside[1].starts_with(&format!("{FILE_NAME}_2000-01-01")),
            "{aside:?}"
        );
        let mut total = 0;
        for name in aside.iter().chain([&format!("{FILE_NAME}.log")]) {
            let size = std::fs::metadata(folder.join(name)).unwrap().len();
            assert!(size <= max, "{name} is {size} bytes");
            total += size;
        }
        assert!(total <= max * (kept as u64 + 1));
        assert!(!current(&folder).is_empty());
        let _ = std::fs::remove_dir_all(folder);
    }
}
