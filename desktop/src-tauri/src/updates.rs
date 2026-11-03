//! Explicit in-place runtime upgrades. The source archive is staged beside, never over, the
//! active root. The durable journal blocks ordinary repair after any interrupted mutation.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::deployment;

pub const RELEASE: &str = ".openbot-release.json";
pub const BASELINE: &str = ".openbot-vendor-baseline.json";
pub const JOURNAL: &str = ".openbot-update-journal.json";
pub const DISTRIBUTION: &str = ".openbot-distribution.json";
const STAGED: &str = ".openbot-staged-release.json";
const GENERATED: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    ".git",
    ".logs",
    "target",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Distribution {
    pub distribution_id: String,
    pub repository: String,
    pub channel: String,
    #[serde(default)]
    pub intelligence_capabilities: Vec<String>,
}

fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
}
fn text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.trim() == s && !s.chars().any(char::is_control))
}
fn hex(value: &Value, size: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == size
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn object(value: &Value, required: &[&str], optional: &[&str]) -> Result<(), String> {
    let map = value.as_object().ok_or("expected manifest object")?;
    if required.iter().any(|key| !map.contains_key(*key))
        || map
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("missing or unsupported manifest fields".into());
    }
    Ok(())
}
fn strings(value: &Value) -> bool {
    value.as_array().is_some_and(|a| {
        a.iter().all(text)
            && a.iter()
                .map(Value::to_string)
                .collect::<BTreeSet<_>>()
                .len()
                == a.len()
    })
}
fn https(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .is_some_and(|u| {
            u.scheme() == "https"
                && u.has_host()
                && u.username().is_empty()
                && u.password().is_none()
                && u.fragment().is_none()
        })
}
fn source_artifact(value: &Value) -> Result<(), String> {
    if !https(&value["url"]) || !hex(&value["sha256"], 64) {
        return Err("invalid HTTPS source URL or SHA-256".into());
    }
    Ok(())
}

/// Strict native decoder for the shared v1 wire contract (including unknown-field refusal).
pub fn parse_manifest(bytes: &[u8]) -> Result<Value, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    object(
        &v,
        &[
            "schemaVersion",
            "distribution",
            "version",
            "source",
            "artifacts",
            "compatibility",
            "upgrade",
        ],
        &[],
    )?;
    if v["schemaVersion"] != 1 || !text(&v["version"]) {
        return Err("unsupported schema or invalid version".into());
    }
    let d = &v["distribution"];
    object(d, &["id", "repository", "channel"], &[])?;
    if !text(&d["id"]) || !text(&d["channel"]) || !d["repository"].as_str().is_some_and(repository)
    {
        return Err("invalid distribution identity".into());
    }
    let s = &v["source"];
    object(
        s,
        &["commit", "upstreamRepository", "upstreamCommit", "modified"],
        &[],
    )?;
    if !hex(&s["commit"], 40)
        || !hex(&s["upstreamCommit"], 40)
        || !s["upstreamRepository"].as_str().is_some_and(repository)
        || !s["modified"].is_boolean()
    {
        return Err("invalid source identity".into());
    }
    let a = &v["artifacts"];
    object(a, &["source", "images"], &["chart"])?;
    object(&a["source"], &["url", "sha256"], &[])?;
    source_artifact(&a["source"])?;
    let images = a["images"].as_object().ok_or("images must be an object")?;
    if images.is_empty() {
        return Err("empty image manifest".into());
    }
    for (name, image) in images {
        object(image, &["reference"], &[])?;
        let valid_name = !name.is_empty()
            && name.bytes().enumerate().all(|(i, c)| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && b"_-".contains(&c))
            });
        let reference = image["reference"].as_str().unwrap_or("");
        let valid = reference
            .split_once("@sha256:")
            .is_some_and(|(prefix, digest)| {
                !prefix.is_empty()
                    && prefix.bytes().enumerate().all(|(i, c)| {
                        c.is_ascii_lowercase()
                            || c.is_ascii_digit()
                            || (i > 0 && b"./:_-".contains(&c))
                    })
                    && hex(&json!(digest), 64)
            });
        if !valid_name || !valid {
            return Err(format!("unpinned or invalid image {name}"));
        }
    }
    if let Some(chart) = a.get("chart") {
        object(chart, &["version", "url", "sha256"], &[])?;
        source_artifact(chart)?;
        if !text(&chart["version"]) {
            return Err("invalid chart version".into());
        }
    }
    let c = &v["compatibility"];
    object(
        c,
        &[
            "launcherApi",
            "configSchema",
            "extensionApi",
            "database",
            "intelligenceCapabilities",
        ],
        &[],
    )?;
    for key in ["launcherApi", "configSchema", "extensionApi"] {
        if !c[key]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        {
            return Err(format!("invalid {key}"));
        }
    }
    object(&c["database"], &["from", "to", "rollbackCompatible"], &[])?;
    if !strings(&c["database"]["from"])
        || !text(&c["database"]["to"])
        || !c["database"]["rollbackCompatible"].is_boolean()
        || !strings(&c["intelligenceCapabilities"])
    {
        return Err("invalid database or Intelligence contract".into());
    }
    let u = &v["upgrade"];
    object(u, &["fromVersions", "requiresDowntime", "recovery"], &[])?;
    if !strings(&u["fromVersions"])
        || !u["requiresDowntime"].is_boolean()
        || !matches!(
            u["recovery"].as_str(),
            Some("restart-previous" | "restore-backup")
        )
        || (c["database"]["rollbackCompatible"] == false && u["recovery"] == "restart-previous")
    {
        return Err("invalid or incoherent recovery contract".into());
    }
    Ok(v)
}

pub fn distribution_defaults(
    id: Option<&str>,
    repository: Option<&str>,
    channel: Option<&str>,
) -> Distribution {
    let repository = repository
        .filter(|v| !v.is_empty())
        .unwrap_or("CopilotKit/OpenBot");
    Distribution {
        distribution_id: id.filter(|v| !v.is_empty()).unwrap_or(repository).into(),
        repository: repository.into(),
        channel: channel.filter(|v| !v.is_empty()).unwrap_or("stable").into(),
        intelligence_capabilities: Vec::new(),
    }
}

pub fn compiled_distribution() -> Distribution {
    distribution_defaults(
        option_env!("OPENBOT_DISTRIBUTION_ID"),
        option_env!("OPENBOT_RELEASE_REPOSITORY"),
        option_env!("OPENBOT_RELEASE_CHANNEL"),
    )
}

