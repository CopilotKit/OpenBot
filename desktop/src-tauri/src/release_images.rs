/*!
Every container image this app downloads for a release, read by the code that downloads them.

downloads.copilotkit.ai serves a copy of these images, so a person on a line where GitHub's
container registry is slow pulls them from there (scripts/downloads-images.ts, docs/releasing.md).
The list it copies is made here, from the same calls Install and the back end's download make, so
it cannot name one image fewer than the app pulls:

- OpenBot's own: `preparation::installation_pull_set`, which asks Compose for the images of the
  services this app runs, with each Bot this release can install picked in turn, and adds the two
  sign-in images. Compose reads the release's `docker-compose.yml`, with the images pinned by its
  `container-images.json`, exactly as it does beside an installation.
- The bundled back end's: `local_images::cli_images`, read from the very CLI the installer carries.
  The runtime repositories are named at the release's tag, because that is how the app reads them
  (`repository:release`, then the index that tag serves). And the cluster's own images, which the
  host's engine pulls when the CLI has k3d create the cluster (`local_images::cli_cluster_images`):
  the k3s node image and k3d's proxy and tools, each at the digest the CLI gives k3d.
- The engine machine images on quay.io that the first setup screen downloads before Install, so
  Podman builds OpenBot's machine from a local file (`early_downloads::machine_image_references`).

The release publishes the list as `desktop-images.json` (`examples/release_images.rs`).
*/

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::deployment::Images;
use crate::engine::{Address, Engine};
use crate::harness::{catalogue, HarnessChoice};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReleaseImages {
    /// The OpenBot release, as its `container-images.json` names it.
    pub openbot: String,
    /// The Intelligence release the bundled CLI installs.
    pub intelligence: String,
    /// Every image reference the app may pull for this release, sorted, each once.
    pub images: Vec<String>,
}

/// A release laid out as the app lays one out (`deployment::LAYOUT` and the image list), in a
/// folder of its own, removed when dropped.
struct LaidOut(PathBuf);

