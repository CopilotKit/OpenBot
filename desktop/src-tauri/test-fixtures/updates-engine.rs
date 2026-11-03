use std::io::{Read,Write};
fn main() {
    let args:Vec<String>=std::env::args().skip(1).collect();
    let root=std::path::PathBuf::from(std::env::var_os("OPENBOT_UPDATE_ENGINE_FIXTURE").expect("fixture root"));
    let mut log=std::fs::OpenOptions::new().append(true).create(true).open(root.join("fixture-commands.log")).unwrap();
    writeln!(log,"{}",args.join(" ")).unwrap();
    let command=args.join(" ");
    if command=="compose config --format json" { print!("{}",std::fs::read_to_string(root.join("fixture-config.json")).unwrap()); }
    else if command=="compose config --environment" { print!("{}",std::fs::read_to_string(root.join("fixture-compose-environment")).unwrap()); }
    else if command.starts_with("compose --project-directory ") && command.ends_with(" config --format json") { print!("{}",std::fs::read_to_string(root.join("fixture-candidate-config.json")).unwrap()); }
    else if command.starts_with("compose up ") { assert!(command.ends_with(" postgres")); }
    else if command.starts_with("compose exec -T postgres sh -c exec psql ") { print!("{}",std::fs::read_to_string(root.join("fixture-journal.json")).unwrap()); }
    else if command.starts_with("compose exec -T postgres sh -c exec pg_dump ") {
        if root.join("fixture-dump-failure").exists() { std::process::exit(7); }
        std::io::stdout().write_all(b"PGDMP-fixture-backup").unwrap();
    }
    else if command=="compose exec -T postgres pg_restore --list" { let mut bytes=Vec::new();std::io::stdin().read_to_end(&mut bytes).unwrap();if !bytes.starts_with(b"PGDMP") || root.join("fixture-restore-failure").exists() {std::process::exit(8);} }
    else if command=="compose ps -q" { println!("fixture-supervisor\nfixture-computer\nfixture-postgres"); }
    else if command.starts_with("inspect ") {print!("{}",std::fs::read_to_string(root.join("fixture-inspect.json")).unwrap());}
    else if command.starts_with("compose down") { }
    else { eprintln!("unexpected fake engine command: {command}");std::process::exit(2); }
}
