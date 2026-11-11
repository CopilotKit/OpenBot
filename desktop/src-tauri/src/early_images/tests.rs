use super::*;
use crate::early_downloads::tests::{Reply, Server};
use crate::test_support::temp_root;
use std::io::Read;

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

/// A registry with one image on two platforms and an attestation, as ghcr.io serves OpenBot's: an
/// index, a manifest per platform, and each one's config and layers.
struct Published {
    index: Vec<u8>,
    manifests: BTreeMap<String, Vec<u8>>,
    blobs: BTreeMap<String, Vec<u8>>,
    /// The arm64 image's manifest, config and layers, by digest.
    arm64: (String, String, Vec<String>),
}

fn published() -> Published {
    let mut manifests = BTreeMap::new();
    let mut blobs = BTreeMap::new();
    let mut entries = Vec::new();
    let mut arm64 = (String::new(), String::new(), Vec::new());
    for (n, architecture) in ["amd64", "arm64", "unknown"].iter().enumerate() {
        let config = format!(r#"{{"architecture":"{architecture}","os":"linux"}}"#).into_bytes();
        let layers: Vec<Vec<u8>> = (0..2)
            .map(|layer| {
                (0..40_000 + layer * 7_000)
                    .map(|byte| ((byte * (n + 3) + layer) % 251) as u8)
                    .collect()
            })
            .collect();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2,
            "mediaType": MANIFEST_TYPES[0],
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest_of(&config), "size": config.len()},
            "layers": layers.iter().map(|layer| serde_json::json!({
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": digest_of(layer),
                "size": layer.len(),
            })).collect::<Vec<_>>(),
        }))
        .unwrap();
        let digest = digest_of(&manifest);
        if *architecture == "arm64" {
            arm64 = (
                digest.clone(),
                digest_of(&config),
                layers.iter().map(|layer| digest_of(layer)).collect(),
            );
        }
        entries.push(serde_json::json!({
            "mediaType": MANIFEST_TYPES[0],
            "digest": digest,
            "size": manifest.len(),
            "platform": {"os": if *architecture == "unknown" { "unknown" } else { "linux" }, "architecture": architecture},
        }));
        manifests.insert(digest, manifest);
        blobs.insert(digest_of(&config), config);
        for layer in layers {
            blobs.insert(digest_of(&layer), layer);
        }
    }
    let index = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2,
        "mediaType": INDEX_TYPES[0],
        "manifests": entries,
    }))
    .unwrap();
    Published {
        index,
        manifests,
        blobs,
        arm64,
    }
}

fn manifest_reply(bytes: &[u8], media_type: &str) -> Reply {
    Reply::Send {
        status: "200 OK",
        headers: vec![
            ("Content-Type".into(), media_type.into()),
            ("Docker-Content-Digest".into(), digest_of(bytes)),
        ],
        body: bytes.to_vec(),
        cut: None,
    }
}

fn not_here() -> Reply {
    Reply::Send {
        status: "403 Forbidden",
        headers: vec![],
        body: vec![],
        cut: None,
    }
}

/// Serves `published` as the image `copilotkit/openbot-server`, at `/v2/copilotkit/...` as its own
/// registry, and under `/v2/m/` as the mirror's copy, which lacks the arm64 image's second layer.
fn registry(published: Published) -> (Server, String) {
    let published = std::sync::Arc::new(published);
    let missing = published.arm64.2[1].clone();
    let server = Server::start(move |request, _| {
        let path = request.path.as_str();
        if path == "/v2/" {
            return manifest_reply(b"{}", "application/json");
        }
        let (mirror, rest) = match path.strip_prefix("/v2/m/") {
            Some(rest) => (true, rest),
            None => (false, path.trim_start_matches("/v2/")),
        };
        let Some(rest) = rest.strip_prefix("copilotkit/openbot-server/") else {
            return not_here();
        };
        if let Some(reference) = rest.strip_prefix("manifests/") {
            if reference == digest_of(&published.index) {
                return manifest_reply(&published.index, INDEX_TYPES[0]);
            }
            return match published.manifests.get(reference) {
                Some(bytes) => manifest_reply(bytes, MANIFEST_TYPES[0]),
                None => not_here(),
            };
        }
        if let Some(digest) = rest.strip_prefix("blobs/") {
            if mirror && digest == missing {
                return not_here();
            }
            return match published.blobs.get(digest) {
                Some(bytes) => crate::early_downloads::tests::ranged(request, bytes),
                None => not_here(),
            };
        }
        not_here()
    });
    let host = server
        .url("")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    (server, host)
}

