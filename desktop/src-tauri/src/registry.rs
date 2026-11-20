//! How big an image's download is, read from its registry before the engine pulls it.
//!
//! A pull only says how big a layer is once that layer starts downloading, and an engine downloads
//! a few layers of a few images at a time, so the size of the whole download is not in the pull
//! until it is nearly over. The registry has it from the start: an image's manifest lists every
//! layer with its digest and size (OCI distribution spec, "Pulling manifests"; OCI image spec,
//! "Image Manifest"). This reads that manifest the way an engine does, anonymously, for the
//! platform this computer's engine runs, and reports the layers. A registry that cannot be read
//! leaves the size unknown, and the window says so; nothing here stops a pull.
//!
//! https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pulling-manifests
//! https://github.com/opencontainers/image-spec/blob/main/manifest.md
//! https://distribution.github.io/distribution/spec/auth/token/

use std::time::Duration;

use serde::Deserialize;

/// One layer an image downloads: its digest, `sha256:<hex>`, and its compressed size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layer {
    pub digest: String,
    pub size: u64,
}

/// The short id a pull names a layer by: the first twelve hex digits of its digest.
///
/// Docker's pull progress names each layer with `stringid.TruncateID` of the layer's digest, and
/// Compose passes that id on (`docker/compose` `toPullProgressEvent`, `ID: jm.ID`).
pub fn short_id(digest: &str) -> String {
    let hex = digest.split_once(':').map_or(digest, |(_, hex)| hex);
    hex.chars().take(12).collect()
}

/// The architecture name images use for this computer, which is the one its engine's Linux runs.
pub fn host_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
}

/// Where an image reference points: the registry's host, the repository and the tag or digest.
#[derive(Debug, PartialEq, Eq)]
pub struct Reference {
    pub host: String,
    pub repository: String,
    pub reference: String,
}

/// An image reference as an engine reads it: Docker Hub when it names no registry, `library/` for
/// an official image, `latest` when it names no tag. A digest wins over a tag.
pub fn parse_reference(image: &str) -> Option<Reference> {
    let (rest, digest) = match image.split_once('@') {
        Some((rest, digest)) => (rest, Some(digest)),
        None => (image, None),
    };
    let (domain, path) = match rest.split_once('/') {
        Some((first, path))
            if first.contains('.') || first.contains(':') || first == "localhost" =>
        {
            (first, path)
        }
        _ => ("docker.io", rest),
    };
    // A tag is after the last colon of the last path part, never the registry's port.
    let last = path.rsplit('/').next().unwrap_or_default();
    let (repository, tag) = match last.rsplit_once(':') {
        Some((_, tag)) => (&path[..path.len() - tag.len() - 1], Some(tag)),
        None => (path, None),
    };
    if repository.is_empty() {
        return None;
    }
    let (host, repository) = if domain == "docker.io" {
        let repository = if repository.contains('/') {
            repository.to_string()
        } else {
            format!("library/{repository}")
        };
        ("registry-1.docker.io".to_string(), repository)
    } else {
        (domain.to_string(), repository.to_string())
    };
    Some(Reference {
        host,
        repository,
        reference: digest.or(tag).unwrap_or("latest").to_string(),
    })
}

const ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";

/// A manifest is a few kilobytes; anything this large is not one.
const MAX_MANIFEST: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    manifests: Vec<Entry>,
    #[serde(default)]
    layers: Vec<Descriptor>,
}

#[derive(Deserialize)]
struct Entry {
    digest: String,
    platform: Option<Platform>,
}

#[derive(Deserialize)]
struct Platform {
    os: String,
    architecture: String,
}

#[derive(Deserialize)]
struct Descriptor {
    digest: String,
    size: u64,
}

/// The manifest for `architecture` in an index: the Linux one for that architecture, or the only
/// Linux image there is (an engine runs that one under emulation). Attestations name the platform
/// `unknown/unknown` and are never an image.
fn pick(manifests: &[Entry], architecture: &str) -> Option<String> {
    let linux: Vec<&Entry> = manifests
        .iter()
        .filter(|entry| {
            entry.platform.as_ref().is_some_and(|platform| {
                platform.os == "linux" && platform.architecture != "unknown"
            })
        })
        .collect();
    linux
        .iter()
        .find(|entry| {
            entry
                .platform
                .as_ref()
                .is_some_and(|platform| platform.architecture == architecture)
        })
        .or_else(|| (linux.len() == 1).then(|| &linux[0]))
        .map(|entry| entry.digest.clone())
}

