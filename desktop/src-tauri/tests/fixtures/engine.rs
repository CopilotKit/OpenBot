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
    if SCENARIO == "compose-provider" {
        println!("Docker Compose version disposable-provider");
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
    if SCENARIO == "stop-ipc" && joined == "compose -f docker-compose.yml --profile harness down" {
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
    if SCENARIO == "empty-answer" {
        if args.get(1).map(String::as_str) == Some("logs") {
            if let Some(service) = args
                .last()
                .filter(|s| ["agent-langgraph", "agent-harness"].contains(&s.as_str()))
            {
                println!("OpenAIAuthenticationError: 401 {service} refused the key");
            }
        }
        return;
    }
    match joined.as_str() {
        "compose version" => println!("Docker Compose synthetic"),
        "compose ps --format {{.Ports}}" => {
            if SCENARIO == "harness" {
                println!("127.0.0.1:4206->4206/tcp, 127.0.0.1:4212->4212/tcp");
            }
        }
        value
            if value.starts_with("compose up -d --no-build ")
                || value.starts_with("compose --profile harness up -d --no-build ") => {}
        "compose run --rm migrate" => {
            if SCENARIO == "harness" {
                eprintln!("synthetic migration barrier");
                std::process::exit(71);
            }
        }
        value if value.starts_with("compose ps -a --format ") => match SCENARIO {
            "dead-service" => print!("agent-computer\tExited\nmigrate\tExited\n"),
            "anthropic" => print!(
                "agent-computer\tUp\nmigrate\tExited\nagent-bot\tExited\nagent-langgraph\tExited\n"
            ),
            _ => std::process::exit(42),
        },
        "compose logs --tail 3 agent-computer" if SCENARIO == "dead-service" => {
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