impl Drop for LaidOut {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/**
The images for the release whose `docker-compose.yml` and `container-images.json` are given, with
the back end that `cli` (the bundled CLI's `index.js`, as text) installs.

Compose runs through the Docker CLI, as it does for an installation; `config --images` reads files
and does not reach the engine. A CLI whose images this app cannot read is an error rather than an
empty back end: the app would leave those pulls to the CLI, and the copy would miss them silently.
*/
pub fn release_images(compose: &Path, manifest: &Path, cli: &str) -> Result<ReleaseImages, String> {
    let text = std::fs::read_to_string(manifest)
        .map_err(|error| format!("could not read {}: {error}", manifest.display()))?;
    let pinned: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not readable: {error}", manifest.display()))?;
    let back_end = crate::local_images::cli_images(cli).ok_or_else(|| {
        "this app cannot read which images the CLI pulls, so it would leave them to the CLI"
            .to_string()
    })?;
    let cluster = crate::local_images::cli_cluster_images(cli).ok_or_else(|| {
        "this app cannot read which images the CLI has k3d pull for its cluster".to_string()
    })?;

    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let laid_out = LaidOut(
        std::env::temp_dir().join(format!("openbot-release-images-{}-{n}", std::process::id())),
    );
    let release = laid_out.0.join("release");
    std::fs::create_dir_all(&release)
        .map_err(|error| format!("could not make {}: {error}", release.display()))?;
    for (from, name) in [
        (compose, "docker-compose.yml"),
        (manifest, "container-images.json"),
    ] {
        std::fs::copy(from, release.join(name))
            .map_err(|error| format!("could not copy {}: {error}", from.display()))?;
    }
    // No installation: no `.env`, no saved project, nothing of a person's to read.
    let root = laid_out.0.join("installation");
    let address = Address::new(Engine::Docker, None);

    let mut choices: Vec<Option<HarnessChoice>> = vec![None];
    choices.extend(
        catalogue()
            .into_iter()
            .filter(|row| row.image.is_some())
            .map(|row| {
                Some(HarnessChoice {
                    id: row.id,
                    agent_url: None,
                })
            }),
    );
    let mut images = BTreeSet::new();
    for choice in &choices {
        let pulled =
            crate::preparation::installation_pull_set(&address, &root, &release, choice.as_ref())
                .map_err(|problem| {
                let picked = choice
                    .as_ref()
                    .map_or("no Bot", |choice| choice.id.as_str());
                format!(
                    "could not list the images for {picked}: {}{}",
                    problem.said,
                    problem
                        .detail
                        .map(|detail| format!(" ({detail})"))
                        .unwrap_or_default()
                )
            })?;
        images.extend(pulled);
    }
    for repository in &back_end.tagged {
        images.insert(format!("{repository}:{}", back_end.release));
    }
    images.extend(back_end.fixed.iter().cloned());
    images.extend(cluster);
    images.extend(crate::early_downloads::machine_image_references());

    Ok(ReleaseImages {
        openbot: pinned.version,
        intelligence: back_end.release,
        images: images.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLI_48A3863: &str = include_str!("../test-fixtures/local-images/cli-48a3863-excerpt.txt");

    fn repository() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// v0.3.3's `container-images.json`, as the release published it, run against this tree's
    /// Compose file and the CLI the installers bundle.
    #[test]
    #[ignore = "runs docker compose"]
    fn names_every_image_install_and_the_back_end_download_pull() {
        let found = release_images(
            &repository().join("docker-compose.yml"),
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("test-fixtures/release-images/container-images-v0.3.3.json"),
            CLI_48A3863,
        )
        .expect("the release's images");
        assert_eq!(found.openbot, "v0.3.3");
        assert_eq!(found.intelligence, "0.16.0-rc.9");
        let has = |image: &str| found.images.iter().any(|found| found == image);
        // The services every installation runs, pinned by the release's manifest, and the
        // database Compose names by tag.
        for image in [
            "ghcr.io/copilotkit/openbot-server@sha256:fce3ffc51b12c075642a8b37d00d6137d85f418cd8d43d28456757b173d7eef9",
            "ghcr.io/copilotkit/openbot-agent-computer@sha256:7e5e93c2a29d7450efed1f492f870e2e497bc031da6919473c2a21f657ea227a",
            "pgvector/pgvector:pg17",
            // The two sign-in images.
            "ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:1f007dc9712f86b899410b12c414ff0218eeec11e941c9b3680629df54c407bc",
            "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:7ae4c62fed073506a0a709776640cbb55030da6c8a928603ff649d5d891936fa",
            // A Bot a person may pick.
            "ghcr.io/copilotkit/openbot-agent-mastra@sha256:532b21d83ebcd9f964f763316b20834c6d9e4855fcea927d2c8dfe4d1bc3246b",
            // The back end's runtime images at its release's tag, and its pinned ones.
            "ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9",
            "ghcr.io/copilotkit/intelligence/realtime-gateway:0.16.0-rc.9",
            "ghcr.io/copilotkit/intelligence/local-object-storage@sha256:1c2a56bcd21e6ef33b77ddefec998ba09b026c339af1c2827d312ee3df7b7280",
            "docker.io/rancher/mirrored-pause@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893",
            // The cluster's own, which k3d has the host's engine pull.
            "docker.io/rancher/k3s@sha256:53cf744fe2fabf140cee240d2db70d13a4f2d98f1a13c98f58f457f423096917",
            "ghcr.io/k3d-io/k3d-proxy@sha256:d43e6ffd27c216d0b21815c1226c8aeac2e07086ac5a988eb39bd7e308f6e370",
            "ghcr.io/k3d-io/k3d-tools@sha256:c5ceb2b9e8ff2cf55917b0bee8bc9c54fe1483a16366b734117e2cfac1417bed",
            // The engine machine images the first screen downloads, by their artifact manifests.
            "quay.io/podman/machine-os@sha256:e4b416b1758cb94b477d0c27e265b9180e8d52ee529df9276d726206ea69b883",
            "quay.io/podman/machine-os@sha256:b3f5e2810eecb8778a6dc09283868c1255a06d7c156312c387616d41500d4175",
        ] {
            assert!(has(image), "missing {image} in {:#?}", found.images);
        }
        // Every Bot this build can install, and nothing the desktop never runs.
        for row in catalogue() {
            if let Some(name) = row.image {
                assert!(
                    found
                        .images
                        .iter()
                        .any(|image| image.contains(&format!("/openbot-{name}@"))),
                    "no image for {name}"
                );
            }
        }
        assert!(!found
            .images
            .iter()
            .any(|image| image.starts_with("ghcr.io/copilotkit/openbot@")));
        let mut sorted = found.images.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted, found.images);
    }

    #[test]
    fn a_cli_whose_images_cannot_be_read_is_refused() {
        let error = release_images(
            &repository().join("docker-compose.yml"),
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("test-fixtures/release-images/container-images-v0.3.3.json"),
            "not a CLI",
        )
        .unwrap_err();
        assert!(
            error.contains("cannot read which images the CLI pulls"),
            "{error}"
        );
    }
}
