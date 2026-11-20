//! OpenBot's images come from its own mirror first, and from GHCR only when the mirror cannot give
//! one.
//!
//! GHCR's download network is not dependable for the people who install OpenBot: on 2026-11-06, on
//! a 300-500 Mbit office line, `agent-computer` came from GHCR's blob CDN at about 0.23 MB/s while
//! nodejs.org gave the same Mac 31.5 MB/s in the same minute. So every image on ghcr.io is asked of
//! https://downloads.copilotkit.ai first: CloudFront over a private S3 bucket, holding a read-only
//! copy of ghcr.io's registry tree at the same paths (`/v2/<repo>/manifests/<tag or digest>`,
//! `/v2/<repo>/blobs/<digest>`), so `downloads.copilotkit.ai/<repo>@<digest>` is the image
//! `ghcr.io/<repo>@<digest>`. A key it does not hold answers 403, not 404, and it asks for no
//! credentials. Docker Hub's images are copied under `docker.io/`, official images under
//! `library/` as Docker Hub keeps them: `downloads.copilotkit.ai/docker.io/library/busybox:1.37` is
//! `busybox:1.37`, and the image comes from Docker Hub when the mirror cannot give it.
//!
//! WHY THE APP DOES THIS, AND NOT THE ENGINE. Docker's `registry-mirrors` setting mirrors Docker Hub
//! and nothing else (https://docs.docker.com/docker-hub/image-library/mirror/). Docker Engine 28 and
//! later, on the containerd image store only, also read a containerd `hosts.toml` per registry from
//! `/etc/docker/certs.d/<host>/` (moby/moby#47380, `daemon/hosts.go`), which could name a mirror for
//! ghcr.io; but that is inside Docker Desktop's VM, it is the person's Docker configuration and not
//! OpenBot's to change, Docker Desktop reads it only when it restarts, and the classic image store
//! ignores it. So the app pulls the mirror's copy itself and gives it the ghcr.io name.
//!
//! WHY IT IS SAFE. The references OpenBot runs are digest-pinned (`deployment::reference`), and an
//! engine pulling by digest checks every manifest and blob it is given against that digest. A copy
//! that differs by one byte is refused, and refused is the same as missing: the image comes from
//! ghcr.io, as it always did.
//!
//! WHY NOTHING DOWNLOADS IT AGAIN. Everything else names the image by its ghcr.io reference: Compose
//! (`up --pull never`), the sign-in `run --pull=never`, the supervisor's computers. Once the mirror's
//! copy answers to that reference, `preparation::image_present` sees it and no later step pulls.
//! How it comes to answer differs by image store, so it is checked rather than assumed:
//!
//! - The containerd image store (Docker Desktop's default) finds `<repo>@<digest>` in any image of
//!   that repository whose target is that digest, whatever its tag (moby `daemon/containerd/image.go`,
//!   `resolveImage`). One `docker tag` to a ghcr.io name does it, and no request reaches GHCR.
//! - The classic store finds a digest reference only where a pull recorded it, and a tag cannot
//!   record one (moby `daemon/images/image.go`, `GetImage`). There the ghcr.io pull still runs, and
//!   finds every layer and the image's config already here, so it fetches the manifest and records
//!   the name, and no layer comes from GHCR (moby `distribution/pull_v2.go`: an image whose config is
//!   in the store is not pulled again).
//!
//! The mirror's own name is removed once the ghcr.io name answers, so the person's image list shows
//! the image once, under the name OpenBot runs it by.

use crate::engine::Address;

/// The host that serves OpenBot's mirror of ghcr.io.
pub const MIRROR: &str = "downloads.copilotkit.ai";

/// The registry the mirror copies, and the one every image reference names.
pub const UPSTREAM: &str = "ghcr.io";

/// Which registry's images are asked of which mirror first. Production asks `MIRROR` for `UPSTREAM`'s
/// images; the live tests name two registries on loopback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mirror {
    pub mirror: String,
    pub upstream: String,
}

impl Mirror {
    /// downloads.copilotkit.ai for ghcr.io.
    pub fn openbot() -> Self {
        Self {
            mirror: MIRROR.to_string(),
            upstream: UPSTREAM.to_string(),
        }
    }

