//! Desktop's ChatGPT plan sign-in, without the window: the same calls the model screen's Sign in
//! button makes (`begin_chatgpt_sign_in`, `finish_chatgpt_sign_in`, `finish_plan_sign_in_now`),
//! against an installation folder.
//!
//! `cargo run --example chatgpt_sign_in -- <installation folder>`
//!
//! Prints the authorization URL to open (it carries no token), waits for the browser to come back
//! to the 127.0.0.1 listener, and saves the credential record where Desktop saves it
//! (`.langchain/chatgpt-auth.json` in the folder, owner-only). Prints only what is safe to show:
//! the granted scopes, the issued client id's prefix, and when the access token lapses.

fn main() {
    let root = std::path::PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: chatgpt_sign_in <installation folder>"),
    );
    std::fs::create_dir_all(&root).expect("make the installation folder");
    let url = openbot_desktop_lib::chatgpt_sign_in::begin(&root).unwrap_or_else(|said| {
        eprintln!("the sign-in did not start: {said}");
        std::process::exit(1);
    });
    println!("OPEN: {url}");
    let record = openbot_desktop_lib::chatgpt_sign_in::finish().unwrap_or_else(|said| {
        eprintln!("the sign-in did not finish: {said}");
        std::process::exit(1);
    });
    openbot_desktop_lib::env::write_plan_store(
        &root,
        &openbot_desktop_lib::env::ModelCredential::ChatGptPlan {
            store: record.clone(),
        },
    )
    .expect("save the sign-in where Desktop keeps it");
    let value: serde_json::Value = serde_json::from_str(&record).unwrap();
    let client = value["client_id"].as_str().unwrap_or_default();
    println!(
        "SAVED: {} (client {}…, scopes {}, expires_at {})",
        root.join(openbot_desktop_lib::env::CHATGPT_STORE_FILE)
            .display(),
        &client[..client.len().min(10)],
        value["scopes"],
        value["expires_at"]
    );
}