pub fn distribution(root: &Path) -> Result<Distribution, String> {
    let policy = match std::fs::read(root.join(DISTRIBUTION)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid {DISTRIBUTION}: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => compiled_distribution(),
        Err(e) => return Err(e.to_string()),
    };
    if policy.distribution_id.trim().is_empty()
        || policy.channel.trim().is_empty()
        || !repository(&policy.repository)
    {
        return Err("invalid configured distribution".into());
    }
    Ok(policy)
}
fn tag(version: &str) -> Result<&str, String> {
    if version.is_empty()
        || !version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("enter an exact release tag".into());
    }
    Ok(version)
}
pub fn manifest_url(policy: &Distribution, version: &str) -> Result<String, String> {
    Ok(format!(
        "https://github.com/{}/releases/download/{}/release-manifest.json",
        policy.repository,
        tag(version)?
    ))
}
pub fn latest_url(policy: &Distribution) -> String {
    format!(
        "https://api.github.com/repos/{}/releases/latest",
        policy.repository
    )
}
fn identity(manifest: &Value, policy: &Distribution, reasons: &mut Vec<String>) {
    let d = &manifest["distribution"];
    if d["id"] != policy.distribution_id
        || !d["repository"]
            .as_str()
            .is_some_and(|r| r.eq_ignore_ascii_case(&policy.repository))
        || d["channel"] != policy.channel
    {
        reasons.push(
            "release distribution, repository or channel does not match configured policy".into(),
        );
    }
}

pub fn plan(current: &Value, candidate: &Value, policy: &Distribution, source_kind: &str) -> Value {
    let mut reasons = Vec::new();
    identity(current, policy, &mut reasons);
    identity(candidate, policy, &mut reasons);
    if matches!(source_kind, "unknown" | "forked") {
        reasons.push(format!(
            "{source_kind} source requires a verified baseline or upstream integration"
        ));
    }
    for key in ["launcherApi", "configSchema", "extensionApi"] {
        if candidate["compatibility"][key] != 1 {
            reasons.push(format!("unsupported {key}"));
        }
    }
    if !candidate["upgrade"]["fromVersions"]
        .as_array()
        .is_some_and(|v| v.contains(&current["version"]))
    {
        reasons.push("unsupported starting release".into());
    }
    if !candidate["compatibility"]["database"]["from"]
        .as_array()
        .is_some_and(|v| v.contains(&current["compatibility"]["database"]["to"]))
    {
        reasons.push("unsupported starting database".into());
    }
    for capability in candidate["compatibility"]["intelligenceCapabilities"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !policy
            .intelligence_capabilities
            .iter()
            .any(|c| capability == c)
        {
            reasons.push(format!("missing Intelligence capability {capability}"));
        }
    }
    json!({"allowed": reasons.is_empty(), "reasons": reasons, "fromVersion": current["version"], "toVersion":candidate["version"], "requiresDowntime":candidate["upgrade"]["requiresDowntime"], "recovery":candidate["upgrade"]["recovery"]})
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Baseline {
    source_sha256: String,
    commit: String,
    files: BTreeMap<String, String>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn io(error: std::io::Error) -> String {
    error.to_string()
}
fn read_manifest(path: &Path) -> Result<Value, String> {
    parse_manifest(&std::fs::read(path).map_err(io)?)
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp).map_err(io)?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(io)?;
    file.sync_all().map_err(io)?;
    std::fs::rename(&temp, path).map_err(io)?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("record has no parent")?)
        .map_err(io)?
        .sync_all()
        .map_err(io)?;
    Ok(())
}
fn sibling(root: &Path, suffix: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(io)?;
    let name = root
        .file_name()
        .ok_or("installation root has no name")?
        .to_string_lossy();
    Ok(root
        .parent()
        .ok_or("installation root has no parent")?
        .join(format!(".{name}.openbot-update-{suffix}")))
}
pub fn stage_path(root: &Path) -> Result<PathBuf, String> {
    sibling(root, "stage")
}
/// Serialize already parsed native relative components without using the host path separator.
/// A Windows PathBuf displays backslashes; inventory/journal keys must always use `/`.
fn filesystem_relative_key(path: &Path) -> Result<String, String> {
    let mut names = Vec::new();
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("unsafe vendor path".into());
        };
        let name = name.to_str().ok_or("vendor path is not valid UTF-8")?;
        if name.is_empty() || name.contains(['\\', '/', ':']) {
            return Err("unsafe vendor path".into());
        }
        names.push(name);
    }
    if names.is_empty() {
        return Err("unsafe vendor path".into());
    }
    Ok(names.join("/"))
}

/// Serialized baseline/archive spelling is untrusted: backslashes are never normalized into
/// separators here, even on Windows. Native filesystem paths use the component helper above.
fn relative(path: &Path) -> Result<String, String> {
    if path.to_string_lossy().contains(['\\', ':']) {
        return Err("unsafe vendor path".into());
    }
    filesystem_relative_key(path)
}