    /// `image` at the mirror: the same repository, tag and digest, on the mirror's host, and for a
    /// Docker Hub image under `docker.io/`. `None` for an image on any other registry, which the
    /// mirror does not carry.
    pub fn mirrored(&self, image: &str) -> Option<String> {
        let path = match image
            .strip_prefix(&self.upstream)
            .and_then(|rest| rest.strip_prefix('/'))
        {
            Some(path) => path.to_string(),
            None => format!("docker.io/{}", docker_hub(image)?),
        };
        (!path.is_empty()).then(|| format!("{}/{path}", self.mirror))
    }

    /// Give the image just pulled as `mirrored` the name `image`, then drop the mirror's name. True
    /// when `image` answers now, so nothing has to come from the upstream registry.
    pub(crate) fn adopt(&self, engine: &Address, mirrored: &str, image: &str) -> bool {
        let tag = local_name(image);
        match engine.command().args(["tag", mirrored, &tag]).output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                log::warn!(
                    "[pull] could not name {mirrored} {tag}: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                return false;
            }
            Err(error) => {
                log::warn!("[pull] could not name {mirrored} {tag}: {error}");
                return false;
            }
        }
        self.forget(engine, mirrored, image)
    }

    /// Drop the mirror's name for an image once it answers to `image`. True when it does; when it
    /// does not, the mirror's name stays, so the download is not lost.
    pub(crate) fn forget(&self, engine: &Address, mirrored: &str, image: &str) -> bool {
        if !crate::preparation::image_present(engine, image).unwrap_or(false) {
            return false;
        }
        // An untag: the image has another name now, so nothing is deleted. Failing to untag leaves
        // a second name on the same image, which costs nothing.
        match engine.command().args(["image", "rm", mirrored]).output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => log::warn!(
                "[pull] could not drop the name {mirrored}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => log::warn!("[pull] could not drop the name {mirrored}: {error}"),
        }
        true
    }
}

/// A Docker Hub image's path in Docker Hub's own registry, read as an engine reads a reference:
/// `docker.io/` (or `index.docker.io/`) or no registry at all, and `library/` before an official
/// image's single name. `None` for an image on any other registry.
fn docker_hub(image: &str) -> Option<String> {
    let path = match image.split_once('/') {
        Some((host, rest)) if host == "docker.io" || host == "index.docker.io" => rest,
        Some((host, _)) if host.contains(['.', ':']) || host == "localhost" => return None,
        _ => image,
    };
    let name = &path[..path.find(['@', ':']).unwrap_or(path.len())];
    if name.is_empty() {
        return None;
    }
    Some(if name.contains('/') {
        path.to_string()
    } else {
        format!("library/{path}")
    })
}

