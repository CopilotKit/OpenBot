//! The deployment follows the app.
//!
//! An installed deployment keeps its release through Install and Repair (see `deployment_release`),
//! and the app updates itself on its own path (the shell updater). So an app that updated kept
//! running the server it first laid out, and every fix that shipped in the server never reached it.
//! Now a stable app that finds its deployment on an older release moves it to the app's own release
//! as part of Start, through the runtime updater (`updates`): adopted, staged beside the
//! installation, backed up, journaled, verified, and put back when anything fails.
//!
//! Left exactly as before:
//! - A pinned build (internal or candidate). Install lays out the release it was made with.
//! - A deployment a pinned build left behind, or one from before the server ran in a container.
//!   Install already moves those to the latest release by laying them out again.
//! - A deployment newer than the app. Moving it back would run an older server against a database
//!   the newer release already migrated (`rollbackCompatible: false`), which is the half-upgraded
//!   state this exists to prevent. It keeps running, and the app's own update offer catches the
//!   app up.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{deployment, problem::Problem, updates};

/// A move to this release failed after OpenBot was stopped for it, and was undone. Start does not
/// try the same release again on its own; Runtime updates can.
pub const FAILED: &str = ".openbot-follow-failed.json";

/// The release this app is: its own version, as the installer and the shell updater deliver it.
pub fn app_release() -> String {
    format!("v{}", env!("CARGO_PKG_VERSION"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub from: String,
    pub to: String,
}

fn release(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.strip_prefix('v')?).ok()
}

/// The move Start makes first, or `None` when this installation starts as it is.
///
/// Only a followed deployment that is laid out completely (`deployment::needs_fetch`) and has no
/// interrupted update moves. Start sends anything else to Install or to its own recovery first, and
/// the next Start moves it.
pub fn due(root: &Path, pin: Option<&deployment::Pin>, app: &str) -> Option<Move> {
    if pin.is_some() {
        return None;
    }
    let installed = deployment::installed(root)?;
    if installed.pinned || deployment::needs_fetch(root, &installed.version) {
        return None;
    }
    if !matches!(updates::interruption(root), Ok(None)) {
        return None;
    }
    if release(&installed.version)? >= release(app)? {
        return None;
    }
    if failed(root).is_some_and(|failed| failed.to == app) {
        return None;
    }
    Some(Move {
        from: installed.version,
        to: app.into(),
    })
}

fn failed(root: &Path) -> Option<Move> {
    serde_json::from_slice(&std::fs::read(root.join(FAILED)).ok()?).ok()
}

pub fn record_failure(root: &Path, planned: &Move) -> Result<(), String> {
    updates::write_json(&root.join(FAILED), planned)
}

pub fn clear_failure(root: &Path) -> Result<(), String> {
    match std::fs::remove_file(root.join(FAILED)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Give the installation an accepted release, which the updater moves from. One laid out by
/// Install has none, so its release's published manifest is verified against every managed file
/// first (`updates::establish_baseline`), and a modified installation is refused before anything
/// stops. Every release Start can move has a manifest: the releases from before v0.3.0, which had
/// none, ran their server on the host, and Install lays those out again instead (see `due`).
pub fn adopt(root: &Path, get: deployment::Download) -> Result<(), String> {
    if root.join(updates::RELEASE).exists() {
        return Ok(());
    }
    updates::establish_baseline_with(root, get).map(|_| ())
}

/// Adopt, then stage the app's release beside the installation. Nothing that runs is stopped or
/// changed: the stage is a sibling folder, and adoption only writes the accepted release records.
pub fn stage(root: &Path, planned: &Move, get: deployment::Download) -> Result<Value, String> {
    adopt(root, get)?;
    updates::stage_with(root, &planned.to, get)
}

/// What Start reports when it moved, or tried to move, the deployment.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub from: String,
    pub to: String,
    pub moved: bool,
    /// Said on the running screen when the move did not happen and the previous release started.
    pub notice: Option<Problem>,
}

impl Outcome {
    /// Nothing was due: the installation started on the release it has.
    pub fn unchanged(version: String) -> Self {
        Self {
            from: version.clone(),
            to: version,
            moved: false,
            notice: None,
        }
    }

    pub fn moved(planned: &Move) -> Self {
        Self {
            from: planned.from.clone(),
            to: planned.to.clone(),
            moved: true,
            notice: None,
        }
    }

    pub fn kept(planned: &Move, applied: bool, detail: String) -> Self {
        Self {
            from: planned.from.clone(),
            to: planned.to.clone(),
            moved: false,
            notice: Some(Problem::with(kept_said(planned, applied), detail)),
        }
    }
}

pub fn moving_said(planned: &Move) -> String {
    format!(
        "Updating OpenBot from {} to {}. Your Bots, sign-ins and data stay as they are.",
        planned.from, planned.to
    )
}

/// The move failed and the previous release is running again. `applied`: OpenBot was stopped for
/// it, so it is not tried again on its own.
pub fn kept_said(planned: &Move, applied: bool) -> String {
    let next = if applied {
        "To try again, open Runtime updates."
    } else {
        "OpenBot tries again the next time it starts."
    };
    format!(
        "OpenBot couldn't update to {}, so it's still running {}. Your Bots, sign-ins and data are unchanged. {next}",
        planned.to, planned.from
    )
}

/// The previous release is back, and then did not start.
pub fn undone_said(planned: &Move) -> String {
    format!(
        "OpenBot couldn't update to {} and went back to {}.",
        planned.to, planned.from
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn laid_out(version: &str, pinned: bool) -> std::path::PathBuf {
        let root = temp_root("follow-due");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  server: {}\n  worker: {}\n",
        )
        .unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        deployment::record(&root, version, pinned).unwrap();
        root
    }

    #[test]
    fn an_older_followed_deployment_moves_to_the_apps_release() {
        let root = laid_out("v0.3.0", false);
        assert_eq!(
            due(&root, None, "v0.3.1"),
            Some(Move {
                from: "v0.3.0".into(),
                to: "v0.3.1".into()
            })
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_same_or_a_newer_deployment_is_never_moved_back() {
        for installed in ["v0.3.1", "v0.3.2", "v1.0.0"] {
            let root = laid_out(installed, false);
            assert_eq!(due(&root, None, "v0.3.1"), None, "{installed}");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn pinned_builds_and_deployments_install_handles_keep_todays_behaviour() {
        let root = laid_out("v0.3.0", false);
        let pin = deployment::Pin {
            version: "internal-abc".into(),
            commit: "abc".into(),
            images: "{}",
        };
        assert_eq!(due(&root, Some(&pin), "v0.3.1"), None);
        std::fs::remove_dir_all(root).unwrap();

        // Left by a pinned build: Install lays out the latest release instead.
        let root = laid_out("internal-abc", true);
        assert_eq!(due(&root, None, "v0.3.1"), None);
        std::fs::remove_dir_all(root).unwrap();

        // Not laid out completely: Start sends it to Install, which lays it out at its version.
        let root = laid_out("v0.3.0", false);
        std::fs::remove_file(deployment::images_path(&root)).unwrap();
        assert_eq!(due(&root, None, "v0.3.1"), None);
        std::fs::remove_dir_all(root).unwrap();

        // An interrupted update: Start's own recovery runs first.
        let root = laid_out("v0.3.0", false);
        std::fs::write(root.join(updates::JOURNAL), "{}").unwrap();
        assert_eq!(due(&root, None, "v0.3.1"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_move_that_failed_after_stopping_is_not_repeated_until_the_app_moves_on() {
        let root = laid_out("v0.3.0", false);
        let planned = due(&root, None, "v0.3.1").unwrap();
        record_failure(&root, &planned).unwrap();
        assert_eq!(due(&root, None, "v0.3.1"), None);
        assert_eq!(
            due(&root, None, "v0.3.2").map(|planned| planned.to),
            Some("v0.3.2".into())
        );
        clear_failure(&root).unwrap();
        assert_eq!(due(&root, None, "v0.3.1"), Some(planned));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn this_app_is_the_release_its_package_names() {
        let package: Value = serde_json::from_slice(
            &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            app_release(),
            format!("v{}", package["version"].as_str().unwrap())
        );
    }

    #[test]
    fn the_notice_says_what_happened_and_what_to_do() {
        let planned = Move {
            from: "v0.3.0".into(),
            to: "v0.3.1".into(),
        };
        for applied in [false, true] {
            let said = kept_said(&planned, applied);
            assert!(said
                .starts_with("OpenBot couldn't update to v0.3.1, so it's still running v0.3.0."));
            assert!(!said.contains('\u{2014}'));
        }
    }

    /// v0.2.0 and every release before it ran the server on the host and published no manifest.
    /// Install already lays those out again at the latest release, so Start leaves them to it.
    #[test]
    fn a_release_that_ran_its_server_on_the_host_is_left_to_install() {
        let root = laid_out("v0.2.0", false);
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  migrate: {}\n  supervisor: {}\n",
        )
        .unwrap();
        assert!(deployment::predates_containers(&root));
        assert_eq!(due(&root, None, "v0.3.1"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ---- Regression: an app at X with a followed deployment at an older release ends up on X ----
    //
    // Driven through the real paths: Install's own `deployment::fetch_with` lays v0.3.0 out, then
    // the move runs adoption, staging and the updater's apply phases in the order
    // `follow_app_release` and `apply_staged_update` run them, against the fake container engine the
    // updater's own tests use. v0.3.0's metadata is its real published assets
    // (`test-fixtures/releases/v0.3.0`). The next release does not exist yet, so its assets are
    // v0.3.0's with the version moved on: the manifest says it upgrades from v0.3.0 and adds one
    // migration, and `latest.json` delivers app 0.3.1. Source archives are small stand-ins, so each
    // manifest's source checksum is set to its stand-in's.

    const REPOSITORY: &str = "https://github.com/CopilotKit/OpenBot";
    const NEXT: &str = "v0.3.1";

    fn release_asset(version: &str, name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("test-fixtures/releases")
                .join(version)
                .join(name),
        )
        .unwrap()
    }

    fn migration(tag: &str) -> String {
        format!("-- {tag}\nselect 1;")
    }

    fn sha256(bytes: impl AsRef<[u8]>) -> String {
        format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes))
    }

    /// A release's source tree as a tarball under `prefix`. GitHub's tag tarballs start with a pax
    /// global header naming the commit; `git archive` (the release's own source asset) does not.
    fn source(prefix: &str, version: &str, migrations: &[&str], pax: Option<&str>) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        if let Some(commit) = pax {
            let record = format!("52 comment={commit}\n");
            let mut header = tar::Header::new_ustar();
            header.set_entry_type(tar::EntryType::XGlobalHeader);
            header.set_size(record.len() as u64);
            header.set_mode(0o666);
            header.set_cksum();
            tar.append_data(&mut header, "pax_global_header", record.as_bytes())
                .unwrap();
        }
        let journal = serde_json::json!({
            "entries": migrations
                .iter()
                .enumerate()
                .map(|(when, tag)| serde_json::json!({"tag": tag, "when": when + 1}))
                .collect::<Vec<_>>()
        });
        let mut files = vec![
            (
                "package.json".to_string(),
                format!("{{\"version\":\"{}\"}}", version.trim_start_matches('v')),
            ),
            (
                "docker-compose.yml".into(),
                "services:\n  postgres: {}\n  migrate: {}\n  server: {}\n  worker: {}\n".into(),
            ),
            ("server/src/main.ts".into(), format!("server {version}")),
            ("app/src/main.ts".into(), format!("app {version}")),
            ("worker/src/main.ts".into(), format!("worker {version}")),
            ("extension/manifest.json".into(), "{}".into()),
            ("examples/fintech/custom.ts".into(), "vendor example".into()),
            (
                "server/drizzle/meta/_journal.json".into(),
                journal.to_string(),
            ),
        ];
        for tag in migrations {
            files.push((format!("server/drizzle/{tag}.sql"), migration(tag)));
        }
        for (path, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("{prefix}/{path}"), body.as_bytes())
                .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    const BEFORE: &[&str] = &["0076_channel_people", "0077_channel_opening"];
    const AFTER: &[&str] = &[
        "0076_channel_people",
        "0077_channel_opening",
        "0078_follow_check",
    ];

    /// The release host as it answers: v0.3.0's real assets, and the next release in their shape.
    fn published() -> impl Fn(&str) -> Result<Vec<u8>, String> {
        let commit = "a03111e2872458f50a8e5a9c549d5afd09da8ee2";
        let tag_tarball = source("OpenBot-0.3.0", "v0.3.0", BEFORE, Some(commit));
        let installed_source = source("openbot", "v0.3.0", BEFORE, None);
        let next_source = source("openbot", NEXT, AFTER, None);
        let real: Value =
            serde_json::from_slice(&release_asset("v0.3.0", "release-manifest.json")).unwrap();
        let mut installed = real.clone();
        installed["artifacts"]["source"]["sha256"] = serde_json::json!(sha256(&installed_source));
        let mut next = real;
        next["version"] = serde_json::json!(NEXT);
        next["artifacts"]["source"] = serde_json::json!({
            "url": format!("{REPOSITORY}/releases/download/{NEXT}/openbot-source.tar.gz"),
            "sha256": sha256(&next_source),
        });
        next["compatibility"]["database"]["from"] = serde_json::json!(["0077_channel_opening"]);
        next["compatibility"]["database"]["to"] = serde_json::json!("0078_follow_check");
        next["upgrade"]["fromVersions"] = serde_json::json!(["v0.3.0"]);
        // The next release's own images: v0.3.0's repositories at new digests.
        for image in next["artifacts"]["images"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            let reference = image["reference"].as_str().unwrap().to_string();
            let (repository, digest) = reference.split_once("@sha256:").unwrap();
            image["reference"] = serde_json::json!(format!(
                "{repository}@sha256:{}",
                sha256(format!("{digest}{NEXT}"))
            ));
        }
        let (installed, next) = (
            serde_json::to_vec(&installed).unwrap(),
            serde_json::to_vec(&next).unwrap(),
        );
        move |url: &str| {
            let download = format!("{REPOSITORY}/releases/download/");
            if url == format!("{REPOSITORY}/archive/refs/tags/v0.3.0.tar.gz") {
                Ok(tag_tarball.clone())
            } else if url == format!("{download}v0.3.0/container-images.json") {
                Ok(release_asset("v0.3.0", "container-images.json"))
            } else if url == format!("{download}v0.3.0/release-manifest.json") {
                Ok(installed.clone())
            } else if url == format!("{download}v0.3.0/openbot-source.tar.gz") {
                Ok(installed_source.clone())
            } else if url == format!("{download}{NEXT}/release-manifest.json") {
                Ok(next.clone())
            } else if url == format!("{download}{NEXT}/openbot-source.tar.gz") {
                Ok(next_source.clone())
            } else {
                // `deployment::get`'s own words for a file that is not there.
                Err(format!("{url} answered 404 Not Found"))
            }
        }
    }

    /// What a person has in an installation besides the release: none of it is the release's.
    const KEPT: &[(&str, &str)] = &[
        (
            ".env",
            "KEY_ENCRYPTION_KEY=customer-key\nINTELLIGENCE_API_URL=http://127.0.0.1:7050\n",
        ),
        (".secrets/CLAUDE_CODE_OAUTH_TOKEN.secret", "claude plan"),
        (crate::env::CHATGPT_STORE_FILE, "{\"chatgpt\":\"plan\"}"),
        (crate::local_eval_state::FILE, "{\"stack\":\"local\"}"),
        (".openbot-engine.json", "{\"engine\":\"docker\"}"),
        (".openbot-project.json", "{\"project\":\"openbot-desktop\"}"),
        ("examples/fintech/custom.ts", "customer tenant"),
    ];

    /// v0.3.0 laid out by Install, exactly as an app before this change left it, with its
    /// database migrated by v0.3.0 and the person's own files beside it.
    fn installed_v0_3_0(get: deployment::Download) -> std::path::PathBuf {
        let root = temp_root("follow-move");
        deployment::fetch_with(&root, "v0.3.0", get).expect("Install lays out v0.3.0");
        assert!(!root.join(updates::RELEASE).exists());
        for (path, contents) in KEPT {
            std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            std::fs::write(root.join(path), contents).unwrap();
        }
        let database: Vec<Value> = BEFORE
            .iter()
            .enumerate()
            .map(|(when, tag)| serde_json::json!({"hash": sha256(migration(tag)), "createdAt": when + 1}))
            .collect();
        updates::write_json(&root.join("fixture-journal.json"), &database).unwrap();
        root
    }

    fn fake_engine(root: &Path) -> crate::engine::Address {
        let tools = root.join("fixture-tools");
        std::fs::create_dir(&tools).unwrap();
        let binary = tools.join(format!("docker{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/updates-engine.rs"),
            &binary,
        );
        std::env::set_var("PATH", &tools);
        std::env::set_var("OPENBOT_UPDATE_ENGINE_FIXTURE", root);
        crate::engine::Address::new(crate::engine::Engine::Docker, None)
    }

    /// The app version the shell updater delivers next: v0.3.0's real `latest.json`, moved on.
    fn updated_app() -> String {
        let mut latest: Value =
            serde_json::from_slice(&release_asset("v0.3.0", "latest.json")).unwrap();
        assert_eq!(latest["version"], "0.3.0");
        latest["version"] = serde_json::json!(NEXT.trim_start_matches('v'));
        format!("v{}", latest["version"].as_str().unwrap())
    }

    fn assert_kept(root: &Path) {
        for (path, contents) in KEPT {
            assert_eq!(
                std::fs::read_to_string(root.join(path)).unwrap(),
                *contents,
                "{path}"
            );
        }
    }

    /// Everything `apply_staged_update` does to files and the database before the candidate's own
    /// startup runs its migrations.
    fn apply_until_migration(
        root: &Path,
        address: &crate::engine::Address,
        secrets: &crate::stack::Secrets,
    ) -> updates::Journal {
        let mut journal = updates::prepare_apply(root).unwrap();
        updates::backup_vendor(root, &mut journal).unwrap();
        crate::stack::backup_runtime_database(
            address,
            root,
            secrets,
            &updates::database_backup_path(&journal),
            &updates::accepted_database_identity(root).unwrap(),
        )
        .unwrap();
        updates::install_candidate(root, &mut journal).unwrap();
        updates::mark_starting(root, &mut journal).unwrap();
        journal
    }

    /// The candidate's own startup ran its migration.
    fn candidate_migrated(root: &Path) {
        let mut database: Vec<Value> =
            serde_json::from_slice(&std::fs::read(root.join("fixture-journal.json")).unwrap())
                .unwrap();
        database.push(serde_json::json!({
            "hash": sha256(migration("0078_follow_check")),
            "createdAt": AFTER.len(),
        }));
        updates::write_json(&root.join("fixture-journal.json"), &database).unwrap();
    }

    fn beside(root: &Path, suffix: &str) -> std::path::PathBuf {
        root.parent().unwrap().join(format!(
            ".{}.openbot-update-{suffix}",
            root.file_name().unwrap().to_string_lossy()
        ))
    }

    fn cleanup(root: &Path) {
        for suffix in ["stage", "backup", "baseline"] {
            let _ = std::fs::remove_dir_all(beside(root, suffix));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_updated_app_moves_its_older_followed_deployment_to_its_own_release() {
        if crate::test_support::isolated_process(
            "follow::tests::an_updated_app_moves_its_older_followed_deployment_to_its_own_release",
        ) {
            return;
        }
        let published = published();
        let root = installed_v0_3_0(&published);
        let address = fake_engine(&root);
        let secrets = crate::stack::Secrets::new();
        let app = updated_app();

        // Start finds the deployment behind the app and moves it.
        let planned = due(&root, None, &app).expect("Start moves v0.3.0 to the app's release");
        assert_eq!(
            planned,
            Move {
                from: "v0.3.0".into(),
                to: NEXT.into()
            }
        );
        stage(&root, &planned, &published).expect("v0.3.0 is adopted and the app's release staged");
        updates::stage_images(&address, &root, None, |_, _, _| Ok(())).unwrap();
        let mut journal = apply_until_migration(&root, &address, &secrets);
        candidate_migrated(&root);
        crate::stack::verify_runtime_database_identity(
            &address,
            &root,
            &secrets,
            "0078_follow_check",
        )
        .unwrap();
        updates::accept(&root, &mut journal).unwrap();

        // It runs the app's release: its stamp, its source, its pinned images and its database.
        let installed = deployment::installed(&root).unwrap();
        assert_eq!(installed.version, NEXT);
        assert!(!installed.pinned);
        assert!(!deployment::needs_fetch(&root, NEXT));
        assert_eq!(
            std::fs::read_to_string(root.join("server/src/main.ts")).unwrap(),
            format!("server {NEXT}")
        );
        let images: deployment::Images =
            serde_json::from_slice(&std::fs::read(deployment::images_path(&root)).unwrap())
                .unwrap();
        assert_eq!(images.version, NEXT);
        let released: deployment::Images =
            serde_json::from_slice(&release_asset("v0.3.0", "container-images.json")).unwrap();
        assert_eq!(images.images.len(), released.images.len());
        assert_eq!(
            updates::accepted_database_identity(&root).unwrap(),
            "0078_follow_check"
        );
        updates::require_no_interruption(&root).unwrap();
        // Sign-ins, secrets, the local Intelligence record and the tenant are untouched.
        assert_kept(&root);
        assert!(!beside(&root, "stage").exists() && !beside(&root, "backup").exists());
        // And it is not moved again.
        assert_eq!(due(&root, None, &app), None);
        cleanup(&root);
    }

    #[test]
    fn a_failed_move_puts_the_previous_release_and_its_database_back() {
        if crate::test_support::isolated_process(
            "follow::tests::a_failed_move_puts_the_previous_release_and_its_database_back",
        ) {
            return;
        }
        let published = published();
        let root = installed_v0_3_0(&published);
        let address = fake_engine(&root);
        let secrets = crate::stack::Secrets::new();
        let app = updated_app();
        let before = std::fs::read(root.join("fixture-journal.json")).unwrap();

        let planned = due(&root, None, &app).unwrap();
        stage(&root, &planned, &published).unwrap();
        apply_until_migration(&root, &address, &secrets);
        // The candidate migrated the database, then failed its checks. `after_failed_candidate`
        // finds the database changed and keeps the update record...
        candidate_migrated(&root);
        assert_eq!(
            updates::restore_previous_release(&address, &root, &secrets, false).unwrap(),
            updates::Restored::DatabaseChanged
        );
        record_failure(&root, &planned).unwrap();
        // ...and `follow_app_release` undoes it with the explicit recovery, database included.
        assert_eq!(
            updates::recover_without_engine(&root).unwrap(),
            updates::Recovery::NeedsEngine
        );
        assert_eq!(
            updates::restore_previous_release(&address, &root, &secrets, true).unwrap(),
            updates::Restored::Done {
                database_restored: true
            }
        );

        // v0.3.0 is back as it was, ready for Start: its files, its stamp, its database.
        let installed = deployment::installed(&root).unwrap();
        assert_eq!(installed.version, "v0.3.0");
        assert!(!deployment::needs_fetch(&root, "v0.3.0"));
        assert_eq!(
            std::fs::read_to_string(root.join("server/src/main.ts")).unwrap(),
            "server v0.3.0"
        );
        assert_eq!(
            std::fs::read(deployment::images_path(&root)).unwrap(),
            release_asset("v0.3.0", "container-images.json")
        );
        assert_eq!(
            std::fs::read(root.join("fixture-journal.json")).unwrap(),
            before
        );
        updates::require_no_interruption(&root).unwrap();
        assert_kept(&root);
        // Nothing half-applied is left in force.
        assert!(!beside(&root, "backup").exists());
        // Start does not repeat the same failed move by itself; the next app release tries again.
        assert_eq!(due(&root, None, &app), None);
        assert!(due(&root, None, "v0.3.2").is_some());
        cleanup(&root);
    }

    /// Staging pulls what installing the staged release would pull, and nothing else. Every image
    /// the release names was 19 for v0.3.0 where an installation pulls 5: several GB over a slow
    /// registry on every app update, and the all-in-one image among them had no arm64 build.
    #[test]
    fn staging_asks_for_exactly_what_installing_the_release_would() {
        if crate::test_support::isolated_process(
            "follow::tests::staging_asks_for_exactly_what_installing_the_release_would",
        ) {
            return;
        }
        let published = published();
        let root = installed_v0_3_0(&published);
        let address = fake_engine(&root);
        let planned = due(&root, None, &updated_app()).unwrap();
        stage(&root, &planned, &published).unwrap();
        let mut asked = Vec::new();
        let staged = updates::stage_images(&address, &root, None, |_, _, image| {
            asked.push(image.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(asked, staged);
        assert_eq!(
            updates::require_staged_images(&root, crate::engine::Engine::Docker).unwrap(),
            staged
        );

        // The services this installation runs, its migration and the two sign-in images, each at
        // the release being staged. No supervisor and no bundled Bot: the personal edition runs
        // neither (see `stack::SERVICES`).
        let manifest = updates::staged_manifest(&root).unwrap();
        let named = |name: &str| {
            manifest["artifacts"]["images"][name]["reference"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let mut expected = vec![
            "pgvector/pgvector:pg17".to_string(),
            named("server"),
            named("agent-computer"),
            named(crate::plan::SIGN_IN_IMAGE),
            named(crate::plan::CHATGPT_SIGN_IN_IMAGE),
        ];
        expected.sort();
        assert_eq!(staged, expected);
        assert_eq!(staged.len(), 5);
        assert!(!staged.contains(&named("openbot")));
        assert_eq!(updates::candidate_images(&manifest).unwrap().len(), 19);

        // One question, asked of the staged release: once that release is in place, what Install
        // pulls for it is the same set.
        let mut journal = updates::prepare_apply(&root).unwrap();
        updates::install_candidate(&root, &mut journal).unwrap();
        assert_eq!(
            crate::preparation::installation_pull_set(&address, &root, &root, None).unwrap(),
            staged
        );
        cleanup(&root);
    }

    #[test]
    fn a_modified_installation_is_refused_before_anything_stops() {
        let published = published();
        let root = installed_v0_3_0(&published);
        std::fs::write(root.join("server/src/main.ts"), "a fork's change").unwrap();
        let planned = due(&root, None, &updated_app()).unwrap();
        let refused = stage(&root, &planned, &published).unwrap_err();
        assert!(refused.contains("differs from the published"), "{refused}");
        assert!(!root.join(updates::RELEASE).exists());
        assert!(!beside(&root, "stage").exists());
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert_eq!(
            std::fs::read_to_string(root.join("server/src/main.ts")).unwrap(),
            "a fork's change"
        );
        cleanup(&root);
    }
}

/// The same move on this machine's container engine. Install lays v0.3.0 out from GitHub and
/// v0.3.0's own server image migrates a real Postgres; the move adopts v0.3.0 against its published
/// manifest and source, stages the next release, pulls its images, backs the database up with
/// `pg_dump`, installs the next release and runs its migrator. The next release is not published
/// yet, so it is this checkout's tree (`git archive`, as the release workflow makes it) at the
/// version in `OPENBOT_FOLLOW_E2E_VERSION`, with v0.3.0's published images, served from memory;
/// everything v0.3.0 is downloaded. Each run has its own folder and Compose project (never
/// `openbot-desktop`) and removes both, volumes included, afterwards.
///
/// `OPENBOT_FOLLOW_E2E_SOURCE=<tar.gz> OPENBOT_FOLLOW_E2E_COMMIT=<sha> OPENBOT_FOLLOW_E2E_VERSION=v0.3.1
///  cargo test --lib follow::live -- --ignored --nocapture --test-threads=1`
#[cfg(test)]
mod live {
    use super::*;
    use crate::engine::{Address, Engine};
    use crate::stack::Secrets;
    use std::path::PathBuf;

    const DATABASE: &str = "0077_channel_opening";
    const REPOSITORY: &str = "https://github.com/CopilotKit/OpenBot";

    fn next() -> String {
        std::env::var("OPENBOT_FOLLOW_E2E_VERSION").expect("OPENBOT_FOLLOW_E2E_VERSION")
    }

    /// The published hosts, with the next release's manifest and source added in memory.
    fn published() -> impl Fn(&str) -> Result<Vec<u8>, String> {
        let next = next();
        let source =
            std::fs::read(std::env::var("OPENBOT_FOLLOW_E2E_SOURCE").expect("source archive"))
                .unwrap();
        let commit = std::env::var("OPENBOT_FOLLOW_E2E_COMMIT").expect("source commit");
        let mut manifest: Value = serde_json::from_slice(
            &deployment::get(&format!(
                "{REPOSITORY}/releases/download/v0.3.0/release-manifest.json"
            ))
            .unwrap(),
        )
        .unwrap();
        manifest["version"] = serde_json::json!(next);
        manifest["source"]["commit"] = serde_json::json!(commit);
        manifest["source"]["upstreamCommit"] = serde_json::json!(commit);
        manifest["artifacts"]["source"] = serde_json::json!({
            "url": format!("{REPOSITORY}/releases/download/{next}/openbot-source.tar.gz"),
            "sha256": format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&source)),
        });
        manifest["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove("chart");
        manifest["compatibility"]["database"]["from"] = serde_json::json!([DATABASE]);
        manifest["compatibility"]["database"]["to"] = serde_json::json!(DATABASE);
        manifest["upgrade"]["fromVersions"] = serde_json::json!(["v0.3.0"]);
        let manifest = serde_json::to_vec(&manifest).unwrap();
        move |url: &str| {
            if url == format!("{REPOSITORY}/releases/download/{next}/release-manifest.json") {
                Ok(manifest.clone())
            } else if url == format!("{REPOSITORY}/releases/download/{next}/openbot-source.tar.gz")
            {
                Ok(source.clone())
            } else {
                deployment::get(url)
            }
        }
    }

    struct Live {
        label: String,
        root: PathBuf,
        project: String,
        engine: Address,
    }

    impl Live {
        fn new(label: &str) -> Self {
            let root = crate::test_support::temp_root(&format!("follow-live-{label}"));
            std::fs::create_dir_all(&root).unwrap();
            let project = format!("openbot-follow-e2e-{label}-{}", std::process::id());
            std::fs::write(
                root.join(crate::stack::PROJECT_FILE),
                serde_json::json!({ "project": project }).to_string(),
            )
            .unwrap();
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            std::fs::write(
                root.join(".env"),
                format!("POSTGRES_PORT={port}\nKEY_ENCRYPTION_KEY=kept-across-the-move\n"),
            )
            .unwrap();
            let engine = Address::new(Engine::Docker, None).pin().unwrap();
            println!(
                "[{label}] root {} project {project} postgres 127.0.0.1:{port}",
                root.display()
            );
            Self {
                label: label.into(),
                root,
                project,
                engine,
            }
        }

        fn say(&self, said: &str) {
            println!("[{}] {said}", self.label);
        }

        fn compose(&self, args: &[&str]) -> std::process::Output {
            self.engine
                .command()
                .current_dir(&self.root)
                .env("COMPOSE_PROJECT_NAME", &self.project)
                .arg("compose")
                .args(args)
                .output()
                .unwrap()
        }

        /// Stop this project's containers and keep its volumes, as Stop does.
        fn stop(&self) {
            let stopped = self.compose(&["down"]);
            assert!(
                stopped.status.success(),
                "{}",
                String::from_utf8_lossy(&stopped.stderr)
            );
        }

        fn psql(&self, sql: &str) -> String {
            let output = self.compose(&[
                "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot", "-tAc", sql,
            ]);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }

        /// The installed release's image references, as Start hands them to Compose.
        fn secrets(&self) -> Secrets {
            deployment::image_variables(&self.root)
                .unwrap()
                .into_iter()
                .collect()
        }

        fn migrated(&self, expected: &str) {
            crate::stack::migrate(&self.engine, &self.root, &self.secrets())
                .unwrap_or_else(|problem| panic!("migrate: {problem:?}"));
            crate::stack::verify_runtime_database_identity(
                &self.engine,
                &self.root,
                &self.secrets(),
                expected,
            )
            .unwrap();
        }
    }

    impl Drop for Live {
        fn drop(&mut self) {
            // This project's own containers and volumes, and nothing else.
            let _ = self.compose(&["down", "--volumes", "--remove-orphans"]);
            let name = self.root.file_name().unwrap().to_string_lossy().to_string();
            for suffix in ["stage", "backup", "baseline", "relayout"] {
                let _ = std::fs::remove_dir_all(
                    self.root
                        .parent()
                        .unwrap()
                        .join(format!(".{name}.openbot-update-{suffix}")),
                );
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    const KEPT: &[(&str, &str)] = &[
        (".secrets/CLAUDE_CODE_OAUTH_TOKEN.secret", "claude plan"),
        (crate::env::CHATGPT_STORE_FILE, "{\"chatgpt\":\"plan\"}"),
        (crate::local_eval_state::FILE, "{\"stack\":\"local\"}"),
    ];

    /// v0.3.0 as Install lays it out, its database migrated by v0.3.0's own server image and
    /// holding a row of the person's data.
    fn installed_v0_3_0(label: &str) -> Live {
        let live = Live::new(label);
        deployment::fetch(&live.root, "v0.3.0").expect("Install lays out v0.3.0 from GitHub");
        assert!(!live.root.join(updates::RELEASE).exists());
        crate::pull_metrics::pull_image(
            &live.engine,
            &deployment::reference(&live.root, "server").unwrap(),
            |_| {},
            |_| {},
        )
        .unwrap();
        live.migrated(DATABASE);
        live.psql(
            "create table follow_e2e (note text); insert into follow_e2e values ('made on v0.3.0');",
        );
        for (path, contents) in KEPT {
            std::fs::create_dir_all(live.root.join(path).parent().unwrap()).unwrap();
            std::fs::write(live.root.join(path), contents).unwrap();
        }
        live.stop();
        live.say(&format!(
            "v0.3.0 laid out from GitHub, migrated to {DATABASE}, one row of data"
        ));
        live
    }

    /// `follow_app_release` through the candidate's own migration: stage while nothing is stopped,
    /// then `apply_staged_update`'s checks, stop, backups and install.
    fn moved_until_migration(live: &Live) -> (Move, updates::Journal) {
        let planned = due(&live.root, None, &next()).expect("Start moves v0.3.0 to the app's");
        stage(&live.root, &planned, &published()).expect("v0.3.0 adopted and the next staged");
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(live.root.join(updates::RELEASE)).unwrap()
            )
            .unwrap()["version"],
            "v0.3.0"
        );
        live.say("v0.3.0 adopted against its published manifest and source; next release staged");
        let candidate = updates::staged_manifest(&live.root).unwrap();
        let pulling = std::time::Instant::now();
        let images = updates::stage_images(&live.engine, &live.root, None, |_, _, image| {
            crate::pull_metrics::pull_image(&live.engine, image, |_| {}, |_| {})
        })
        .unwrap();
        live.say(&format!(
            "staged {} images (the release names {}) in {:?}: {images:?}",
            images.len(),
            updates::candidate_images(&candidate).unwrap().len(),
            pulling.elapsed()
        ));

        let mut journal = updates::prepare_apply(&live.root).unwrap();
        assert_eq!(
            updates::require_staged_images(&live.root, Engine::Docker).unwrap(),
            images
        );
        crate::preparation::require_images(&live.engine, &images).unwrap();
        let secrets = live.secrets();
        let identity =
            crate::stack::runtime_update_identity(&live.engine, &live.root, &secrets).unwrap();
        crate::stack::verify_staged_runtime_identity(
            &live.engine,
            &live.root,
            &updates::stage_path(&live.root).unwrap(),
            &secrets,
            &identity,
        )
        .unwrap();
        let database = updates::accepted_database_identity(&live.root).unwrap();
        assert_eq!(database, DATABASE);

        live.stop();
        updates::backup_vendor(&live.root, &mut journal).unwrap();
        crate::stack::backup_runtime_database(
            &live.engine,
            &live.root,
            &secrets,
            &updates::database_backup_path(&journal),
            &database,
        )
        .expect("pg_dump of the v0.3.0 database");
        live.stop();
        updates::install_candidate(&live.root, &mut journal).unwrap();
        // Real Compose gives the same answer for the release in place as it gave for the stage.
        assert_eq!(
            crate::preparation::installation_pull_set(&live.engine, &live.root, &live.root, None)
                .unwrap(),
            images
        );
        assert_eq!(
            crate::stack::runtime_update_identity(&live.engine, &live.root, &live.secrets())
                .unwrap(),
            identity
        );
        updates::mark_starting(&live.root, &mut journal).unwrap();
        live.migrated(DATABASE);
        live.say("database backed up with pg_dump, next release installed and migrated");
        (planned, journal)
    }

    fn assert_kept(live: &Live) {
        for (path, contents) in KEPT {
            assert_eq!(
                std::fs::read_to_string(live.root.join(path)).unwrap(),
                *contents
            );
        }
        assert!(std::fs::read_to_string(live.root.join(".env"))
            .unwrap()
            .contains("KEY_ENCRYPTION_KEY=kept-across-the-move"));
        assert_eq!(live.psql("select note from follow_e2e"), "made on v0.3.0");
    }

    #[test]
    #[ignore = "moves a real v0.3.0 installation on this machine's Docker engine"]
    fn live_v0_3_0_moves_to_the_apps_release() {
        let live = installed_v0_3_0("move");
        let (_, mut journal) = moved_until_migration(&live);
        let accepted = updates::accept(&live.root, &mut journal).unwrap();
        live.say(&format!("accepted {accepted}"));

        let installed = deployment::installed(&live.root).unwrap();
        assert_eq!(installed.version, next());
        assert!(!installed.pinned);
        assert!(!deployment::needs_fetch(&live.root, &next()));
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(live.root.join(updates::RELEASE)).unwrap()
            )
            .unwrap()["version"],
            next()
        );
        updates::require_no_interruption(&live.root).unwrap();
        live.migrated(DATABASE);
        assert_kept(&live);
        assert_eq!(due(&live.root, None, &next()), None);
        live.stop();
        live.say("next release in force; data, secrets, sign-ins and the Intelligence record kept");
    }

    #[test]
    #[ignore = "moves a real v0.3.0 installation and back on this machine's Docker engine"]
    fn live_a_failed_move_restores_v0_3_0_and_its_database() {
        let live = installed_v0_3_0("rollback");
        let (planned, journal) = moved_until_migration(&live);
        drop(journal);
        // The candidate changed the database (a migration of its own), then failed its checks.
        live.psql("insert into drizzle.__drizzle_migrations (hash, created_at) values ('follow-e2e-candidate', 99999999999999)");
        assert!(crate::stack::verify_runtime_database_identity(
            &live.engine,
            &live.root,
            &live.secrets(),
            DATABASE
        )
        .is_err());
        live.stop();
        // `after_failed_candidate` finds the database changed and keeps the update record...
        assert_eq!(
            updates::restore_previous_release(&live.engine, &live.root, &live.secrets(), false)
                .unwrap(),
            updates::Restored::DatabaseChanged
        );
        live.stop();
        record_failure(&live.root, &planned).unwrap();
        // ...and `follow_app_release` puts it back with `recover_runtime_update`, database included.
        assert_eq!(
            updates::recover_without_engine(&live.root).unwrap(),
            updates::Recovery::NeedsEngine
        );
        assert_eq!(
            updates::restore_previous_release(&live.engine, &live.root, &live.secrets(), true)
                .unwrap(),
            updates::Restored::Done {
                database_restored: true
            }
        );
        live.stop();
        live.say("v0.3.0 files back, database restored from the pg_dump backup");

        // Then starts the release it had: v0.3.0's migrator finds its own database.
        let installed = deployment::installed(&live.root).unwrap();
        assert_eq!(installed.version, "v0.3.0");
        assert!(!deployment::needs_fetch(&live.root, "v0.3.0"));
        updates::require_no_interruption(&live.root).unwrap();
        live.migrated(DATABASE);
        assert_eq!(
            live.psql(
                "select count(*) from drizzle.__drizzle_migrations where hash = 'follow-e2e-candidate'"
            ),
            "0"
        );
        assert_kept(&live);
        assert_eq!(due(&live.root, None, &next()), None);
        live.stop();
        live.say("v0.3.0 runs on its own database again; nothing half-applied");
    }
}