struct Seen {
    size: Mutex<Option<u64>>,
    bytes: Mutex<u64>,
}

impl Progress for Seen {
    fn size(&self, size: u64) {
        *self.size.lock().unwrap() = Some(size);
    }
    fn bytes(&self, bytes: u64) {
        let mut seen = self.bytes.lock().unwrap();
        assert!(bytes >= *seen, "the bytes went back from {seen} to {bytes}");
        *seen = bytes;
    }
}

/**
An image Install pulls by its index digest is downloaded with no engine: the arm64 manifest from
the mirror, every blob checked against its digest, the one the mirror lacks from the image's own
registry. Its OCI layout is what `docker load` and `podman load` read: `oci-layout`, an index naming
the platform's manifest under the name the engine pulls it by, and every blob byte for byte.
*/
#[test]
fn an_image_downloads_with_no_engine_and_is_laid_out_for_load() {
    let published = published();
    let (index, arm64, blobs_served) = (
        digest_of(&published.index),
        published.arm64.clone(),
        published.blobs.clone(),
    );
    let (server, host) = registry(published);
    let image = format!("{host}/copilotkit/openbot-server@{index}");
    let registries = Registries {
        mirror: Mirror {
            mirror: format!("{host}/m"),
            upstream: host.clone(),
        },
        https: false,
    };
    let folder = temp_root("early-images").join("images");
    let seen = Seen {
        size: Mutex::new(None),
        bytes: Mutex::new(0),
    };

    let done = download(
        std::slice::from_ref(&image),
        &registries,
        "arm64",
        &folder,
        &seen,
    )
    .expect("the image");
    assert_eq!(done.len(), 1);
    let record = &done[0];
    assert_eq!(record.image, image);
    assert_eq!(record.manifest.digest, arm64.0);
    assert_eq!(record.config.digest, arm64.1);
    assert_eq!(
        record
            .layers
            .iter()
            .map(|layer| layer.digest.clone())
            .collect::<Vec<_>>(),
        arm64.2
    );
    // The size of every part was known before the bytes, and every byte came in.
    let size: u64 = record.parts().map(|blob| blob.size).sum();
    assert_eq!(*seen.size.lock().unwrap(), Some(size));
    assert_eq!(*seen.bytes.lock().unwrap(), size);
    // Recorded, so Install finds it to load.
    assert_eq!(downloaded(&folder), done);
    // The manifest from the mirror; the layer it lacks from the image's own registry.
    let paths: Vec<String> = server.seen().into_iter().map(|seen| seen.path).collect();
    assert!(
        paths.contains(&format!(
            "/v2/m/copilotkit/openbot-server/manifests/{index}"
        )),
        "{paths:?}"
    );
    assert!(
        paths.contains(&format!(
            "/v2/copilotkit/openbot-server/blobs/{}",
            arm64.2[1]
        )),
        "{paths:?}"
    );
    assert!(
        !paths
            .iter()
            .any(|path| path.contains("/manifests/") && !path.contains("/m/")),
        "{paths:?}"
    );

    let mut tar = Vec::new();
    write_layout(record, &folder, &mut tar).expect("the layout");
    let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for entry in tar::Archive::new(tar.as_slice()).entries().unwrap() {
        let mut entry = entry.unwrap();
        let path = entry.path().unwrap().to_string_lossy().into_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.insert(path, bytes);
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&entries["oci-layout"]).unwrap(),
        serde_json::json!({"imageLayoutVersion": "1.0.0"})
    );
    let laid: serde_json::Value = serde_json::from_slice(&entries["index.json"]).unwrap();
    assert_eq!(laid["manifests"].as_array().unwrap().len(), 1);
    assert_eq!(laid["manifests"][0]["digest"], arm64.0.as_str());
    assert_eq!(
        laid["manifests"][0]["annotations"]["io.containerd.image.name"],
        format!(
            "{host}/copilotkit/openbot-server:{}",
            index.replace(':', "-")
        )
        .as_str()
    );
    for digest in std::iter::once(&arm64.1).chain(arm64.2.iter()) {
        let path = format!("blobs/sha256/{}", digest.trim_start_matches("sha256:"));
        assert_eq!(entries[&path], blobs_served[digest], "{path}");
    }
    assert_eq!(
        digest_of(&entries[&format!("blobs/sha256/{}", arm64.0.trim_start_matches("sha256:"))]),
        arm64.0
    );
    // Only this platform's image: nothing of the other's.
    assert_eq!(entries.len(), 2 + 1 + 1 + arm64.2.len());

    // Loaded, the downloads are not kept.
    forget(&folder);
    assert!(!folder.exists());
}

