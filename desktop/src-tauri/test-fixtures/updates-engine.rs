use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// Go's `os.Getwd`, which Compose uses: on Unix `$PWD` wins when it names the current directory,
/// otherwise the kernel's answer (links resolved). Windows has no `$PWD` rule.
fn go_working_directory() -> PathBuf {
    let current = std::env::current_dir().unwrap();
    #[cfg(unix)]
    if let Some(pwd) = std::env::var_os("PWD").map(PathBuf::from) {
        use std::os::unix::fs::MetadataExt;
        let same = |a: &Path, b: &Path| match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        };
        if pwd.is_absolute() && same(&pwd, Path::new(".")) {
            return pwd;
        }
    }
    current
}

/// Go's `filepath.Abs`: join with the working directory and clean, never resolving links.
fn absolute(path: &str) -> PathBuf {
    let joined = go_working_directory().join(path);
    let mut clean = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean
}

/// Compose's project directory: `--project-directory`, else the first `-f` file's directory, else
/// the working directory. Relative bind sources in every file resolve against it.
fn project_directory(project: Option<&str>, files: &[String]) -> PathBuf {
    match (project, files.first()) {
        (Some(directory), _) => absolute(directory),
        (None, Some(file)) => absolute(file).parent().unwrap().to_path_buf(),
        (None, None) => go_working_directory(),
    }
}

/// Rewrite every relative bind source (`"source": "./..."`) against the project directory, as
/// Compose does, in the JSON text the test wrote. Joined component by component, like Go's
/// `filepath.Join`, so a Windows project directory gets backslashes throughout.
fn resolve_binds(config: &str, project: &Path) -> String {
    let mut out = String::new();
    let mut rest = config;
    loop {
        let found = ["\"source\": \"./", "\"source\":\"./"]
            .iter()
            .filter_map(|marker| rest.find(marker).map(|at| (at, marker.len())))
            .min();
        let Some((at, length)) = found else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at + length - 2]);
        rest = &rest[at + length..];
        let close = rest.find('"').unwrap();
        let mut resolved = project.to_path_buf();
        for part in rest[..close].split('/') {
            resolved.push(part);
        }
        out.push_str(
            &resolved
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\""),
        );
        rest = &rest[close..];
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = PathBuf::from(
        std::env::var_os("OPENBOT_UPDATE_ENGINE_FIXTURE").expect("fixture root"),
    );
    let mut log = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("fixture-commands.log"))
        .unwrap();
    writeln!(log, "{}", args.join(" ")).unwrap();

    // Global Compose options, then the subcommand.
    let mut rest = args.as_slice();
    let mut project = None;
    let mut files = Vec::new();
    if rest.first().map(String::as_str) == Some("compose") {
        rest = &rest[1..];
        loop {
            match rest {
                [flag, value, tail @ ..] if flag == "--project-directory" => {
                    project = Some(value.clone());
                    rest = tail;
                }
                [flag, value, tail @ ..] if flag == "-f" => {
                    files.push(value.clone());
                    rest = tail;
                }
                _ => break,
            }
        }
        let command = rest.join(" ");
        let fixture = std::fs::canonicalize(&root).unwrap();
        // The vendor base file is the staged one when it is not in the installation itself.
        let candidate = files.iter().any(|file| {
            std::fs::canonicalize(absolute(file))
                .ok()
                .and_then(|file| file.parent().map(Path::to_path_buf))
                .is_some_and(|parent| parent != fixture)
        });
        let database = root.join("fixture-journal.json");
        if command == "config --format json" {
            let template = if candidate {
                "fixture-candidate-config.json"
            } else {
                "fixture-config.json"
            };
            let config = std::fs::read_to_string(root.join(template)).unwrap();
            print!(
                "{}",
                resolve_binds(&config, &project_directory(project.as_deref(), &files))
            );
        } else if command == "config --environment" {
            print!(
                "{}",
                std::fs::read_to_string(root.join("fixture-compose-environment")).unwrap()
            );
        } else if command.starts_with("up ") {
            assert!(command.ends_with(" postgres"));
            if root.join("fixture-postgres-failure").exists() {
                eprintln!("Bind for 127.0.0.1:5432 failed: port is already allocated");
                std::process::exit(1);
            }
        } else if command.starts_with("exec -T postgres sh -c exec psql ") {
            // The migrations table, as the running database holds it.
            print!("{}", std::fs::read_to_string(&database).unwrap());
        } else if command.starts_with("exec -T postgres sh -c exec pg_dump ") {
            if root.join("fixture-dump-failure").exists() {
                std::process::exit(7);
            }
            // A custom-format archive: its magic, then what the database held.
            let mut out = std::io::stdout();
            out.write_all(b"PGDMP").unwrap();
            out.write_all(&std::fs::read(&database).unwrap()).unwrap();
        } else if command == "exec -T postgres pg_restore --list" {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            if !bytes.starts_with(b"PGDMP") || root.join("fixture-restore-failure").exists() {
                std::process::exit(8);
            }
        } else if command.starts_with("exec -T postgres sh -c exec pg_restore --clean --if-exists --create ") {
            // Drop and recreate the database from the archive: afterwards it holds exactly what
            // the dump held, and nothing a later migration added.
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            let Some(state) = bytes.strip_prefix(b"PGDMP") else {
                eprintln!("pg_restore: error: input file does not appear to be a valid archive");
                std::process::exit(1);
            };
            std::fs::write(&database, state).unwrap();
        } else if command == "ps -q" {
            println!("fixture-supervisor\nfixture-computer\nfixture-postgres");
        } else if command.starts_with("down") {
        } else {
            eprintln!("unexpected fake engine command: {}", args.join(" "));
            std::process::exit(2);
        }
        return;
    }
    let command = args.join(" ");
    if command.starts_with("inspect ") {
        print!(
            "{}",
            std::fs::read_to_string(root.join("fixture-inspect.json")).unwrap()
        );
    } else {
        eprintln!("unexpected fake engine command: {command}");
        std::process::exit(2);
    }
}
