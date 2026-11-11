/*!
OpenBot's own images, downloaded before any engine answers, then loaded into the engine once it does.

On a computer with no engine yet (a new Mac or PC, or a Docker Desktop that is not running), the
first setup screen used to download Podman and the machine image early, but OpenBot's images (about
1.1 GB for the default Bot) still waited for the engine to start, and then downloaded one after
another behind it. Their bytes need no engine. So the first screen downloads them too:

- **Which images.** The ones Install pulls for the default Bot (`preparation::installation_pull_set`),
  asked of OpenBot's own standalone Compose when there is no engine to ask
  (`stack::standalone_compose_command`), or of Docker's Compose when Docker Desktop is installed but
  stopped. `config --images` reads files and reaches no engine.
- **The manifests**, read with `oci-client` (the ORAS project's OCI Distribution client) for this
  computer's platform (`linux/<arch>`), from downloads.copilotkit.ai's copy first and the image's
  own registry after it, as `image_mirror` asks an engine to. A manifest is checked against its
  digest by the client.
- **The blobs**, every layer and config, through `early_downloads::fetch`: resumed after a quit,
  checked against the digest the manifest names, from the mirror first. One copy of each blob,
  shared by the images that use it.

**Loading.** Once the engine answers, Install loads each image it does not have yet as an OCI image
layout streamed into `docker load` / `podman load` (both read an OCI layout's tar: moby
`image/tarexport` and containers/image `oci-archive`), then deletes the download. Install's own pull
runs after it as before. It finds the image's layers and config already in the engine, so it moves
only the manifests that give the image its pinned name: the containerd store finds the blobs in its
content store, the classic store sees the image's config and skips the layers (moby
`distribution/pull_v2.go`), and Podman reuses layers it holds by their compressed digest. Anything
that did not load is downloaded by that pull, as it always was.
*/

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::early_downloads::{fetch, Pinned, Progress};
use crate::engine::Address;
use crate::image_mirror::Mirror;

/// Where downloaded images are kept, under the early downloads' cache.
pub fn folder(cache: &Path) -> PathBuf {
    cache.join("images")
}

fn blobs(folder: &Path) -> PathBuf {
    folder.join("blobs").join("sha256")
}

/// One part of an image: its digest, `sha256:<hex>`, and size.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blob {
    pub digest: String,
    pub size: u64,
}

impl Blob {
    fn hex(&self) -> &str {
        self.digest.trim_start_matches("sha256:")
    }
}

/// One image downloaded for this computer's platform: its manifest and every blob it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Downloaded {
    /// The reference Install pulls it by.
    pub image: String,
    pub manifest: Blob,
    #[serde(rename = "mediaType")]
    pub media_type: String,
    pub config: Blob,
    pub layers: Vec<Blob>,
}

impl Downloaded {
    fn parts(&self) -> impl Iterator<Item = &Blob> {
        std::iter::once(&self.config).chain(self.layers.iter())
    }
}

/// Where a registry is, and how to ask it: production asks over https; the tests over http on
/// loopback.
#[derive(Clone, Debug)]
pub struct Registries {
    pub mirror: Mirror,
    pub https: bool,
}

impl Registries {
    /// downloads.copilotkit.ai for ghcr.io and Docker Hub, over https.
    pub fn openbot() -> Self {
        Self {
            mirror: Mirror::openbot(),
            https: true,
        }
    }

    fn scheme(&self) -> &'static str {
        if self.https {
            "https"
        } else {
            "http"
        }
    }

    /// Where to ask for `image`: the mirror's copy when it keeps one, then the image's own.
    fn sources(&self, image: &str) -> Vec<String> {
        self.mirror
            .mirrored(image)
            .into_iter()
            .chain(std::iter::once(image.to_string()))
            .collect()
    }

    /// The URL of `digest`'s blob in the repository `image` names.
    fn blob_url(&self, image: &str, digest: &str) -> Option<String> {
        let reference = crate::registry::parse_reference(image)?;
        Some(format!(
            "{}://{}/v2/{}/blobs/{digest}",
            self.scheme(),
            reference.host,
            reference.repository
        ))
    }
}

const INDEX_TYPES: [&str; 2] = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES: [&str; 2] = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
];

#[derive(Deserialize)]
struct Document {
    #[serde(rename = "mediaType", default)]
    media_type: Option<String>,
    #[serde(default)]
    manifests: Vec<Entry>,
    config: Option<Blob>,
    #[serde(default)]
    layers: Vec<Blob>,
}

#[derive(Deserialize)]
struct Entry {
    digest: String,
    #[serde(rename = "mediaType", default)]
    media_type: Option<String>,
    platform: Option<Platform>,
}