/// Docker Hub's images are named as an engine names them once loaded.
#[test]
fn a_loaded_image_has_the_name_its_pull_would_give_it() {
    assert_eq!(
        loaded_name("ghcr.io/copilotkit/openbot-server@sha256:5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d"),
        "ghcr.io/copilotkit/openbot-server:sha256-5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d"
    );
    assert_eq!(
        loaded_name("pgvector/pgvector:pg17"),
        "docker.io/pgvector/pgvector:pg17"
    );
}

/**
OpenBot's images downloaded with no engine, loaded into a real one, then Install's own pull: it
finds the image's layers and config there and moves only manifests.

`OPENBOT_LIVE_LOAD_ENGINE=docker`, or `podman:<connection>` for a Podman machine's (a throwaway one:
`podman machine init --image`). The image is an earlier release's, which the engine must not have;
it is removed afterwards. `OPENBOT_LIVE_LOAD_SKIP=1` leaves the load out, as Install was before:
then the pull moves the whole image, and this fails.
*/
#[test]
#[ignore = "downloads an OpenBot image and loads it into a real engine"]
fn live_an_image_downloaded_before_the_engine_loads_and_its_pull_moves_no_layers() {
    let engine = match std::env::var("OPENBOT_LIVE_LOAD_ENGINE").as_deref() {
        Ok("docker") => Address::new(crate::engine::Engine::Docker, None),
        Ok(podman) if podman.starts_with("podman:") => Address::new(
            crate::engine::Engine::Podman,
            Some(podman.trim_start_matches("podman:").to_string()),
        ),
        _ => panic!("OPENBOT_LIVE_LOAD_ENGINE=docker or podman:<connection>"),
    };
    // v0.3.3's LangGraph AG-UI image, about 83 MB.
    let image = "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:7ae4c62fed073506a0a709776640cbb55030da6c8a928603ff649d5d891936fa";
    assert!(
        !crate::preparation::image_present(&engine, image).unwrap(),
        "the engine already has {image}"
    );
    let folder = temp_root("early-images-live").join("images");
    let started = std::time::Instant::now();
    let done = download(
        &[image.to_string()],
        &Registries::openbot(),
        crate::registry::host_architecture(),
        &folder,
        &(),
    )
    .expect("the image, with no engine");
    let bytes: u64 = done[0].parts().map(|blob| blob.size).sum();
    eprintln!(
        "downloaded {} in {:.1} s, {bytes} bytes",
        done[0].manifest.digest,
        started.elapsed().as_secs_f64()
    );
    if std::env::var("OPENBOT_LIVE_LOAD_SKIP").as_deref() != Ok("1") {
        let started = std::time::Instant::now();
        let said = load(&engine, &done[0], &folder).expect("loaded");
        eprintln!("loaded in {:.1} s: {said}", started.elapsed().as_secs_f64());
    }

    // Install's own pull, by the pinned reference, from the mirror first.
    let pulled = Mutex::new(0u64);
    let started = std::time::Instant::now();
    crate::pull_metrics::pull_image(
        &engine,
        image,
        |_| {},
        |metrics| *pulled.lock().unwrap() = metrics.bytes.unwrap_or(0),
    )
    .expect("the pull after the load");
    let pulled = *pulled.lock().unwrap();
    eprintln!(
        "pulled after the load in {:.1} s, {pulled} bytes of layers",
        started.elapsed().as_secs_f64()
    );
    assert!(crate::preparation::image_present(&engine, image).unwrap());

    for name in [
        image.to_string(),
        loaded_name(image),
        crate::image_mirror::local_name(image),
    ] {
        let _ = engine
            .command()
            .args(["image", "rm", "--force", &name])
            .output();
    }
    forget(&folder);
    assert!(
        pulled < bytes / 20,
        "the pull moved {pulled} of the image's {bytes} bytes"
    );
}