/// The tagged name an image from the mirror is given in the upstream registry's repository.
///
/// An engine will not tag with a digest, so a digest-only reference is tagged `sha256-<hex>` after
/// its digest: unique to the image, and never a tag anyone publishes. A reference with a tag keeps
/// its tag.
pub(crate) fn local_name(image: &str) -> String {
    let (name, digest) = match image.split_once('@') {
        Some((name, digest)) => (name, Some(digest)),
        None => (image, None),
    };
    let last = name.rsplit('/').next().unwrap_or_default();
    match digest {
        Some(digest) if !last.contains(':') => format!("{name}:{}", digest.replace(':', "-")),
        _ => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "ghcr.io/copilotkit/openbot-server@sha256:5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d";

    #[test]
    fn asks_the_mirror_for_ghcr_images_by_the_same_path_and_digest() {
        let mirror = Mirror::openbot();
        assert_eq!(
            mirror.mirrored(SERVER).as_deref(),
            Some("downloads.copilotkit.ai/copilotkit/openbot-server@sha256:5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d")
        );
        assert_eq!(
            mirror
                .mirrored("ghcr.io/spiffe/spire-agent:1.15.1")
                .as_deref(),
            Some("downloads.copilotkit.ai/spiffe/spire-agent:1.15.1")
        );
        // Docker Hub's images under `docker.io/`, however they are named: the Compose file's, and
        // the k3s node the CLI hands k3d.
        for (hub, copy) in [
            (
                "pgvector/pgvector:pg17",
                "downloads.copilotkit.ai/docker.io/pgvector/pgvector:pg17",
            ),
            (
                "busybox:1.37",
                "downloads.copilotkit.ai/docker.io/library/busybox:1.37",
            ),
            (
                "docker.io/library/registry:2",
                "downloads.copilotkit.ai/docker.io/library/registry:2",
            ),
            (
                "docker.io/rancher/k3s@sha256:53cf744fe2fabf140cee240d2db70d13a4f2d98f1a13c98f58f457f423096917",
                "downloads.copilotkit.ai/docker.io/rancher/k3s@sha256:53cf744fe2fabf140cee240d2db70d13a4f2d98f1a13c98f58f457f423096917",
            ),
            (
                "index.docker.io/library/nginx",
                "downloads.copilotkit.ai/docker.io/library/nginx",
            ),
        ] {
            assert_eq!(mirror.mirrored(hub).as_deref(), Some(copy), "{hub}");
        }
        // Every other registry is left alone, and so is a host that only starts with the same
        // letters.
        for other in [
            "ghcr.io.example.com/copilotkit/openbot-server:v1",
            "quay.io/keycloak/keycloak:26.0.2",
            "127.0.0.1:5050/openbot-server",
            "localhost/openbot-server",
            "ghcr.io/",
            "docker.io/",
        ] {
            assert_eq!(mirror.mirrored(other), None, "{other}");
        }
    }

    #[test]
    fn names_a_mirrored_image_in_its_own_repository() {
        assert_eq!(
            local_name(SERVER),
            "ghcr.io/copilotkit/openbot-server:sha256-5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d"
        );
        assert_eq!(
            local_name("ghcr.io/spiffe/spire-agent:1.15.1"),
            "ghcr.io/spiffe/spire-agent:1.15.1"
        );
        assert_eq!(
            local_name("127.0.0.1:5000/copilotkit/openbot-server:v1@sha256:abc"),
            "127.0.0.1:5000/copilotkit/openbot-server:v1"
        );
        assert_eq!(
            local_name("127.0.0.1:5000/copilotkit/openbot-server@sha256:abc"),
            "127.0.0.1:5000/copilotkit/openbot-server:sha256-abc"
        );
    }
}

/**
A pull against the real engine. A `registry:2` on loopback stands in for ghcr.io, holding a test image
built and pushed for the test: a random payload over a local base, pushed as an index, as OpenBot's
release images are. The mirror is plain nginx serving that image's files, laid out and typed as
downloads.copilotkit.ai serves them: S3 objects at the registry's paths behind CloudFront, each
manifest with its stored Content-Type, no Docker-Content-Digest, no auth, query strings ignored, and
403 with an XML body for a key it does not hold. Docker treats every 127.0.0.0/8 registry as
insecure by default, so both are plain HTTP on 127.0.0.1. Requests are counted from each server's
own access log. Only test-named containers and images are created, and all of them are removed.

Run with `cargo test --locked --lib image_mirror::live -- --ignored --test-threads=1`.
*/
#[cfg(test)]
mod live {
    use super::*;
    use crate::pull_metrics;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    const REGISTRY: &str = "docker.io/library/registry:2";
    const NGINX: &str = "docker.io/library/nginx:1.31.6-alpine";
    const ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
         application/vnd.docker.distribution.manifest.list.v2+json, \
         application/vnd.oci.image.manifest.v1+json, \
         application/vnd.docker.distribution.manifest.v2+json";

    /// Live tests share Docker. One lab at a time.
    static ONE_LAB: Mutex<()> = Mutex::new(());

    fn docker(args: &[&str]) -> std::process::Output {
        Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("docker should run")
    }

    fn ok(args: &[&str]) -> String {
        let output = docker(args);
        assert!(
            output.status.success(),
            "docker {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// A loopback port nothing listens on now. Docker Desktop forwards a published port to its
    /// engine's own loopback only when the port is named, so the test names it.
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn wait_for(url: &str) {
        let client = reqwest::blocking::Client::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            if client
                .get(url)
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("{url} did not answer");
    }

    struct Lab {
        _one: std::sync::MutexGuard<'static, ()>,
        prefix: String,
        address: Address,
        upstream: String,
        repository: String,
        /// How a release names the image, without its digest: on the upstream registry, or on
        /// Docker Hub by its single name.
        name: String,
        digest: String,
        /// The mirror's files on this computer, before they are copied into nginx.
        tree: PathBuf,
        containers: Vec<String>,
        /// The manifests' paths and stored types, for nginx.
        types: Vec<(String, String)>,
    }

    impl Lab {
        /// A lab whose image is on the upstream registry, or with `hub`, one a release names as a
        /// Docker Hub official image, which the mirror keeps under `docker.io/library/`. The
        /// upstream registry holds it at that path too, only to lay the mirror out from.
        fn new(label: &str, hub: bool) -> Self {
            let one = ONE_LAB
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let unique = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let prefix = format!("openbot-mirror-test-{label}-{unique}");
            let address = Address::new(crate::engine::Engine::Docker, None)
                .pin()
                .expect("Docker answers");
            let port = {
                let _ports = crate::test_support::hold_ports();
                let port = free_port();
                let upstream = format!("{prefix}-upstream");
                ok(&[
                    "run",
                    "-d",
                    "--name",
                    &upstream,
                    "-p",
                    &format!("127.0.0.1:{port}:5000"),
                    REGISTRY,
                ]);
                port
            };
            let upstream = format!("127.0.0.1:{port}");
            let (repository, name) = if hub {
                (format!("docker.io/library/{prefix}"), prefix.clone())
            } else {
                let repository = format!("copilotkit/{prefix}");
                (repository.clone(), format!("{upstream}/{repository}"))
            };
            let mut lab = Self {
                _one: one,
                containers: vec![format!("{prefix}-upstream")],
                address,
                upstream,
                repository,
                name,
                digest: String::new(),
                tree: crate::test_support::temp_root(&format!("mirror-{label}")),
                types: Vec::new(),
                prefix,
            };
            wait_for(&format!("http://{}/v2/", lab.upstream));
            lab.push();
            lab
        }

        /// Make an image with a payload of its own and push it upstream, written straight to the
        /// registry so no build cache on this computer holds any of it: an index naming one Linux
        /// image for this computer, of one layer.
        fn push(&mut self) {
            use sha2::Digest;
            let digest = |bytes: &[u8]| format!("sha256:{:x}", sha2::Sha256::digest(bytes));
            let payload: Vec<u8> = (0..4 * 1024 * 1024).map(|_| rand::random::<u8>()).collect();
            let mut tar = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, "payload", payload.as_slice())
                .unwrap();
            let tar = tar.into_inner().unwrap();
            let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            std::io::Write::write_all(&mut gzip, &tar).unwrap();
            let layer = gzip.finish().unwrap();
            let architecture = crate::registry::host_architecture();
            let config = serde_json::to_vec(&serde_json::json!({
                "architecture": architecture,
                "os": "linux",
                "config": {"Cmd": ["/payload"]},
                "rootfs": {"type": "layers", "diff_ids": [digest(&tar)]},
            }))
            .unwrap();
            let manifest = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "digest": digest(&config),
                    "size": config.len(),
                },
                "layers": [{
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": digest(&layer),
                    "size": layer.len(),
                }],
            }))
            .unwrap();
            let index = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [{
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": digest(&manifest),
                    "size": manifest.len(),
                    "platform": {"architecture": architecture, "os": "linux"},
                }],
            }))
            .unwrap();
            let client = reqwest::blocking::Client::new();
            let base = format!("http://{}/v2/{}", self.upstream, self.repository);
            for blob in [&config, &layer] {
                let started = client
                    .post(format!("{base}/blobs/uploads/"))
                    .send()
                    .unwrap();
                let location = started.headers()["location"].to_str().unwrap().to_string();
                let location = if location.starts_with("http") {
                    location
                } else {
                    format!("http://{}{location}", self.upstream)
                };
                let separator = if location.contains('?') { '&' } else { '?' };
                let put = client
                    .put(format!("{location}{separator}digest={}", digest(blob)))
                    .header("Content-Type", "application/octet-stream")
                    .body(blob.clone())
                    .send()
                    .unwrap();
                assert!(put.status().is_success(), "blob upload: {}", put.status());
            }
            for (reference, kind, body) in [
                (
                    digest(&manifest),
                    "application/vnd.oci.image.manifest.v1+json",
                    &manifest,
                ),
                (
                    "built".to_string(),
                    "application/vnd.oci.image.index.v1+json",
                    &index,
                ),
            ] {
                let put = client
                    .put(format!("{base}/manifests/{reference}"))
                    .header("Content-Type", kind)
                    .body(body.clone())
                    .send()
                    .unwrap();
                assert!(put.status().is_success(), "manifest: {}", put.status());
            }
            self.digest = digest(&index);
            assert!(
                !crate::preparation::image_present(&self.address, &self.image()).unwrap(),
                "the test image is only upstream"
            );
        }

        /// The image as a release names it: the upstream registry, the repository, the digest.
        fn image(&self) -> String {
            format!("{}@{}", self.name, self.digest)
        }

        /// Copy one manifest, and everything it names, from upstream into the mirror's tree.
        fn copy(&mut self, reference: &str) {
            let client = reqwest::blocking::Client::new();
            let path = format!("v2/{}/manifests/{reference}", self.repository);
            let response = client
                .get(format!("http://{}/{path}", self.upstream))
                .header("Accept", ACCEPT)
                .send()
                .unwrap();
            assert!(response.status().is_success(), "{path}");
            let kind = response.headers()["content-type"]
                .to_str()
                .unwrap()
                .to_string();
            let body = response.bytes().unwrap().to_vec();
            self.store(&path, &body);
            self.types.push((path, kind));
            let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
            for entry in manifest["manifests"].as_array().into_iter().flatten() {
                self.copy(entry["digest"].as_str().unwrap());
            }
            let blobs = std::iter::once(&manifest["config"])
                .chain(manifest["layers"].as_array().into_iter().flatten())
                .filter_map(|blob| blob["digest"].as_str())
                .map(str::to_string)
                .collect::<Vec<_>>();
            for blob in blobs {
                let path = format!("v2/{}/blobs/{blob}", self.repository);
                let bytes = client
                    .get(format!("http://{}/{path}", self.upstream))
                    .send()
                    .unwrap()
                    .bytes()
                    .unwrap();
                self.store(&path, &bytes);
            }
        }

        fn store(&self, path: &str, bytes: &[u8]) {
            let file = self.tree.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }

        /// The mirror, holding a faithful copy of the image, as nginx on a loopback port. Its host
        /// and port.
        fn mirror(&mut self) -> String {
            self.copy(&self.digest.clone());
            let locations: String = self
                .types
                .iter()
                .map(|(path, kind)| {
                    format!(
                        "location = /{path} {{ default_type \"{kind}\"; try_files $uri @denied; }}\n"
                    )
                })
                .collect();
            let config = format!(
                r#"events {{}}
http {{
  access_log /dev/stdout;
  error_log /dev/stderr;
  types {{}}
  server {{
    listen 80;
    root /mirror;
    default_type application/octet-stream;
    location = /v2/ {{ default_type application/json; return 200 '{{}}'; }}
    {locations}
    location / {{ try_files $uri @denied; }}
    location @denied {{
      default_type application/xml;
      return 403 '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
    }}
  }}
}}
"#
            );
            std::fs::write(self.tree.join("nginx.conf"), config).unwrap();
            let name = format!("{}-mirror", self.prefix);
            let _ports = crate::test_support::hold_ports();
            let port = free_port();
            ok(&[
                "create",
                "--name",
                &name,
                "-p",
                &format!("127.0.0.1:{port}:80"),
                NGINX,
            ]);
            self.containers.push(name.clone());
            ok(&[
                "cp",
                self.tree.join("nginx.conf").to_str().unwrap(),
                &format!("{name}:/etc/nginx/nginx.conf"),
            ]);
            ok(&[
                "cp",
                &format!("{}/.", self.tree.display()),
                &format!("{name}:/mirror"),
            ]);
            ok(&["start", &name]);
            let mirror = format!("127.0.0.1:{port}");
            wait_for(&format!("http://{mirror}/v2/"));
            // Faithful to the bucket: a key it does not hold is 403, and a query string changes
            // nothing.
            let client = reqwest::blocking::Client::new();
            let missing = client
                .get(format!(
                    "http://{mirror}/v2/{}/manifests/absent",
                    self.repository
                ))
                .send()
                .unwrap();
            assert_eq!(missing.status().as_u16(), 403);
            assert_eq!(missing.headers()["content-type"], "application/xml");
            {
                let index = client
                    .get(format!(
                        "http://{mirror}/v2/{}/manifests/{}?x=1",
                        self.repository, self.digest
                    ))
                    .send()
                    .unwrap();
                assert!(index.status().is_success());
                assert!(index.headers().get("docker-content-digest").is_none());
                assert_eq!(
                    index.headers()["content-type"],
                    "application/vnd.oci.image.index.v1+json"
                );
            }
            mirror
        }

        /// What a server's access log says it was asked for this test's image, by request line.
        fn asked(&self, server: &str, what: &str) -> usize {
            let output = docker(&["logs", &format!("{}-{server}", self.prefix)]);
            let needle = format!("\"GET /v2/{}/{what}/", self.repository);
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .chain(String::from_utf8_lossy(&output.stderr).lines())
                .filter(|line| line.contains(&needle))
                .count()
        }

        fn upstream_blobs(&self) -> usize {
            self.asked("upstream", "blobs")
        }

        fn present(&self, image: &str) -> bool {
            crate::preparation::image_present(&self.address, image).unwrap()
        }

        /// The Install path's pull of the image, asking `mirror` first.
        fn pull(&self, mirror: &str) -> Result<(), crate::problem::Problem> {
            pull_metrics::pull_image_from(
                &self.address,
                &self.image(),
                &Mirror {
                    mirror: mirror.to_string(),
                    upstream: self.upstream.clone(),
                },
                |_| {},
                |_| {},
            )
        }
    }

    impl Drop for Lab {
        fn drop(&mut self) {
            for container in &self.containers {
                let _ = docker(&["rm", "-f", "-v", container]);
            }
            // Every name the test image has, removed by the image's own id: unique to it, because
            // its payload is.
            if !self.digest.is_empty() {
                let _ = docker(&["image", "rm", "-f", &self.digest]);
            }
            let _ = std::fs::remove_dir_all(&self.tree);
        }
    }

    fn assert_upstream_name_only(lab: &Lab, mirror: &str) {
        assert!(lab.present(&lab.image()), "{} answers", lab.image());
        let mirrored = format!("{mirror}/{}@{}", lab.repository, lab.digest);
        assert!(
            !lab.present(&mirrored),
            "the mirror's name is dropped: {mirrored}"
        );
    }

    #[test]
    #[ignore = "needs a Docker engine"]
    fn an_image_the_mirror_holds_comes_from_the_mirror_and_nothing_comes_from_upstream() {
        let mut lab = Lab::new("hit", false);
        let mirror = lab.mirror();
        // Laying out the mirror read the image from upstream; only what follows counts.
        let blobs = lab.upstream_blobs();
        let manifests = lab.asked("upstream", "manifests");
        lab.pull(&mirror).unwrap();
        assert_upstream_name_only(&lab, &mirror);
        assert!(
            lab.asked("mirror", "blobs") > 0,
            "the mirror sent the layers"
        );
        assert_eq!(lab.upstream_blobs(), blobs, "upstream sent no layer");

        // What runs it later, by its upstream name: Install again, the Compose pull Install
        // makes, and a container made from it, whose default is to pull a missing image.
        lab.pull(&mirror).unwrap();
        let project = serde_json::json!({"services": {"image": {"image": lab.image()}}});
        let mut compose = Command::new("docker")
            .args(["compose", "--project-name", &lab.prefix, "-f", "-", "pull"])
            .args(["--policy", "missing"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        compose
            .stdin
            .take()
            .unwrap()
            .write_all(project.to_string().as_bytes())
            .unwrap();
        let compose = compose.wait_with_output().unwrap();
        assert!(
            compose.status.success(),
            "{}",
            String::from_utf8_lossy(&compose.stderr)
        );
        let container = format!("{}-run", lab.prefix);
        lab.containers.push(container.clone());
        ok(&["create", "--name", &container, &lab.image()]);
        assert_eq!(
            lab.upstream_blobs(),
            blobs,
            "nothing later downloaded a layer from upstream"
        );
        assert_eq!(
            lab.asked("upstream", "manifests"),
            manifests,
            "nor asked upstream for the image at all"
        );
    }

    #[test]
    #[ignore = "needs a Docker engine"]
    fn a_docker_hub_image_the_mirror_holds_comes_from_its_docker_io_copy() {
        let mut lab = Lab::new("hub", true);
        let mirror = lab.mirror();
        // Named as the Compose file names Docker Hub's images: no registry, and no `library/`.
        // Docker Hub has no such image, so only the mirror can give it.
        lab.pull(&mirror).unwrap();
        assert_upstream_name_only(&lab, &mirror);
        assert!(
            lab.asked("mirror", "blobs") > 0,
            "the mirror sent the layers from /v2/docker.io/library/"
        );
        assert!(
            lab.present(&format!("docker.io/library/{}", lab.image())),
            "it answers to its Docker Hub name in full too"
        );
        let container = format!("{}-run", lab.prefix);
        lab.containers.push(container.clone());
        ok(&["create", "--name", &container, &lab.image()]);
    }
}