#[derive(Deserialize)]
struct Platform {
    os: String,
    architecture: String,
}

/// The entry for `linux/<architecture>` in an index, or the only Linux image there is. An
/// attestation names `unknown/unknown` and is never an image.
fn pick<'a>(entries: &'a [Entry], architecture: &str) -> Option<&'a Entry> {
    let linux: Vec<&Entry> = entries
        .iter()
        .filter(|entry| {
            entry.platform.as_ref().is_some_and(|platform| {
                platform.os == "linux" && platform.architecture != "unknown"
            })
        })
        .collect();
    linux
        .iter()
        .copied()
        .find(|entry| {
            entry
                .platform
                .as_ref()
                .is_some_and(|platform| platform.architecture == architecture)
        })
        .or_else(|| (linux.len() == 1).then(|| linux[0]))
}

/// The manifest at `reference`, as its registry serves it, checked against its digest by the
/// client when the reference names one.
async fn manifest(
    client: &oci_client::Client,
    reference: &str,
) -> Result<(Vec<u8>, String), String> {
    let parsed: oci_client::Reference = reference
        .parse()
        .map_err(|error| format!("{reference} is not an image reference: {error}"))?;
    let accepted: Vec<&str> = INDEX_TYPES
        .iter()
        .chain(MANIFEST_TYPES.iter())
        .copied()
        .collect();
    let (body, digest) = client
        .pull_manifest_raw(
            &parsed,
            &oci_client::secrets::RegistryAuth::Anonymous,
            &accepted,
        )
        .await
        .map_err(|error| format!("{reference}: {error}"))?;
    Ok((body.to_vec(), digest))
}

/// `image`'s manifest for `architecture`, from the first of its sources that gives one.
async fn resolve(
    client: &oci_client::Client,
    registries: &Registries,
    image: &str,
    architecture: &str,
) -> Result<(String, Vec<u8>, String, Document), String> {
    let mut last = format!("no source for {image}");
    for source in registries.sources(image) {
        match resolve_at(client, &source, architecture).await {
            Ok((bytes, digest, document)) => return Ok((source, bytes, digest, document)),
            Err(error) => {
                log::warn!("[early images] {error}");
                last = error;
            }
        }
    }
    Err(last)
}

async fn resolve_at(
    client: &oci_client::Client,
    source: &str,
    architecture: &str,
) -> Result<(Vec<u8>, String, Document), String> {
    let (bytes, digest) = manifest(client, source).await?;
    let document: Document = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{source}: the manifest is not readable: {error}"))?;
    if document.manifests.is_empty() {
        return Ok((bytes, digest, document));
    }
    let entry = pick(&document.manifests, architecture)
        .ok_or_else(|| format!("{source} has no image for linux/{architecture}"))?;
    let name = source.split('@').next().unwrap_or(source);
    // A tag's repository: everything before the tag, which follows the last path part's colon.
    let repository = match name.rsplit_once('/') {
        Some((before, last)) => {
            format!("{before}/{}", last.split(':').next().unwrap_or(last))
        }
        None => name.split(':').next().unwrap_or(name).to_string(),
    };
    let platform = format!("{repository}@{}", entry.digest);
    let (bytes, digest) = manifest(client, &platform).await?;
    let mut document: Document = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{platform}: the manifest is not readable: {error}"))?;
    if document.media_type.is_none() {
        document.media_type = entry.media_type.clone();
    }
    Ok((bytes, digest, document))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The record of one downloaded image, by a name made from its reference.
fn record_path(folder: &Path, image: &str) -> PathBuf {
    folder.join(format!("{}.json", &sha256_hex(image.as_bytes())[..16]))
}

/// Every image recorded as downloaded in `folder`.
pub fn downloaded(folder: &Path) -> Vec<Downloaded> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<Downloaded> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok())
        .collect();
    found.sort_by(|a, b| a.image.cmp(&b.image));
    found
}

/// Every byte downloaded so far, over every blob, for one progress line.
struct Together<'a> {
    parent: &'a dyn Progress,
    bytes: Mutex<BTreeMap<String, u64>>,
}

impl Together<'_> {
    fn blob(&self, hex: String) -> impl Progress + '_ {
        struct One<'b, 'a> {
            together: &'b Together<'a>,
            hex: String,
        }
        impl Progress for One<'_, '_> {
            fn bytes(&self, bytes: u64) {
                let total = {
                    let mut all = self
                        .together
                        .bytes
                        .lock()
                        .unwrap_or_else(|held| held.into_inner());
                    all.insert(self.hex.clone(), bytes);
                    all.values().sum::<u64>()
                };
                self.together.parent.bytes(total);
            }
        }
        One {
            together: self,
            hex,
        }
    }
}

