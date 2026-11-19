use std::io::{Read, Write};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // Production Start pins a global runtime selector before any Compose commands.
    if args
        .first()
        .is_some_and(|arg| ["--context", "--host", "--connection", "--url"].contains(&arg.as_str()))
    {
        args.drain(..2);
    } else if args.first().map(String::as_str) == Some("--remote=false") {
        args.remove(0);
    }
    let joined = args.join(" ");
    if SCENARIO == "runtime" {
        assert_eq!(joined, "--version", "launch must not install dependencies");
        println!("1.4.3");
        return;
    }
    // An image the test says this engine does not have, until something pulls it. Every other
    // image is here.
    let missing = std::env::var("OPENBOT_TEST_ENGINE_MISSING_IMAGE").ok();
    let pulled_record = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD")
        .map(|record| std::path::PathBuf::from(format!("{}.pulled", record.to_string_lossy())));
    let pulled = |image: &str| {
        pulled_record.as_ref().is_some_and(|path| {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .any(|line| line == image)
        })
    };
    if let Some(image) = joined.strip_prefix("image inspect ") {
        if missing.as_deref() == Some(image) && !pulled(image) {
            eprintln!("Error: No such image: {image}");
            std::process::exit(1);
        }
        return;
    }
    if SCENARIO == "installation-boundary" {
        if joined.contains(" up ") || joined.contains(" run ") {
            if !args.windows(2).any(|pair| pair == ["--pull", "never"]) {
                eprintln!("launch may implicitly pull an uninstalled image: {joined}");
                std::process::exit(61);
            }
            return;
        }
        eprintln!("unexpected installation boundary command: {joined}");
        std::process::exit(62);
    }
    if joined == "context show" {
        println!("fixture");
        return;
    }
    if let Some(path) = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD") {
        let cwd = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(log, "{}\t{}", cwd.display(), joined).unwrap();
    }
    // The `server` container's environment, as Compose gives it one. A container takes `.env` (the
    // Compose file's `env_file`), and the host token and encryption key Compose was handed, when it
    // is created, and keeps them until it is created again: `restart` changes none of it. `up`
    // creates it when there is none, when `.env` changed since (a changed configuration), and always
    // with `--force-recreate`. `server-env` in the installation holds what the running server has,
    // the two credentials by their length only. Every other command succeeds and says nothing.
    if SCENARIO == "server-env" {
        if args.first().map(String::as_str) == Some("compose")
            && args.iter().any(|arg| arg == "up")
            && args.iter().any(|arg| arg == "server")
        {
            let env = std::fs::read_to_string(".env").unwrap_or_default();
            let made_from = std::fs::read_to_string(".fixture-server-made-from").ok();
            let recreate = args.iter().any(|arg| arg == "--force-recreate");
            if recreate || made_from.as_deref() != Some(env.as_str()) {
                let length = |name: &str| std::env::var(name).unwrap_or_default().len();
                std::fs::write(".fixture-server-made-from", &env).unwrap();
                std::fs::write(
                    "server-env",
                    format!(
                        "{env}host-token-length={}\nencryption-key-length={}\n",
                        length("OPENBOT_DESKTOP_HOST_TOKEN"),
                        length("KEY_ENCRYPTION_KEY"),
                    ),
                )
                .unwrap();
            }
        }
        return;
    }
    if SCENARIO == "compose-provider" {
        println!("Docker Compose version disposable-provider");
        return;
    }
    // Fresh startup checks the selected Compose database volume before generating a key.
    // These scenarios model an empty database; cleanup's explicit -f config stays separate.
    if joined == "compose config --format json" {
        println!(
            "{}",
            r#"{"services":{"postgres":{"volumes":[{"type":"volume","source":"postgres-data","target":"/var/lib/postgresql/data"}]}},"volumes":{"postgres-data":{"name":"fixture_postgres-data"}}}"#
        );
        return;
    }
    if joined == "volume ls --format {{.Name}}" {
        return;
    }
    if SCENARIO == "podman" {
        match joined.as_str() {
            "version --format {{.Server.APIVersion}}" => println!("1.44"),
            "info --format {{.Host.ServiceIsRemote}}" => println!("false"),
            "compose version" => {
                let status = std::process::Command::new(if cfg!(windows) {
                    "docker-compose.exe"
                } else {
                    "docker-compose"
                })
                .arg("version")
                .status();
                std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
            }
            _ => std::process::exit(2),
        }
        return;
    }
    if SCENARIO == "shutdown" {
        if joined.contains("config --format json") {
            println!(
                "{}",
                r#"{"services":{"supervisor":{"environment":{"COMPUTER_NAMESPACE":"openbot"}}}}"#
            );
        }
        return;
    }
    if SCENARIO == "stop-ipc" && joined.contains("config --format json") {
        println!("{{\"services\":{{\"supervisor\":{{\"environment\":{{\"COMPUTER_NAMESPACE\":\"stop-ipc\"}}}}}}}}");
        return;
    }
    if SCENARIO == "stop-ipc" && (joined.starts_with("ps ") || joined.contains("stop supervisor")) {
        return;
    }
    if SCENARIO == "stop-ipc" && joined == "compose -f docker-compose.yml --profile harness --profile openbot down" {
        let mut barrier = std::net::TcpStream::connect(
            std::fs::read_to_string("stop-barrier-address")
                .unwrap()
                .trim(),
        )
        .unwrap();
        barrier
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut result = [0];
        barrier.read_exact(&mut result).unwrap();
        if result[0] != 0 {
            eprintln!("synthetic Compose refusal");
            std::process::exit(71);
        }
        return;
    }
    if args.first().map(String::as_str) == Some("version") {
        println!("1.44");
        return;
    }
    match joined.as_str() {
        "compose version" => println!("Docker Compose synthetic"),
        // A pull of the image this engine is missing puts it here.
        value if missing.as_deref().is_some_and(|image| value == format!("pull {image}")) => {
            let path = pulled_record.as_ref().expect("a pull is recorded");
            let mut done = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(done, "{}", missing.as_deref().unwrap()).unwrap();
        }
        // Read before a Start that remaps the Bot's host port. No COMPOSE_FILE is set, so Start
        // finds the installation's own `docker-compose.yml`.
        "compose config --environment" if SCENARIO == "harness" => {}
        // Start looks for a `migrate` or `worker` container an earlier release left. None here.
        value
            if value.starts_with(
                "ps --all --quiet --filter label=com.docker.compose.project=",
            ) && value.contains(" --filter label=com.docker.compose.service=") => {}
        "compose ps --format {{.Ports}}" => {
            if SCENARIO == "harness" {
                // The default Bot's port (4215) among them, so a Start in these tests keeps it as
                // the stack's own rather than probing it while another test's Start probes it too.
                println!(
                    "127.0.0.1:4206->4206/tcp, 127.0.0.1:4212->4212/tcp, 127.0.0.1:4215->4215/tcp"
                );
            }
        }
        // `up`, with the profiles of whatever it names: the picked Bot's, a plan engine's.
        value
            if {
                let mut rest = value.strip_prefix("compose ").unwrap_or("");
                // The overlay that remaps the Bot's host port, when one is named.
                while let Some(after) = rest.strip_prefix("-f ") {
                    rest = after.split_once(' ').map_or("", |(_, rest)| rest);
                }
                while let Some(after) = rest.strip_prefix("--profile ") {
                    rest = after.split_once(' ').map_or("", |(_, rest)| rest);
                }
                rest.starts_with("up -d --no-build --pull never ")
            } =>
        {
            if SCENARIO == "up-fails" {
                eprintln!("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock");
                std::process::exit(1);
            }
            // Whether Compose was handed the desktop's host token, by its length only: the
            // token itself is never written anywhere.
            if let Some(token) = std::env::var_os("OPENBOT_DESKTOP_HOST_TOKEN") {
                std::fs::write("host-token-at-up", token.len().to_string()).unwrap();
            }
        }
        value if value.starts_with("compose ps -a --format ") => match SCENARIO {
            // The first thing Start asks after `up`: the barrier that stops it before the host.
            "harness" => {
                eprintln!("synthetic start barrier");
                std::process::exit(71);
            }
            "dead-service" => print!("agent-computer\tExited\nmigrate\tExited\n"),
            "anthropic" => print!(
                "agent-computer\tExited\nmigrate\tExited\nagent-bot\tExited\nagent-langgraph\tExited\n"
            ),
            _ => std::process::exit(42),
        },
        "compose logs --tail 3 agent-computer" if SCENARIO == "dead-service" || SCENARIO == "anthropic" => {
            println!("agent-computer died after boot")
        }
        "compose logs --tail 3 agent-bot" if SCENARIO == "anthropic" => {
            println!("agent-bot missing OPENAI_API_KEY")
        }
        "compose logs --tail 3 agent-langgraph" if SCENARIO == "anthropic" => {
            println!("langgraph died after boot")
        }
        _ => {
            eprintln!("unexpected fixture command: {joined}");
            std::process::exit(42);
        }
    }
}
