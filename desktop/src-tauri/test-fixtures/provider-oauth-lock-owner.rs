// Standalone Windows proof: rustc --edition 2021 provider-oauth-lock-owner.rs
// Unix integration uses the Cargo test binary so libc is supplied by the package.
#[path = "../src/provider_oauth_lock.rs"]
mod credential_lock;
use std::io::{self, Write};
fn main() {
    let path = std::env::args_os().nth(1).expect("credential path");
    let _lock = credential_lock::acquire(std::path::Path::new(&path)).unwrap();
    println!("locked");
    io::stdout().flush().unwrap();
    io::stdin().read_line(&mut String::new()).unwrap();
}