/// How many blobs download at once.
const BLOBS_AT_ONCE: usize = 4;

/**
Download `images` for `architecture` into `folder`: each one's manifest, then every blob they
name, at most `BLOBS_AT_ONCE` at a time. `progress` hears the size of them all once every manifest
is read, then the bytes so far. An image already recorded with every blob there is not asked for
again. Answers with what was downloaded; an image that could not be is left to Install's pull.
*/
pub fn download(
    images: &[String],
    registries: &Registries,
    architecture: &str,
    folder: &Path,
    progress: &dyn Progress,
) -> Result<Vec<Downloaded>, String> {
    std::fs::create_dir_all(blobs(folder))
        .map_err(|error| format!("could not make {}: {error}", folder.display()))?;
    // The client's TLS needs a provider installed for the process: ring, as the updater installs it.
    // Installed once; a second install answers an error that changes nothing.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = oci_client::Client::new(oci_client::client::ClientConfig {
        protocol: if registries.https {
            oci_client::client::ClientProtocol::Https
        } else {
            oci_client::client::ClientProtocol::Http
        },
        user_agent: "openbot-desktop",
        connect_timeout: Some(std::time::Duration::from_secs(15)),
        read_timeout: Some(std::time::Duration::from_secs(30)),
        platform_resolver: None,
        ..Default::default()
    });

    let mut wanted: Vec<(Downloaded, String)> = Vec::new();
    for image in images {
        let resolved =
            tauri::async_runtime::block_on(resolve(&client, registries, image, architecture));
        let (source, bytes, digest, document) = match resolved {
            Ok(resolved) => resolved,
            Err(error) => {
                log::warn!("[early images] {image} is left to Install: {error}");
                continue;
            }
        };
        let hex = digest.trim_start_matches("sha256:").to_string();
        if sha256_hex(&bytes) != hex {
            log::warn!("[early images] {image}: its manifest is not the one its digest names");
            continue;
        }
        let Some(config) = document.config else {
            log::warn!("[early images] {image}: its manifest names no config");
            continue;
        };
        std::fs::write(blobs(folder).join(&hex), &bytes)
            .map_err(|error| format!("could not write {image}'s manifest: {error}"))?;
        let record = Downloaded {
            image: image.clone(),
            manifest: Blob {
                digest: format!("sha256:{hex}"),
                size: bytes.len() as u64,
            },
            media_type: document
                .media_type
                .unwrap_or_else(|| MANIFEST_TYPES[0].to_string()),
            config,
            layers: document.layers,
        };
        wanted.push((record, source));
    }

    // Each blob once, from where its image was found, then the image's own registry.
    let mut parts: BTreeMap<String, (Blob, Vec<String>)> = BTreeMap::new();
    for (record, source) in &wanted {
        for blob in record.parts() {
            parts.entry(blob.hex().to_string()).or_insert_with(|| {
                let sources = [source.as_str(), record.image.as_str()]
                    .iter()
                    .filter_map(|from| registries.blob_url(from, &blob.digest))
                    .collect::<Vec<_>>();
                (blob.clone(), sources)
            });
        }
    }
    progress.size(parts.values().map(|(blob, _)| blob.size).sum());
    let together = Together {
        parent: progress,
        bytes: Mutex::new(BTreeMap::new()),
    };
    let queue = Mutex::new(parts.into_iter().collect::<Vec<_>>());
    let failed = Mutex::new(Vec::<String>::new());
    std::thread::scope(|scope| {
        for _ in 0..BLOBS_AT_ONCE {
            scope.spawn(|| loop {
                let Some((hex, (blob, sources))) =
                    queue.lock().unwrap_or_else(|held| held.into_inner()).pop()
                else {
                    return;
                };
                let pinned = Pinned {
                    name: hex.clone(),
                    sha256: hex.clone(),
                    size: Some(blob.size),
                    sources,
                };
                if let Err(error) = fetch(&pinned, &blobs(folder), &together.blob(hex.clone())) {
                    log::warn!("[early images] blob {hex}: {error}");
                    failed
                        .lock()
                        .unwrap_or_else(|held| held.into_inner())
                        .push(hex);
                }
            });
        }
    });
    let failed = failed.into_inner().unwrap_or_default();
    let mut done = Vec::new();
    for (record, _) in wanted {
        if record
            .parts()
            .any(|blob| failed.iter().any(|hex| hex == blob.hex()))
        {
            log::warn!("[early images] {} is left to Install", record.image);
            continue;
        }
        let path = record_path(folder, &record.image);
        let text = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
        std::fs::write(&path, text)
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        log::info!("[early images] {} is downloaded", record.image);
        done.push(record);
    }
    if done.is_empty() && !images.is_empty() {
        return Err("no image downloaded".into());
    }
    Ok(done)
}