/// The layers in a manifest's text, for `architecture`: `Ok(layers)` for an image manifest, or
/// `Err(Some(digest))` naming the manifest to read next when it is an index.
fn read_manifest(body: &[u8], architecture: &str) -> Result<Vec<Layer>, Option<String>> {
    let manifest: Manifest = serde_json::from_slice(body).map_err(|_| None)?;
    if !manifest.manifests.is_empty() {
        return Err(Some(pick(&manifest.manifests, architecture).ok_or(None)?));
    }
    if manifest.layers.is_empty() {
        return Err(None);
    }
    Ok(manifest
        .layers
        .into_iter()
        .map(|layer| Layer {
            digest: layer.digest,
            size: layer.size,
        })
        .collect())
}

/// The anonymous token a `WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge
/// offers, as the URL to ask for it.
pub(crate) fn token_url(challenge: &str) -> Option<reqwest::Url> {
    let rest = challenge.trim().strip_prefix("Bearer ")?;
    let mut realm = None;
    let mut query = Vec::new();
    for part in rest.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let value = value.trim_matches('"');
        match key {
            "realm" => realm = Some(value),
            "service" | "scope" => query.push((key, value)),
            _ => {}
        }
    }
    reqwest::Url::parse_with_params(realm?, &query).ok()
}

/// How an engine reaches `host`: plain HTTP for a registry on this computer's loopback, which Docker
/// and Podman trust without TLS (Docker's default insecure registries are 127.0.0.0/8), and HTTPS
/// for every other.
fn scheme(host: &str) -> &'static str {
    let name = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    let loopback = name == "localhost"
        || name == "[::1]"
        || name
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.is_loopback());
    if loopback {
        "http"
    } else {
        "https"
    }
}

