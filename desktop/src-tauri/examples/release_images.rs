//! Print every container image this app downloads for a release, as JSON: the release's
//! `desktop-images.json`, which downloads.copilotkit.ai copies (`release_images`).
//!
//! release_images <docker-compose.yml> <container-images.json> <the bundled CLI's index.js>
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: release_images <docker-compose.yml> <container-images.json> <cli index.js>"
                .into(),
        );
    }
    let cli = std::fs::read(&args[3])
        .map_err(|error| format!("could not read the CLI at {}: {error}", args[3]))?;
    let images = openbot_desktop_lib::release_images::release_images(
        Path::new(&args[1]),
        Path::new(&args[2]),
        &String::from_utf8_lossy(&cli),
    )?;
    println!("{}", serde_json::to_string_pretty(&images)?);
    Ok(())
}