fn managed(path: &Path, preserved: &[PathBuf]) -> bool {
    if preserved.iter().any(|p| path.starts_with(p)) {
        return false;
    }
    let names: Vec<_> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    if names.iter().any(|n| {
        GENERATED.contains(&n.as_ref()) || n.starts_with(".env") || n.starts_with(".openbot")
    }) {
        return false;
    }
    let Some(first) = names.first() else {
        return false;
    };
    if first == "examples" || first.starts_with("docker-compose.override") {
        return false;
    }
    deployment::REQUIRED.contains(&first.as_ref())
        || deployment::ALSO_COPIED.contains(&first.as_ref())
}
fn preserved_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let settings =
        crate::env::read_already_set(&root.join(".env"), &["TENANT_PACKAGE_DIR"]).map_err(io)?;
    let mut result = vec![PathBuf::from("examples")];
    if let Some(value) = settings.get("TENANT_PACKAGE_DIR") {
        // This setting is resolved by the server from its own working directory.
        let path = root.join("server").join(value);
        if path.exists() {
            let resolved = std::fs::canonicalize(path).map_err(io)?;
            let active = std::fs::canonicalize(root).map_err(io)?;
            if let Ok(relative) = resolved.strip_prefix(active) {
                result.push(relative.to_path_buf());
            }
        }
    }
    Ok(result)
}
fn inventory(root: &Path, preserved: &[PathBuf]) -> Result<BTreeMap<String, String>, String> {
    fn walk(
        root: &Path,
        path: &Path,
        preserved: &[PathBuf],
        files: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(root.join(path)).map_err(io)? {
            let entry = entry.map_err(io)?;
            let path = path.join(entry.file_name());
            if !managed(&path, preserved) {
                continue;
            }
            let kind = entry.file_type().map_err(io)?;
            if kind.is_symlink() {
                return Err(format!(
                    "vendor symlink requires manual integration: {}",
                    path.display()
                ));
            }
            if kind.is_dir() {
                walk(root, &path, preserved, files)?;
            } else if kind.is_file() {
                files.insert(
                    filesystem_relative_key(&path)?,
                    digest(&std::fs::read(root.join(path)).map_err(io)?),
                );
            } else {
                return Err("non-regular vendor file".into());
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(root, Path::new(""), preserved, &mut files)?;
    Ok(files)
}
fn baseline(root: &Path, manifest: &Value, preserved: &[PathBuf]) -> Result<Baseline, String> {
    let saved: Baseline = serde_json::from_slice(&std::fs::read(root.join(BASELINE)).map_err(|_| "Unknown vendor baseline. Establish a separately verified source archive and accepted release before updating; clean Git status is insufficient.".to_string())?).map_err(|e| e.to_string())?;
    if manifest["artifacts"]["source"]["sha256"] != saved.source_sha256
        || manifest["source"]["commit"] != saved.commit
    {
        return Err("accepted manifest and baseline identity differ".into());
    }
    let expected: BTreeMap<_, _> = saved
        .files
        .iter()
        .filter(|(p, _)| managed(Path::new(p), preserved))
        .map(|(p, h)| (p.clone(), h.clone()))
        .collect();
    if expected != inventory(root, preserved)? {
        return Err("Managed source was modified, added or removed. Integrate upstream changes before updating this fork.".into());
    }
    Ok(saved)
}

pub fn require_no_interruption(root: &Path) -> Result<(), String> {
    if root.join(JOURNAL).exists() {
        return Err(format!("An interrupted runtime update requires recovery. Keep OpenBot stopped and inspect {}. Ordinary Start/Repair cannot overwrite it.",root.join(JOURNAL).display()));
    }
    Ok(())
}
fn current(root: &Path) -> Result<Value, String> {
    read_manifest(&root.join(RELEASE)).map_err(|e| format!("No verified accepted release: {e}. Legacy installs require explicit baseline establishment; updates cannot infer provenance."))
}
/// Explicit adoption uses the installed pin and independently configured publisher, then compares
/// every managed source leaf with the checksum-verified archive. It never rewrites source.
pub fn establish_baseline(root: &Path) -> Result<Value, String> {
    require_no_interruption(root)?;
    let installed=deployment::installed(root).ok_or("No installed release pin exists. Restore the original installation record before establishing a baseline.")?;
    let policy = distribution(root)?;
    let manifest = read_candidate(&policy, &installed.version)?;
    let archive = deployment::get(
        manifest["artifacts"]["source"]["url"]
            .as_str()
            .ok_or("missing source URL")?,
    )?;
    establish_baseline_bytes(root, &manifest, &policy, &archive)
}
fn establish_baseline_bytes(
    root: &Path,
    manifest: &Value,
    policy: &Distribution,
    archive: &[u8],
) -> Result<Value, String> {
    require_no_interruption(root)?;
    if root.join(RELEASE).exists() || root.join(BASELINE).exists() {
        return Err(
            "An accepted release or baseline already exists; adoption cannot overwrite it.".into(),
        );
    }
    if deployment::installed(root).map(|i| i.version).as_deref() != manifest["version"].as_str() {
        return Err("verified manifest does not match installed pin".into());
    }
    let mut reasons = Vec::new();
    identity(manifest, policy, &mut reasons);
    if !reasons.is_empty() || manifest["artifacts"]["source"]["sha256"] != digest(archive) {
        return Err("baseline publisher identity or source checksum mismatch".into());
    }
    let scratch = sibling(root, "baseline")?;
    if scratch.exists() {
        return Err(format!(
            "Baseline verification directory already exists: {}",
            scratch.display()
        ));
    }
    std::fs::create_dir(&scratch).map_err(io)?;
    let result = (|| {
        unpack_safe(&scratch, archive)?;
        let preserved = preserved_paths(root)?;
        source_database_identity(&scratch, manifest)?;
        let files = inventory(&scratch, &preserved)?;
        if files != inventory(root, &preserved)? {
            return Err("Installed managed source differs from the published pinned archive. Integrate the fork; no baseline was accepted.".into());
        }
        let saved = Baseline {
            source_sha256: digest(archive),
            commit: manifest["source"]["commit"]
                .as_str()
                .ok_or("missing commit")?
                .into(),
            files,
        };
        write_json(&root.join(BASELINE), &saved)?;
        write_json(&root.join(RELEASE), manifest)?;
        Ok(json!({"version":manifest["version"],"baselineVerified":true}))
    })();
    std::fs::remove_dir_all(&scratch).map_err(io)?;
    result
}

pub fn check(root: &Path, version: &str) -> Result<Value, String> {
    require_no_interruption(root)?;
    let policy = distribution(root)?;
    let candidate = read_candidate(&policy, version)?;
    let current = current(root)?;
    let preserved = preserved_paths(root)?;
    baseline(root, &current, &preserved)?;
    Ok(plan(&current, &candidate, &policy, "extended"))
}
fn read_candidate(policy: &Distribution, version: &str) -> Result<Value, String> {
    let candidate = parse_manifest(&deployment::get(&manifest_url(policy, version)?)?)?;
    if candidate["version"] != version {
        return Err("candidate version does not match requested tag".into());
    }
    let mut reasons = Vec::new();
    identity(&candidate, policy, &mut reasons);
    if !reasons.is_empty() {
        return Err(reasons.join("; "));
    }
    Ok(candidate)
}

fn unpack_safe(destination: &Path, body: &[u8]) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(body));
    let mut seen = BTreeSet::new();
    for entry in archive.entries().map_err(io)? {
        let entry = entry.map_err(io)?;
        // Validate the archive spelling before PathBuf reconstruction introduces native Windows
        // separators. Entry::path_bytes also includes GNU/PAX long-path records.
        if entry
            .path_bytes()
            .iter()
            .any(|byte| matches!(byte, b'\\' | b':'))
        {
            return Err("unsafe archive path spelling".into());
        }
        let path = entry.path().map_err(io)?.into_owned();
        let mut parts = path.components();
        if !matches!(parts.next(), Some(Component::Normal(_))) {
            return Err("unsafe archive root".into());
        }
        let relative_path: PathBuf = parts.collect();
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        filesystem_relative_key(&relative_path)?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("archive links and special files are refused".into());
        }
        if !seen.insert(relative_path.clone()) {
            return Err("duplicate archive path".into());
        }
    }
    // The existing deployment filter retains only runtime source. The safety pass above rejects
    // links before any archive entry is unpacked, including links outside the copied tree.
    deployment::unpack(destination, body)
}