/// The tag an image is loaded with, as the engine names it once it is pulled (`image_mirror`): a
/// digest-pinned reference is tagged `sha256-<hex>`.
fn loaded_name(image: &str) -> String {
    let name = crate::image_mirror::local_name(image);
    match crate::registry::parse_reference(&name) {
        Some(reference) if reference.host == "registry-1.docker.io" => {
            format!("docker.io/{}:{}", reference.repository, reference.reference)
        }
        _ => name,
    }
}

/// The OCI image layout for `record`, as a tar, written to `into`: `oci-layout`, an `index.json`
/// naming the platform's manifest, and every blob it needs from `folder`.
pub fn write_layout(record: &Downloaded, folder: &Path, into: impl Write) -> Result<(), String> {
    let name = loaded_name(&record.image);
    let tag = name.rsplit(':').next().unwrap_or("latest").to_string();
    let index = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": record.media_type,
            "digest": record.manifest.digest,
            "size": record.manifest.size,
            "annotations": {
                "io.containerd.image.name": name,
                "org.opencontainers.image.ref.name": tag,
            },
        }],
    });
    let mut tar = tar::Builder::new(into);
    let mut add = |path: &str, bytes: &[u8]| -> Result<(), String> {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, path, bytes)
            .map_err(|error| format!("could not write the image's layout: {error}"))
    };
    add("oci-layout", br#"{"imageLayoutVersion":"1.0.0"}"#)?;
    add(
        "index.json",
        &serde_json::to_vec(&index).map_err(|error| error.to_string())?,
    )?;
    for blob in std::iter::once(&record.manifest).chain(record.parts()) {
        let path = blobs(folder).join(blob.hex());
        let mut file = std::fs::File::open(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        tar.append_file(format!("blobs/sha256/{}", blob.hex()), &mut file)
            .map_err(|error| format!("could not write the image's layout: {error}"))?;
    }
    tar.into_inner()
        .and_then(|mut into| into.flush())
        .map_err(|error| format!("could not write the image's layout: {error}"))
}

/// Load `record` into `engine`: its OCI layout streamed into `load`.
pub fn load(engine: &Address, record: &Downloaded, folder: &Path) -> Result<String, String> {
    let mut child = engine
        .command()
        .arg("load")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run load: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "load took no input".to_string())?;
    let written = std::thread::scope(|scope| {
        let writer = scope.spawn(|| write_layout(record, folder, stdin));
        let output = child.wait_with_output();
        (writer.join(), output)
    });
    let output = written
        .1
        .map_err(|error| format!("load did not finish: {error}"))?;
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    if !output.status.success() {
        return Err(format!("load stopped: {said}"));
    }
    match written.0 {
        Ok(Ok(())) => Ok(said),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the layout could not be written".into()),
    }
}

/**
Load every image downloaded in `folder` that `engine` does not have yet, saying how far it is through
`said` (`done` of `total` images, over the bytes they hold), then delete the downloads. An image that
does not load is left to Install's pull. Answers with how many loaded.
*/
pub fn load_downloaded(
    engine: &Address,
    folder: &Path,
    said: impl Fn(crate::pull_metrics::Downloads),
) -> usize {
    let records = downloaded(folder);
    if records.is_empty() {
        return 0;
    }
    let bytes: u64 = records
        .iter()
        .flat_map(|record| record.parts().map(|blob| blob.size))
        .sum();
    let total = records.len();
    let mut loaded = 0;
    for (at, record) in records.iter().enumerate() {
        said(crate::pull_metrics::Downloads {
            done: at,
            total,
            bytes,
            size: Some(bytes),
            bytes_per_second: None,
        });
        if crate::preparation::image_present(engine, &record.image).unwrap_or(false) {
            continue;
        }
        let started = std::time::Instant::now();
        match load(engine, record, folder) {
            Ok(answer) => {
                loaded += 1;
                log::info!(
                    "[early images] loaded {} in {:.1} s: {answer}",
                    record.image,
                    started.elapsed().as_secs_f64()
                );
            }
            Err(error) => log::warn!(
                "[early images] {} did not load, so Install pulls it: {error}",
                record.image
            ),
        }
    }
    said(crate::pull_metrics::Downloads {
        done: total,
        total,
        bytes,
        size: Some(bytes),
        bytes_per_second: None,
    });
    forget(folder);
    loaded
}

/// The downloaded images are in the engine now, or will come from Install's pull: not kept.
pub fn forget(folder: &Path) {
    if folder.file_name().is_some_and(|name| name == "images") {
        if let Err(error) = std::fs::remove_dir_all(folder) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "[early images] could not remove {}: {error}",
                    folder.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests;