/// The layers `image` downloads on an engine running `architecture`, from its registry. `None` when
/// the registry could not be read or did not answer with a manifest this understands.
pub fn image_layers(image: &str, architecture: &str) -> Option<Vec<Layer>> {
    let reference = parse_reference(image)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let mut token: Option<String> = None;
    let scheme = scheme(&reference.host);
    let mut fetch = |name: &str| -> Option<Vec<u8>> {
        let url = format!(
            "{scheme}://{}/v2/{}/manifests/{name}",
            reference.host, reference.repository
        );
        for _ in 0..2 {
            let mut request = client.get(&url).header("Accept", ACCEPT);
            if let Some(token) = &token {
                request = request.bearer_auth(token);
            }
            let response = request.send().ok()?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && token.is_none() {
                let challenge = response
                    .headers()
                    .get("www-authenticate")?
                    .to_str()
                    .ok()?
                    .to_string();
                #[derive(Deserialize)]
                struct Token {
                    token: Option<String>,
                    access_token: Option<String>,
                }
                let answer: Token = client
                    .get(token_url(&challenge)?)
                    .send()
                    .ok()?
                    .json()
                    .ok()?;
                token = Some(answer.token.or(answer.access_token)?);
                continue;
            }
            if !response.status().is_success() {
                return None;
            }
            let body = response.bytes().ok()?;
            return (body.len() <= MAX_MANIFEST).then(|| body.to_vec());
        }
        None
    };
    let mut name = reference.reference.clone();
    // An index names a manifest; a manifest names layers. Never deeper than that.
    for _ in 0..2 {
        match read_manifest(&fetch(&name)?, architecture) {
            Ok(layers) => return Some(layers),
            Err(Some(next)) => name = next,
            Err(None) => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_references_as_an_engine_does() {
        let hub = |repository: &str, reference: &str| Reference {
            host: "registry-1.docker.io".into(),
            repository: repository.into(),
            reference: reference.into(),
        };
        assert_eq!(
            parse_reference("pgvector/pgvector:pg17"),
            Some(hub("pgvector/pgvector", "pg17"))
        );
        assert_eq!(
            parse_reference("busybox:1.37"),
            Some(hub("library/busybox", "1.37"))
        );
        assert_eq!(
            parse_reference("busybox"),
            Some(hub("library/busybox", "latest"))
        );
        assert_eq!(
            parse_reference(
                "ghcr.io/copilotkit/openbot-agent-bot@sha256:a5518672bf8add00603ac4420dd1316a7d097c02c82fd4606f6ba13b1ffbe4b9"
            ),
            Some(Reference {
                host: "ghcr.io".into(),
                repository: "copilotkit/openbot-agent-bot".into(),
                reference:
                    "sha256:a5518672bf8add00603ac4420dd1316a7d097c02c82fd4606f6ba13b1ffbe4b9"
                        .into(),
            })
        );
        assert_eq!(
            parse_reference("127.0.0.1:5050/openbot-server"),
            Some(Reference {
                host: "127.0.0.1:5050".into(),
                repository: "openbot-server".into(),
                reference: "latest".into(),
            })
        );
        assert_eq!(
            parse_reference("ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9"),
            Some(Reference {
                host: "ghcr.io".into(),
                repository: "copilotkit/intelligence/app-api".into(),
                reference: "0.16.0-rc.9".into(),
            })
        );
    }

    #[test]
    fn a_registry_on_this_computers_loopback_is_read_over_plain_http_as_an_engine_reads_it() {
        assert_eq!(scheme("127.0.0.1:5050"), "http");
        assert_eq!(scheme("localhost:5000"), "http");
        assert_eq!(scheme("[::1]:5000"), "http");
        assert_eq!(scheme("ghcr.io"), "https");
        assert_eq!(scheme("registry-1.docker.io"), "https");
        assert_eq!(scheme("10.0.0.5:5000"), "https");
    }

    #[test]
    fn a_short_id_is_what_a_pull_names_the_layer() {
        assert_eq!(
            short_id("sha256:9994ea1088e3f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081920"),
            "9994ea1088e3"
        );
    }

    #[test]
    fn asks_the_challenge_realm_for_an_anonymous_token() {
        // As ghcr.io and Docker Hub answer an anonymous manifest request.
        assert_eq!(
            token_url(r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:copilotkit/openbot:pull""#)
                .unwrap()
                .as_str(),
            "https://ghcr.io/token?service=ghcr.io&scope=repository%3Acopilotkit%2Fopenbot%3Apull"
        );
        assert_eq!(
            token_url(r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull""#)
                .unwrap()
                .host_str(),
            Some("auth.docker.io")
        );
        assert_eq!(token_url(r#"Basic realm="registry""#), None);
    }

    /// An index as Docker Hub serves `nginx:1.27-alpine`: an image per platform, each beside an
    /// attestation that names the platform `unknown/unknown`.
    const INDEX: &str = r#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
        {"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:amd","size":2495,"platform":{"architecture":"amd64","os":"linux"}},
        {"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:att","size":840,"platform":{"architecture":"unknown","os":"unknown"}},
        {"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:arm","size":2497,"platform":{"architecture":"arm64","os":"linux","variant":"v8"}}]}"#;

    #[test]
    fn an_index_names_the_manifest_for_this_computer() {
        assert_eq!(
            read_manifest(INDEX.as_bytes(), "arm64"),
            Err(Some("sha256:arm".into()))
        );
        assert_eq!(
            read_manifest(INDEX.as_bytes(), "amd64"),
            Err(Some("sha256:amd".into()))
        );
        // Two other platforms and none for this one: nothing an engine would pull here.
        assert_eq!(read_manifest(INDEX.as_bytes(), "riscv64"), Err(None));
        // One Linux image and its attestation: the image an engine runs under emulation.
        let only = r#"{"manifests":[
            {"digest":"sha256:amd","platform":{"architecture":"amd64","os":"linux"}},
            {"digest":"sha256:att","platform":{"architecture":"unknown","os":"unknown"}}]}"#;
        assert_eq!(
            read_manifest(only.as_bytes(), "arm64"),
            Err(Some("sha256:amd".into()))
        );
    }

    #[test]
    fn a_manifest_lists_its_layers_with_their_sizes() {
        let manifest = r#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json",
            "config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:96868d9fa38f","size":11203},
            "layers":[
              {"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:c60e446e49a0","size":1785759},
              {"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:9994ea1088e3","size":16025223}]}"#;
        assert_eq!(
            read_manifest(manifest.as_bytes(), "arm64"),
            Ok(vec![
                Layer {
                    digest: "sha256:c60e446e49a0".into(),
                    size: 1785759
                },
                Layer {
                    digest: "sha256:9994ea1088e3".into(),
                    size: 16025223
                },
            ])
        );
        assert_eq!(read_manifest(b"not json", "arm64"), Err(None));
    }
}