pub fn stage(root: &Path, version: &str) -> Result<Value, String> {
    require_no_interruption(root)?;
    let policy = distribution(root)?;
    let candidate = read_candidate(&policy, version)?;
    let archive = deployment::get(
        candidate["artifacts"]["source"]["url"]
            .as_str()
            .ok_or("missing source URL")?,
    )?;
    stage_bytes(root, &candidate, &policy, &archive)
}
fn stage_bytes(
    root: &Path,
    candidate: &Value,
    policy: &Distribution,
    archive: &[u8],
) -> Result<Value, String> {
    require_no_interruption(root)?;
    let current = current(root)?;
    let preserved = preserved_paths(root)?;
    baseline(root, &current, &preserved)?;
    let planned = plan(&current, candidate, policy, "extended");
    if planned["allowed"] != true {
        return Err(planned["reasons"].to_string());
    }
    if candidate["artifacts"]["source"]["sha256"] != digest(archive) {
        return Err("candidate source SHA-256 mismatch; active installation is unchanged".into());
    }
    let staged = stage_path(root)?;
    if staged.exists() {
        return Err(format!("A staged candidate already exists at {}. Inspect or remove that sibling directory before staging another.",staged.display()));
    }
    std::fs::create_dir(&staged).map_err(io)?;
    let result = (|| {
        unpack_safe(&staged, archive)?;
        let package: Value =
            serde_json::from_slice(&std::fs::read(staged.join("package.json")).map_err(io)?)
                .map_err(|e| e.to_string())?;
        if package["version"].as_str()
            != candidate["version"]
                .as_str()
                .map(|v| v.trim_start_matches('v'))
        {
            return Err("candidate package version differs from manifest".into());
        }
        for path in deployment::REQUIRED {
            if !staged.join(path).exists() {
                return Err(format!("partial candidate: missing {path}"));
            }
        }
        let images: deployment::Images = serde_json::from_value(
            json!({"version":candidate["version"],"images":candidate["artifacts"]["images"]}),
        )
        .map_err(|e| e.to_string())?;
        deployment::pin(&images)?;
        write_json(&deployment::images_path(&staged), &images)?;
        source_database_identity(&staged, candidate)?;
        let files = inventory(&staged, &preserved)?;
        if files.is_empty() {
            return Err("empty vendor candidate".into());
        }
        write_json(
            &staged.join(BASELINE),
            &Baseline {
                source_sha256: digest(archive),
                commit: candidate["source"]["commit"].as_str().unwrap().into(),
                files,
            },
        )?;
        write_json(&staged.join(STAGED), candidate)?;
        Ok(
            json!({"version":candidate["version"],"stagePath":staged,"plan":planned,"shellUpdate":crate::shell_updates::delivery_status()}),
        )
    })();
    if result.is_err() {
        std::fs::remove_dir_all(&staged)
            .map_err(|e| format!("staging failed and cleanup failed: {e}"))?;
    }
    result
}

fn source_database_identity(root: &Path, manifest: &Value) -> Result<String, String> {
    let journal: Value = serde_json::from_slice(
        &std::fs::read(root.join("server/drizzle/meta/_journal.json")).map_err(io)?,
    )
    .map_err(|e| e.to_string())?;
    let tag = journal["entries"]
        .as_array()
        .and_then(|a| a.last())
        .and_then(|e| e["tag"].as_str())
        .ok_or("source migration journal has no final tag")?;
    if manifest["compatibility"]["database"]["to"] != tag {
        return Err("release database identity differs from its source migration journal".into());
    }
    Ok(tag.into())
}
pub fn accepted_database_identity(root: &Path) -> Result<String, String> {
    source_database_identity(root, &current(root)?)
}

pub fn staged_manifest(root: &Path) -> Result<Value, String> {
    read_manifest(&stage_path(root)?.join(STAGED))
}
pub fn candidate_images(candidate: &Value) -> Result<Vec<String>, String> {
    let images = candidate["artifacts"]["images"]
        .as_object()
        .ok_or("missing candidate images")?;
    Ok(images
        .values()
        .map(|image| image["reference"].as_str().unwrap_or("").into())
        .collect())
}
pub fn mark_images_staged(root: &Path, engine: crate::engine::Engine) -> Result<(), String> {
    let candidate = staged_manifest(root)?;
    write_json(
        &stage_path(root)?.join(".openbot-staged-images.json"),
        &json!({"engine":engine,"images":candidate_images(&candidate)?}),
    )
}
pub fn require_staged_images(root: &Path, engine: crate::engine::Engine) -> Result<(), String> {
    let record: Value = serde_json::from_slice(
        &std::fs::read(stage_path(root)?.join(".openbot-staged-images.json")).map_err(|_| {
            "Candidate images have not finished staging on this installation's saved engine"
                .to_string()
        })?,
    )
    .map_err(|e| e.to_string())?;
    if record != json!({"engine":engine,"images":candidate_images(&staged_manifest(root)?)?}) {
        return Err("staged images belong to another engine or candidate".into());
    }
    Ok(())
}

pub fn runtime_build_environment(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = root.join(JOURNAL);
    let manifest = if path.exists() {
        let journal: Journal =
            serde_json::from_slice(&std::fs::read(path).map_err(io)?).map_err(|e| e.to_string())?;
        parse_manifest(&serde_json::to_vec(&journal.candidate).map_err(|e| e.to_string())?)?
    } else if root.join(RELEASE).exists() {
        current(root)?
    } else {
        return Ok(BTreeMap::new());
    };
    let mut result = BTreeMap::new();
    for (key, value) in [
        ("VERSION", &manifest["version"]),
        ("COMMIT", &manifest["source"]["commit"]),
        ("DISTRIBUTION_ID", &manifest["distribution"]["id"]),
        ("REPOSITORY", &manifest["distribution"]["repository"]),
        ("CHANNEL", &manifest["distribution"]["channel"]),
    ] {
        result.insert(
            format!("OPENBOT_BUILD_{key}"),
            value.as_str().ok_or("invalid build identity")?.into(),
        );
    }
    Ok(result)
}
pub fn verify_release_endpoint(port: u16, candidate: &Value) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("http://127.0.0.1:{port}/release"))
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("candidate /release answered {}", response.status()));
    }
    let identity: Value = response.json().map_err(|e| e.to_string())?;
    verify_release_identity(&identity, candidate)
}
fn verify_release_identity(identity: &Value, candidate: &Value) -> Result<(), String> {
    if identity["version"] != candidate["version"]
        || identity["commit"] != candidate["source"]["commit"]
        || identity["distributionId"] != candidate["distribution"]["id"]
        || identity["repository"] != candidate["distribution"]["repository"]
        || identity["channel"] != candidate["distribution"]["channel"]
    {
        return Err("running API release identity does not match the staged candidate".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub phase: String,
    pub from_version: String,
    pub to_version: String,
    backup: PathBuf,
    previous: Baseline,
    next: Baseline,
    pub candidate: Value,
}
fn checkpoint(root: &Path, journal: &mut Journal, phase: &str) -> Result<(), String> {
    journal.phase = phase.into();
    write_json(&root.join(JOURNAL), journal)
}
fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("file has no parent")?;
    std::fs::create_dir_all(parent).map_err(io)?;
    if std::fs::symlink_metadata(destination).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("refusing to replace a symlink".into());
    }
    std::fs::copy(source, destination).map_err(io)?;
    // Windows FlushFileBuffers (sync_all) requires GENERIC_WRITE. File::open is read-only;
    // reopening without truncation preserves the copied bytes while making the flush valid.
    std::fs::OpenOptions::new()
        .write(true)
        .open(destination)
        .map_err(io)?
        .sync_all()
        .map_err(io)
}
fn replace(
    root: &Path,
    source: &Path,
    old: &Baseline,
    new: &Baseline,
    preserved: &[PathBuf],
) -> Result<(), String> {
    for path in old
        .files
        .keys()
        .filter(|p| managed(Path::new(p), preserved) && !new.files.contains_key(*p))
    {
        let path = relative(Path::new(path))?;
        match std::fs::remove_file(root.join(path)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io(e)),
        }
    }
    for path in new
        .files
        .keys()
        .filter(|p| managed(Path::new(p), preserved))
    {
        let path = relative(Path::new(path))?;
        copy_file(&source.join(&path), &root.join(path))?;
    }
    Ok(())
}

/// Called while the shell's updater exclusion is held, before stopping anything. Incompatible DB
/// upgrades are deliberately refused until a verified database backup/restore path is configured.
pub fn prepare_apply(root: &Path) -> Result<Journal, String> {
    require_no_interruption(root)?;
    let policy = distribution(root)?;
    let current = current(root)?;
    let preserved = preserved_paths(root)?;
    let previous = baseline(root, &current, &preserved)?;
    let staged = stage_path(root)?;
    let candidate = read_manifest(&staged.join(STAGED))?;
    let planned = plan(&current, &candidate, &policy, "extended");
    if planned["allowed"] != true {
        return Err(planned["reasons"].to_string());
    }

    let next: Baseline = serde_json::from_slice(&std::fs::read(staged.join(BASELINE)).map_err(io)?)
        .map_err(|e| e.to_string())?;
    if inventory(&staged, &preserved)? != next.files
        || candidate["source"]["commit"] != next.commit
        || candidate["artifacts"]["source"]["sha256"] != next.source_sha256
    {
        return Err("staged candidate changed or is partial".into());
    }
    let backup = sibling(root, "backup")?;
    if backup.exists() {
        return Err(format!("Previous vendor backup exists at {}; preserve or archive it before applying another release.",backup.display()));
    }
    Ok(Journal {
        phase: "planned".into(),
        from_version: current["version"].as_str().unwrap().into(),
        to_version: candidate["version"].as_str().unwrap().into(),
        backup,
        previous,
        next,
        candidate,
    })
}

/// Stop has completed before this function is called. Back up every replaced leaf first, then
/// journal before the first vendor mutation. Customer files and directory identities never move.
pub fn backup_vendor(root: &Path, journal: &mut Journal) -> Result<(), String> {
    let preserved = preserved_paths(root)?;
    baseline(root, &current(root)?, &preserved)?;
    std::fs::create_dir(&journal.backup).map_err(io)?;
    for path in journal
        .previous
        .files
        .keys()
        .filter(|p| managed(Path::new(p), &preserved))
    {
        relative(Path::new(path))?;
        copy_file(&root.join(path), &journal.backup.join(path))?;
    }
    for path in ["container-images.json", ".openbot-deployment"] {
        copy_file(&root.join(path), &journal.backup.join(path))?;
    }
    checkpoint(root, journal, "vendor-backed-up")
}
pub fn database_backup_path(journal: &Journal) -> PathBuf {
    journal.backup.join("postgres.dump")
}
pub fn install_candidate(root: &Path, journal: &mut Journal) -> Result<(), String> {
    if journal.phase == "planned" {
        backup_vendor(root, journal)?;
    }
    let preserved = preserved_paths(root)?;
    checkpoint(root, journal, "replacing-vendor")?;
    replace(
        root,
        &stage_path(root)?,
        &journal.previous,
        &journal.next,
        &preserved,
    )?;
    copy_file(
        &deployment::images_path(&stage_path(root)?),
        &deployment::images_path(root),
    )?;
    checkpoint(root, journal, "preparing")
}
pub fn mark_starting(root: &Path, journal: &mut Journal) -> Result<(), String> {
    // Existing Start runs SQL migrations. From this checkpoint onward no automatic file rollback
    // claims to undo SQL; a failed or interrupted start stays stopped with its durable journal.
    checkpoint(root, journal, "migration-startup-verification")
}
pub fn rollback_preparation(root: &Path, journal: &mut Journal) -> Result<(), String> {
    if journal.phase == "migration-startup-verification" {
        return Err("Migration may have run. Keep the runtime stopped and follow operator recovery; restoring source files cannot undo SQL.".into());
    }
    let preserved = preserved_paths(root)?;
    replace(
        root,
        &journal.backup,
        &journal.next,
        &journal.previous,
        &preserved,
    )?;
    for path in ["container-images.json", ".openbot-deployment"] {
        copy_file(&journal.backup.join(path), &root.join(path))?;
    }
    crate::preparation::invalidate(root).map_err(|p| p.said)?;
    checkpoint(root, journal, "previous-vendor-restored")?;
    // A completed restoration leaves the old accepted manifest and baseline in force. Repair can
    // prepare the previous release again; the backup is retained for inspection.
    std::fs::remove_file(root.join(JOURNAL)).map_err(io)
}
pub fn accept(root: &Path, journal: &mut Journal) -> Result<Value, String> {
    let preserved = preserved_paths(root)?;
    if inventory(root, &preserved)? != journal.next.files {
        return Err("candidate source identity changed during startup".into());
    }
    checkpoint(root, journal, "verified")?;
    // Accepted metadata is the final promotion, after owned startup and readiness succeeded.
    deployment::record(root, &journal.to_version).map_err(io)?;
    crate::preparation::rebind_after_runtime_update(root).map_err(|p| p.said)?;
    write_json(&root.join(BASELINE), &journal.next)?;
    write_json(&root.join(RELEASE), &journal.candidate)?;
    checkpoint(root, journal, "accepted")?;
    std::fs::remove_file(root.join(JOURNAL)).map_err(io)?;
    Ok(
        json!({"version":journal.to_version,"root":root,"backupPath":journal.backup,"shellUpdate":crate::shell_updates::delivery_status()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../shared/fixtures/releases")
                .join(name),
        )
        .unwrap()
    }
    #[test]
    fn updates_vendor_copy_overwrites_and_durably_syncs_the_destination() {
        let root = temp_root("updates-copy-sync");
        std::fs::create_dir_all(&root).unwrap();
        let (source, destination) = (root.join("source"), root.join("destination"));
        std::fs::write(&destination, b"previous vendor").unwrap();
        for contents in [
            b"candidate vendor".as_slice(),
            b"restored vendor".as_slice(),
        ] {
            std::fs::write(&source, contents).unwrap();
            copy_file(&source, &destination)
                .expect("copied file flush requires a writable handle on Windows");
            assert_eq!(std::fs::read(&destination).unwrap(), contents);
        }
        std::fs::rename(&destination, root.join("retained-copy")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updates_native_inventory_keys_are_portable_and_round_trip() {
        let root = temp_root("updates-portable-keys");
        let native = PathBuf::from("server").join("src").join("main.ts");
        write(&root, &native.to_string_lossy(), b"managed source");
        let files = inventory(&root, &[]).unwrap();
        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            vec!["server/src/main.ts"]
        );
        assert_eq!(
            filesystem_relative_key(&native).unwrap(),
            "server/src/main.ts"
        );
        let stored = serde_json::to_vec(&files).unwrap();
        let restored: BTreeMap<String, String> = serde_json::from_slice(&stored).unwrap();
        for (key, hash) in restored {
            assert_eq!(
                digest(&std::fs::read(root.join(relative(Path::new(&key)).unwrap())).unwrap()),
                hash
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn updates_archive_spelling_stays_strict_across_platforms() {
        for spelling in [
            r"release/server\src\main.ts",
            "release/../escape",
            "/release/server/main.ts",
            "C:/release/server/main.ts",
        ] {
            let root = temp_root("updates-unsafe-spelling");
            std::fs::create_dir_all(&root).unwrap();
            let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            header.as_mut_bytes()[..spelling.len()].copy_from_slice(spelling.as_bytes());
            header.set_cksum();
            archive.append(&header, std::io::empty()).unwrap();
            let bytes = archive.into_inner().unwrap().finish().unwrap();
            assert!(unpack_safe(&root, &bytes).is_err(), "{spelling}");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
            std::fs::remove_dir_all(root).unwrap();
        }
        for spelling in [r"server\src\main.ts", "../escape", "/absolute", "C:/drive"] {
            assert!(relative(Path::new(spelling)).is_err(), "{spelling}");
        }
    }

    #[test]
    fn updates_native_distribution_defaults_conform_to_publisher() {
        let vectors: Vec<Value> = serde_json::from_slice(include_bytes!(
            "../test-fixtures/publisher-distribution.json"
        ))
        .unwrap();
        for vector in vectors {
            let actual = distribution_defaults(
                vector["distributionId"].as_str(),
                vector["repository"].as_str(),
                vector["channel"].as_str(),
            );
            assert_eq!(
                json!({"id":actual.distribution_id,"repository":actual.repository,"channel":actual.channel}),
                vector["expected"],
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn updates_accepts_the_common_release_fixture_and_refuses_unknown_fields() {
        let mut manifest =
            parse_manifest(&fixture("candidate.json")).expect("common candidate fixture");
        manifest["surprise"] = Value::Bool(true);
        assert!(parse_manifest(&serde_json::to_vec(&manifest).unwrap()).is_err());
    }
    #[test]
    fn updates_runtime_identity_requires_candidate_version_commit_and_distribution() {
        let candidate = parse_manifest(&fixture("candidate.json")).unwrap();
        let mut identity = json!({"version":candidate["version"],"commit":candidate["source"]["commit"],"distributionId":candidate["distribution"]["id"],"repository":candidate["distribution"]["repository"],"channel":candidate["distribution"]["channel"]});
        verify_release_identity(&identity, &candidate).unwrap();
        for field in [
            "version",
            "commit",
            "distributionId",
            "repository",
            "channel",
        ] {
            let previous = identity[field].clone();
            identity[field] = json!("different");
            assert!(
                verify_release_identity(&identity, &candidate).is_err(),
                "{field}"
            );
            identity[field] = previous;
        }
    }
    #[test]
    fn updates_shared_conformance_fixtures() {
        let vectors: Value = serde_json::from_slice(&fixture("conformance.json")).unwrap();
        for vector in vectors["parse"].as_array().unwrap() {
            assert_eq!(
                parse_manifest(&fixture(vector["file"].as_str().unwrap())).is_ok(),
                vector["valid"],
                "{}",
                vector["name"]
            );
        }
        let current = parse_manifest(&fixture("installed.json")).unwrap();
        let candidate = parse_manifest(&fixture("candidate.json")).unwrap();
        let mut policy: Distribution =
            serde_json::from_value(vectors["plan"]["policy"].clone()).unwrap();
        policy.intelligence_capabilities = vec!["conversations.v1".into()];
        assert_eq!(
            plan(&current, &candidate, &policy, "extended"),
            vectors["plan"]["expected"]
        );
        assert_eq!(
            plan(&current, &candidate, &policy, "unknown")["allowed"],
            false
        );
        assert_eq!(
            plan(&current, &candidate, &policy, "forked")["allowed"],
            false
        );
        policy.repository = "other/repository".into();
        assert_eq!(
            plan(&current, &candidate, &policy, "extended")["allowed"],
            false
        );
    }

    struct Installation {
        root: PathBuf,
        candidate: Value,
        policy: Distribution,
        archive: Vec<u8>,
    }
    impl Drop for Installation {
        fn drop(&mut self) {
            for name in ["stage", "backup"] {
                if let Ok(p) = sibling(&self.root, name) {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn write(root: &Path, path: &str, contents: &[u8]) {
        std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        std::fs::write(root.join(path), contents).unwrap();
    }
    fn archive(version: &str, contents: &str) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for (path, body) in [
            ("package.json", format!("{{\"version\":\"{version}\"}}")),
            ("server/src/main.ts", contents.into()),
            ("app/src/main.ts", contents.into()),
            ("worker/src/main.ts", contents.into()),
            ("docker-compose.yml", "services: {}".into()),
            (
                "server/drizzle/meta/_journal.json",
                "{\"entries\":[{\"tag\":\"openbot-db-1\",\"when\":1}]}".into(),
            ),
            ("server/drizzle/openbot-db-1.sql", "select 1;".into()),
            (
                "examples/fintech/custom.ts",
                "vendor must not replace tenant".into(),
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("release/{path}"), body.as_bytes())
                .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }
    fn installation() -> Installation {
        let root = temp_root("updates");
        std::fs::create_dir_all(&root).unwrap();
        let old_archive = archive("0.2.0", "previous");
        unpack_safe(&root, &old_archive).unwrap();
        let mut current = parse_manifest(&fixture("installed.json")).unwrap();
        current["artifacts"]["source"]["sha256"] = json!(digest(&old_archive));
        let mut candidate = parse_manifest(&fixture("candidate.json")).unwrap();
        let archive = archive("0.3.0", "candidate");
        candidate["artifacts"]["source"]["sha256"] = json!(digest(&archive));
        for (name, _) in deployment::IMAGE_VARIABLES {
            candidate["artifacts"]["images"][name] =
                json!({"reference":format!("ghcr.io/acme/{name}@sha256:{}","b".repeat(64))});
        }
        let policy = Distribution {
            distribution_id: "acme.openbot".into(),
            repository: "acme/openbot".into(),
            channel: "stable".into(),
            intelligence_capabilities: vec!["conversations.v1".into()],
        };
        write_json(&root.join(DISTRIBUTION), &policy).unwrap();
        write_json(&root.join(RELEASE), &current).unwrap();
        let files = inventory(&root, &[PathBuf::from("examples")]).unwrap();
        write_json(
            &root.join(BASELINE),
            &Baseline {
                source_sha256: digest(&old_archive),
                commit: current["source"]["commit"].as_str().unwrap().into(),
                files,
            },
        )
        .unwrap();
        deployment::record(&root, "v0.2.0").unwrap();
        write(&root, "container-images.json", b"previous images");
        write(
            &root,
            ".env",
            b"TENANT_PACKAGE_DIR=../examples/fintech\nKEY_ENCRYPTION_KEY=customer-key\n",
        );
        write(&root, "examples/fintech/custom.ts", b"customer tenant");
        write(&root, ".openbot-engine.json", b"{\"engine\":\"podman\"}");
        write(&root, "server/node_modules/generated", b"dependency");
        Installation {
            root,
            candidate,
            policy,
            archive,
        }
    }
    #[test]
    fn updates_stage_and_apply_preserves_root_engine_tenant_and_credentials_accepts_last() {
        let i = installation();
        let root = std::fs::canonicalize(&i.root).unwrap();
        stage_bytes(&i.root, &i.candidate, &i.policy, &i.archive).unwrap();
        assert_eq!(
            std::fs::read(i.root.join("server/src/main.ts")).unwrap(),
            b"previous"
        );
        let mut journal = prepare_apply(&i.root).unwrap();
        install_candidate(&i.root, &mut journal).unwrap();
        assert!(require_no_interruption(&i.root).is_err());
        assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
        mark_starting(&i.root, &mut journal).unwrap();
        accept(&i.root, &mut journal).unwrap();
        assert_eq!(current(&i.root).unwrap()["version"], "v0.3.0");
        assert_eq!(std::fs::canonicalize(&i.root).unwrap(), root);
        assert_eq!(
            std::fs::read(i.root.join("examples/fintech/custom.ts")).unwrap(),
            b"customer tenant"
        );
        assert_eq!(
            std::fs::read(i.root.join(".env")).unwrap(),
            b"TENANT_PACKAGE_DIR=../examples/fintech\nKEY_ENCRYPTION_KEY=customer-key\n"
        );
        assert_eq!(
            std::fs::read(i.root.join(".openbot-engine.json")).unwrap(),
            b"{\"engine\":\"podman\"}"
        );
        assert_eq!(
            std::fs::read(i.root.join("server/node_modules/generated")).unwrap(),
            b"dependency"
        );
    }
    #[test]
    fn updates_modified_added_removed_core_and_corrupt_archive_refuse_without_mutation() {
        for change in ["modified", "added", "removed", "checksum"] {
            let i = installation();
            match change {
                "modified" => write(&i.root, "server/src/main.ts", b"fork"),
                "added" => write(&i.root, "server/src/extra.ts", b"fork"),
                "removed" => std::fs::remove_file(i.root.join("server/src/main.ts")).unwrap(),
                _ => (),
            }
            let bytes = if change == "checksum" {
                b"partial".as_slice()
            } else {
                &i.archive
            };
            assert!(
                stage_bytes(&i.root, &i.candidate, &i.policy, bytes).is_err(),
                "{change}"
            );
            assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
            assert!(!i.root.join(JOURNAL).exists());
        }
    }
    #[test]
    fn updates_failed_preparation_restores_previous_vendor_but_migration_failure_stays_stopped() {
        for migrated in [false, true] {
            let i = installation();
            stage_bytes(&i.root, &i.candidate, &i.policy, &i.archive).unwrap();
            let mut journal = prepare_apply(&i.root).unwrap();
            install_candidate(&i.root, &mut journal).unwrap();
            if migrated {
                mark_starting(&i.root, &mut journal).unwrap();
                assert!(rollback_preparation(&i.root, &mut journal).is_err());
                assert!(require_no_interruption(&i.root).is_err());
            } else {
                rollback_preparation(&i.root, &mut journal).unwrap();
                assert_eq!(
                    std::fs::read(i.root.join("server/src/main.ts")).unwrap(),
                    b"previous"
                );
                require_no_interruption(&i.root).unwrap();
            }
            assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
        }
    }
    #[test]
    fn updates_explicit_baseline_adoption_compares_trusted_archive_without_changing_source() {
        let i = installation();
        let current = current(&i.root).unwrap();
        let previous_archive = archive("0.2.0", "previous");
        std::fs::remove_file(i.root.join(BASELINE)).unwrap();
        std::fs::remove_file(i.root.join(RELEASE)).unwrap();
        establish_baseline_bytes(&i.root, &current, &i.policy, &previous_archive).unwrap();
        assert_eq!(
            current["version"],
            super::current(&i.root).unwrap()["version"]
        );
        assert_eq!(
            std::fs::read(i.root.join("examples/fintech/custom.ts")).unwrap(),
            b"customer tenant"
        );
        std::fs::remove_file(i.root.join(BASELINE)).unwrap();
        std::fs::remove_file(i.root.join(RELEASE)).unwrap();
        write(&i.root, "server/src/main.ts", b"committed fork change");
        assert!(establish_baseline_bytes(&i.root, &current, &i.policy, &previous_archive).is_err());
        assert!(!i.root.join(RELEASE).exists());
    }
    #[test]
    fn updates_selected_engine_backup_and_actual_database_and_image_identity() {
        if crate::test_support::isolated_process(
            "updates::tests::updates_selected_engine_backup_and_actual_database_and_image_identity",
        ) {
            return;
        }
        let i = installation();
        let tools = i.root.join("fixture-tools");
        std::fs::create_dir(&tools).unwrap();
        let binary = tools.join(format!("docker{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/updates-engine.rs"),
            &binary,
        );
        std::env::set_var("PATH", &tools);
        std::env::set_var("OPENBOT_UPDATE_ENGINE_FIXTURE", &i.root);
        let address = crate::engine::Address::new(crate::engine::Engine::Docker, None);
        let secrets = crate::stack::Secrets::new();
        write_json(&i.root.join("fixture-config.json"),&json!({"name":"customer-project","volumes":{"pgdata":{"name":"customer-project_pgdata"}},"services":{"postgres":{"volumes":[{"type":"volume","source":"pgdata","target":"/var/lib/postgresql/data"}]},"supervisor":{"environment":{"COMPUTER_NAMESPACE":"customer-namespace"}}}})).unwrap();
        write_json(
            &i.root.join("fixture-journal.json"),
            &json!([{"hash":digest(b"select 1;"),"createdAt":1}]),
        )
        .unwrap();
        let identity = crate::stack::runtime_update_identity(&address, &i.root, &secrets).unwrap();
        assert_eq!(identity["project"], "customer-project");
        assert_eq!(identity["namespace"], "customer-namespace");
        let dump = i.root.join("fixture.dump");
        crate::stack::backup_runtime_database(&address, &i.root, &secrets, &dump, "openbot-db-1")
            .unwrap();
        assert_eq!(std::fs::read(&dump).unwrap(), b"PGDMP-fixture-backup");
        let commands = std::fs::read_to_string(i.root.join("fixture-commands.log")).unwrap();
        assert!(commands
            .contains("--no-deps --no-build --pull never --wait --wait-timeout 60 postgres"));
        assert!(!commands.contains("--volumes"));
        assert!(!commands.contains("up -d server"));
        write_json(
            &i.root.join("fixture-journal.json"),
            &json!([{"hash":"different","createdAt":1}]),
        )
        .unwrap();
        let refused = i.root.join("refused.dump");
        assert!(crate::stack::backup_runtime_database(
            &address,
            &i.root,
            &secrets,
            &refused,
            "openbot-db-1"
        )
        .is_err());
        assert!(!refused.exists());
        write_json(
            &i.root.join("fixture-journal.json"),
            &json!([{"hash":digest(b"select 1;"),"createdAt":1}]),
        )
        .unwrap();
        write(&i.root, "fixture-dump-failure", b"1");
        assert!(crate::stack::backup_runtime_database(
            &address,
            &i.root,
            &secrets,
            &i.root.join("failed.dump"),
            "openbot-db-1"
        )
        .is_err());
        let containers = json!([{"Config":{"Image":i.candidate["artifacts"]["images"]["supervisor"]["reference"],"Labels":{"com.docker.compose.service":"supervisor"}},"State":{"Running":true}},{"Config":{"Image":i.candidate["artifacts"]["images"]["agent-computer"]["reference"],"Labels":{"com.docker.compose.service":"agent-computer"}},"State":{"Running":true}}]);
        write_json(&i.root.join("fixture-inspect.json"), &containers).unwrap();
        crate::stack::verify_runtime_update_images(&address, &i.root, &i.candidate).unwrap();
        let mut previous = containers;
        previous[0]["Config"]["Image"] = json!("old-image:latest");
        write_json(&i.root.join("fixture-inspect.json"), &previous).unwrap();
        assert!(
            crate::stack::verify_runtime_update_images(&address, &i.root, &i.candidate).is_err()
        );
    }
    #[test]
    fn updates_candidate_mount_swaps_refuse_before_stop_or_source_mutation() {
        if crate::test_support::isolated_process(
            "updates::tests::updates_candidate_mount_swaps_refuse_before_stop_or_source_mutation",
        ) {
            return;
        }
        let i = installation();
        stage_bytes(&i.root, &i.candidate, &i.policy, &i.archive).unwrap();
        let tools = i.root.join("fixture-tools");
        std::fs::create_dir(&tools).unwrap();
        let binary = tools.join(format!("docker{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/updates-engine.rs"),
            &binary,
        );
        std::env::set_var("PATH", &tools);
        std::env::set_var("OPENBOT_UPDATE_ENGINE_FIXTURE", &i.root);
        let address = crate::engine::Address::new(crate::engine::Engine::Docker, None);
        let secrets = crate::stack::Secrets::new();
        let config = json!({"name":"customer-project","volumes":{"pgdata":{"name":"customer-project_pgdata"},"workspace":{"name":"customer-project_workspace"},"profiles":{"name":"customer-project_profiles"}},"services":{"postgres":{"volumes":[{"type":"volume","source":"pgdata","target":"/var/lib/postgresql/data"}]},"supervisor":{"environment":{"COMPUTER_NAMESPACE":"customer-namespace"}},"agent-computer":{"volumes":[{"type":"volume","source":"workspace","target":"/workspace"},{"type":"volume","source":"profiles","target":"/profiles"}]},"server":{"volumes":[{"type":"bind","source":"/customer/tenant","target":"/tenant"}]}}});
        write_json(&i.root.join("fixture-config.json"), &config).unwrap();
        write(
            &i.root,
            "docker-compose.override.yml",
            b"services: {}
",
        );
        write(
            &i.root,
            "fixture-compose-environment",
            b"COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml
COMPOSE_PATH_SEPARATOR=:
",
        );
        let identity = crate::stack::runtime_update_identity(&address, &i.root, &secrets).unwrap();
        write_json(&i.root.join("fixture-candidate-config.json"), &config).unwrap();
        crate::stack::verify_staged_runtime_identity(
            &address,
            &i.root,
            &stage_path(&i.root).unwrap(),
            &secrets,
            &identity,
        )
        .unwrap();
        for change in ["swap", "remove", "bind-source", "mount-type"] {
            let mut candidate = config.clone();
            match change {
                "swap" => {
                    candidate["services"]["agent-computer"]["volumes"][0]["source"] =
                        json!("profiles");
                    candidate["services"]["agent-computer"]["volumes"][1]["source"] =
                        json!("workspace");
                }
                "remove" => {
                    candidate["services"]["agent-computer"]["volumes"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                }
                "bind-source" => {
                    candidate["services"]["server"]["volumes"][0]["source"] =
                        json!("/different/tenant")
                }
                _ => candidate["services"]["agent-computer"]["volumes"][0]["type"] = json!("bind"),
            }
            write_json(&i.root.join("fixture-candidate-config.json"), &candidate).unwrap();
            assert!(
                crate::stack::verify_staged_runtime_identity(
                    &address,
                    &i.root,
                    &stage_path(&i.root).unwrap(),
                    &secrets,
                    &identity
                )
                .is_err(),
                "{change}"
            );
        }
        let commands = std::fs::read_to_string(i.root.join("fixture-commands.log")).unwrap();
        assert!(
            !commands.contains("compose down")
                && !commands.contains("compose up")
                && !commands.contains("pg_dump")
        );
        assert!(commands.contains("--project-directory"));
        assert!(commands.contains("docker-compose.override.yml"));
        assert!(commands.contains(
            &stage_path(&i.root)
                .unwrap()
                .join("docker-compose.yml")
                .to_string_lossy()
                .to_string()
        ));
        assert_eq!(
            std::fs::read(i.root.join("server/src/main.ts")).unwrap(),
            b"previous"
        );
        assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
        assert!(!i.root.join(JOURNAL).exists());
    }

    #[test]
    fn updates_partial_vendor_copy_restores_previous_accepted_source() {
        let i = installation();
        stage_bytes(&i.root, &i.candidate, &i.policy, &i.archive).unwrap();
        let mut journal = prepare_apply(&i.root).unwrap();
        std::fs::remove_file(stage_path(&i.root).unwrap().join("worker/src/main.ts")).unwrap();
        assert!(install_candidate(&i.root, &mut journal).is_err());
        rollback_preparation(&i.root, &mut journal).unwrap();
        assert_eq!(
            std::fs::read(i.root.join("server/src/main.ts")).unwrap(),
            b"previous"
        );
        assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
        require_no_interruption(&i.root).unwrap();
    }
    #[test]
    fn updates_missing_baseline_and_partial_stage_refuse() {
        let i = installation();
        stage_bytes(&i.root, &i.candidate, &i.policy, &i.archive).unwrap();
        std::fs::remove_file(stage_path(&i.root).unwrap().join("app/src/main.ts")).unwrap();
        assert!(prepare_apply(&i.root).is_err());
        std::fs::remove_file(i.root.join(BASELINE)).unwrap();
        assert!(prepare_apply(&i.root).unwrap_err().contains("baseline"));
        assert_eq!(current(&i.root).unwrap()["version"], "v0.2.0");
    }
}
