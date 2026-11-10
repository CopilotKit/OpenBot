//! Upgrading an installation to the app's own release.
//!
//! The app updates itself with the signed updater. On the next Start, an installation whose
//! deployment (`.openbot-deployment`) is not the app's own release is upgraded before it starts:
//!
//! 1. Stop OpenBot.
//! 2. Take one `pg_dump` of its database, if it has one, and keep the previous version's files
//!    (`KEPT`) in `.openbot-previous/`.
//! 3. Lay the app's release out exactly as Install does.
//! 4. Pull its images.
//! 5. Start. Its migrations run once, as the dependency Compose starts before the server.
//!
//! If any step fails, the previous files go back, the database is restored from the dump, and the
//! previous version starts. The person is told in one sentence.
//!
//! One rule for every build. The app's own release is the tag it was released as, or, for an
//! internal or candidate build, the release it was pinned to (`deployment::pinned`). A deployment
//! newer than the app is never moved back: its database is already migrated past what the app's
//! release knows, and the app's own update offer catches the app up instead.
//!
//! Untouched throughout: `.env`, keys, credentials, profiles, volumes, override files and every
//! other file the installation keeps for itself. Only the paths in `KEPT` move.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{deployment, engine::StepLine, preparation, problem::Problem};

/// Where the previous version waits while an upgrade runs. Gone once the upgrade finished or was
/// undone, so finding it at Start means the app stopped part way, and the previous version goes
/// back first.
pub const PREVIOUS: &str = ".openbot-previous";

/// The database as it was before the upgrade, inside `PREVIOUS`.
pub const DUMP: &str = "database.dump";

/// Which of `KEPT` were there to move, inside `PREVIOUS`. Written before anything moves, so an
/// upgrade that stopped part way puts back exactly what it took, and removes what the new version
/// added. Without it nothing was moved yet.
const MOVED: &str = "moved.json";

/// The previous version's files: what the containers run from, and the installation records that
/// describe them, so a version put back is installed and starts as it was without installing again.
///
/// And what earlier versions laid out for the browser they ran on the person's desktop beside the
/// server: its sources and the `shared` files they import, its packages' record, and the Recorder it
/// loaded. This app runs no such browser, so an upgrade takes them away with the previous version,
/// and puts them back only with it.
pub const KEPT: [&str; 9] = [
    "docker-compose.yml",
    "container-images.json",
    ".openbot-deployment",
    preparation::FILE,
    ".openbot-dependencies.json",
    preparation::LAUNCH,
    "agent-computer",
    "shared",
    "extension",
];

/// The release this app runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Own {
    pub version: String,
    /// An internal or candidate build, which lays out the commit it was pinned to.
    pub pinned: bool,
}

/// This app's own release.
pub fn own() -> Own {
    match deployment::pinned() {
        Some(pin) => Own {
            version: pin.version,
            pinned: true,
        },
        None => Own {
            version: app_release(),
            pinned: false,
        },
    }
}

/// The release a stable app is: its own version, as the installer and the shell updater deliver it.
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
    semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// The upgrade Start makes first, or `None` when this installation starts as it is.
///
/// Due when the installed deployment is not `own`: another version, or the same version of the
/// other kind (pinned or released). Not due for a deployment newer than `own`, which is never moved
/// back, nor for one Install still has to lay out: none at all, one that never finished laying out
/// (no image list, no Compose file), or a release from before the server ran in a container, which
/// Install moves to the latest release itself.
pub fn due(root: &Path, own: &Own) -> Option<Move> {
    let installed = deployment::installed(root)?;
    if deployment::predates_containers(root)
        || !deployment::images_path(root).is_file()
        || !root.join("docker-compose.yml").is_file()
    {
        return None;
    }
    if installed.version == own.version && installed.pinned == own.pinned {
        return None;
    }
    if let (Some(installed), Some(own)) = (release(&installed.version), release(&own.version)) {
        if installed > own {
            return None;
        }
    }
    Some(Move {
        from: installed.version,
        to: own.version.clone(),
    })
}

/// Whether an upgrade stopped part way, leaving the previous version in `PREVIOUS`.
pub fn interrupted(root: &Path) -> bool {
    root.join(PREVIOUS).is_dir()
}

/// The version an interrupted upgrade put aside, for saying what goes back.
pub fn previous_version(root: &Path) -> Option<String> {
    deployment::installed(&root.join(PREVIOUS)).map(|found| found.version)
}

/// What an upgrade does, each step as Install and Start do it. A trait so the order, the files and
/// the way back are one piece of code whether a window or a test drives them.
pub trait Steps {
    /// Say which step runs next, just before it runs (see `now_said`). Start's window shows one
    /// line for the whole upgrade, and a step that said nothing left the one before it on that line:
    /// "Stopping OpenBot." under the rows through a whole download, install and start.
    fn now(&mut self, _now: Now) {}
    /// Stop OpenBot: every container and host process of this installation. Volumes stay.
    fn stop(&mut self) -> Result<(), Problem>;
    /// Whether the installation has a database to back up. One that never started has none, and
    /// starting its Postgres to back it up would create one.
    fn has_database(&mut self) -> Result<bool, Problem> {
        Ok(true)
    }
    /// Take one `pg_dump` of the database into `to`, with the files laid out now, and stop the
    /// database again.
    fn back_up(&mut self, to: &Path) -> Result<(), Problem>;
    /// Lay the app's own release out, exactly as Install does for a new installation.
    fn lay_out(&mut self) -> Result<(), Problem>;
    /// Pull its images and finish installing it, as Install does.
    fn install(&mut self) -> Result<(), Problem>;
    /// Start what is laid out.
    fn start(&mut self) -> Result<(), Problem>;
    /// Put the database back from the dump at `from`, and stop the database again.
    fn restore(&mut self, from: &Path) -> Result<(), Problem>;
}

/// The step an upgrade is on, said as it begins (see `Steps::now`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Now {
    Stopping,
    BackingUp,
    Downloading,
    Installing,
    Starting,
    Restoring,
}

/// What the line under Start's rows says while `now` runs. Downloading and installing name the
/// release `own` lays out, and starting names the one laid out now: the new release, or the
/// previous one an upgrade that failed put back.
///
/// The screen says what is happening in plain words; the release names (`v1.0.1`, or a build's
/// `internal-…` tag) are in the log only, beside it.
pub fn now_said(now: Now, root: &Path, own: &Own) -> StepLine {
    match now {
        Now::Stopping => StepLine::here("Stopping OpenBot."),
        Now::BackingUp => {
            StepLine::here("Backing up your data.").logged("Backing up OpenBot's database.")
        }
        Now::Downloading => StepLine::here("Downloading the update.")
            .logged(format!("Downloading OpenBot {}.", own.version)),
        Now::Installing => StepLine::here("Installing the update.")
            .logged(format!("Installing OpenBot {}.", own.version)),
        Now::Starting => {
            StepLine::here("Starting OpenBot.").logged(match deployment::installed(root) {
                Some(found) => format!("Starting OpenBot {}.", found.version),
                None => "Starting OpenBot.".into(),
            })
        }
        Now::Restoring => {
            StepLine::here("Putting your data back.").logged("Putting OpenBot's database back.")
        }
    }
}

/// An upgrade the app stopped part way is back on the version it was updating from.
pub fn put_back_said(root: &Path) -> StepLine {
    StepLine::here("OpenBot is back on the version it had.").logged(
        match deployment::installed(root) {
            Some(found) => format!("OpenBot is back on {}.", found.version),
            None => "OpenBot is back on the version it was updating from.".into(),
        },
    )
}

/// How an upgrade ended.
#[derive(Debug)]
pub enum Ran {
    /// The new version is running.
    Moved,
    /// The upgrade failed, and the previous version is back, with its database, and running.
    Kept(Problem),
    /// The upgrade failed, the previous version is back, and then it did not start.
    Back { failed: Problem, start: Problem },
    /// The upgrade failed and the previous version could not be put back. `PREVIOUS` stays, so the
    /// next Start tries again.
    Stuck { failed: Problem, undo: Problem },
}

/// Upgrade the installation in `root`. See the module documentation for the steps.
pub fn run(root: &Path, steps: &mut dyn Steps) -> Ran {
    let previous = root.join(PREVIOUS);
    if let Err(failed) = said(steps, Now::Stopping, |steps| steps.stop()) {
        return restart(steps, failed);
    }
    // A folder left by an earlier upgrade is the caller's to put back (`recover`) first. One that
    // is still here holds nothing that was moved, so it is stale and goes.
    if let Err(error) = clear(&previous) {
        return restart(steps, Problem::with(UNCHANGED, error));
    }
    if let Err(error) = std::fs::create_dir_all(&previous) {
        return restart(
            steps,
            Problem::with(UNCHANGED, format!("{}: {error}", previous.display())),
        );
    }
    // No database, no dump: `undo` then restores nothing, and nothing here creates one.
    let backed_up = steps.has_database().and_then(|has| {
        if has {
            said(steps, Now::BackingUp, |steps| {
                steps.back_up(&previous.join(DUMP))
            })
        } else {
            Ok(())
        }
    });
    if let Err(failed) = backed_up {
        let _ = clear(&previous);
        return restart(steps, failed);
    }
    if let Err(error) = keep(root) {
        // Anything that moved goes back. The database never changed.
        return match put_back(root) {
            Ok(_) => {
                let _ = clear(&previous);
                restart(steps, Problem::with(UNCHANGED, error))
            }
            Err(undo) => Ran::Stuck {
                failed: Problem::with(UNCHANGED, error),
                undo: Problem::from(undo),
            },
        };
    }
    let upgraded = said(steps, Now::Downloading, |steps| steps.lay_out())
        .and_then(|()| said(steps, Now::Installing, |steps| steps.install()))
        .and_then(|()| said(steps, Now::Starting, |steps| steps.start()));
    match upgraded {
        Ok(()) => {
            finish(&previous);
            Ran::Moved
        }
        Err(failed) => match undo(root, steps) {
            Ok(()) => restart(steps, failed),
            Err(undo) => Ran::Stuck { failed, undo },
        },
    }
}

/// Put back the previous version an upgrade left in `PREVIOUS`, with its database, when the app
/// stopped part way through one. Returns whether there was one.
pub fn recover(root: &Path, steps: &mut dyn Steps) -> Result<bool, Problem> {
    if !interrupted(root) {
        return Ok(false);
    }
    undo(root, steps)?;
    Ok(true)
}

/// Stop whatever the new version started, put the previous files back, restore the database when
/// anything had moved, and clear `PREVIOUS`. On failure `PREVIOUS` stays for the next try.
fn undo(root: &Path, steps: &mut dyn Steps) -> Result<(), Problem> {
    let previous = root.join(PREVIOUS);
    said(steps, Now::Stopping, |steps| steps.stop())?;
    let moved = put_back(root).map_err(|error| {
        Problem::with(
            "OpenBot could not put its previous version's files back.",
            error,
        )
    })?;
    let dump = previous.join(DUMP);
    if moved && dump.is_file() {
        said(steps, Now::Restoring, |steps| steps.restore(&dump))?;
    }
    finish(&previous);
    Ok(())
}

fn restart(steps: &mut dyn Steps, failed: Problem) -> Ran {
    match said(steps, Now::Starting, |steps| steps.start()) {
        Ok(()) => Ran::Kept(failed),
        Err(start) => Ran::Back { failed, start },
    }
}

/// Run one step, saying it first. Every step goes through here, so none runs under the sentence of
/// the one before it.
fn said(
    steps: &mut dyn Steps,
    now: Now,
    step: impl FnOnce(&mut dyn Steps) -> Result<(), Problem>,
) -> Result<(), Problem> {
    steps.now(now);
    step(steps)
}

const UNCHANGED: &str = "OpenBot could not set its previous version aside, so nothing changed.";

/// Move the previous version's files into `PREVIOUS`, recording which first.
fn keep(root: &Path) -> Result<(), String> {
    let previous = root.join(PREVIOUS);
    let present: Vec<&str> = KEPT
        .iter()
        .copied()
        .filter(|name| root.join(name).symlink_metadata().is_ok())
        .collect();
    let record = serde_json::to_vec(&present).map_err(|e| e.to_string())?;
    write_synced(&previous.join(MOVED), &record)?;
    for name in present {
        std::fs::rename(root.join(name), previous.join(name))
            .map_err(|error| format!("could not set {name} aside: {error}"))?;
    }
    Ok(())
}

/// Put every file `keep` moved back in place, and remove what the new version laid out where the
/// previous one had nothing. Returns whether anything had been moved.
fn put_back(root: &Path) -> Result<bool, String> {
    let previous = root.join(PREVIOUS);
    let record = match std::fs::read(previous.join(MOVED)) {
        Ok(record) => record,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let moved: Vec<String> = serde_json::from_slice(&record).map_err(|e| e.to_string())?;
    for name in KEPT {
        let target = root.join(name);
        let saved = previous.join(name);
        if moved.iter().any(|entry| entry == name) {
            // Not in `PREVIOUS`: the move never happened, and the original is still in place.
            if saved.symlink_metadata().is_ok() {
                remove(&target)?;
                std::fs::rename(&saved, &target)
                    .map_err(|error| format!("could not put {name} back: {error}"))?;
            }
        } else {
            remove(&target)?;
        }
    }
    Ok(true)
}

/// Done with `PREVIOUS`. The record goes first: without it, whatever is left is stale and nothing
/// is put back from it, so a folder that could not be removed whole never undoes a finished
/// upgrade on the next Start.
fn finish(previous: &Path) {
    let _ = std::fs::remove_file(previous.join(MOVED));
    let _ = std::fs::remove_dir_all(previous);
}

fn clear(previous: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(previous) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}: {error}", previous.display())),
    }
}

fn remove(path: &Path) -> Result<(), String> {
    let Ok(metadata) = path.symlink_metadata() else {
        return Ok(());
    };
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| format!("could not remove {}: {error}", path.display()))
}

fn write_synced(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// What Start says while it upgrades. The releases are the log's: `moved_log`.
pub fn moving_said(planned: &Move) -> StepLine {
    StepLine::here("Updating OpenBot. Your Bots, sign-ins and data stay as they are.")
        .logged(moved_log(planned))
}

/// The upgrade, by its releases, for the log beside what the screen says.
pub fn moved_log(planned: &Move) -> String {
    format!("updating OpenBot from {} to {}", planned.from, planned.to)
}

/// The upgrade failed, and the previous version is running again.
pub fn kept_said(_planned: &Move) -> String {
    "OpenBot couldn't update, so it's still on the version it had, with your data as it was.".into()
}

/// The upgrade failed, the previous version is back, and it did not start.
pub fn back_said(_planned: &Move, start: &Problem) -> String {
    format!(
        "OpenBot couldn't update and went back to the version it had. {}",
        start.said
    )
}

/// The upgrade failed, and the previous version could not be put back.
pub fn stuck_said(_planned: &Move) -> String {
    "OpenBot couldn't update or put the version it had back. Choose Retry to try putting it back \
     again."
        .into()
}

/// What Start reports when it upgraded, or tried to.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub from: String,
    pub to: String,
    pub moved: bool,
    /// Said on the running screen when the upgrade did not happen and the previous version started.
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

    pub fn kept(planned: &Move, failed: &Problem) -> Self {
        Self {
            from: planned.from.clone(),
            to: planned.to.clone(),
            moved: false,
            notice: Some(Problem::with(kept_said(planned), detail(failed))),
        }
    }
}

/// A problem's sentence and its detail together, for the detail of the one that reports it.
pub fn detail(problem: &Problem) -> String {
    match &problem.detail {
        Some(detail) => format!("{}\n{detail}", problem.said),
        None => problem.said.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn laid_out(version: &str, pinned: bool) -> PathBuf {
        let root = temp_root("upgrade-due");
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

    fn released(version: &str) -> Own {
        Own {
            version: version.into(),
            pinned: false,
        }
    }

    fn pinned(version: &str) -> Own {
        Own {
            version: version.into(),
            pinned: true,
        }
    }

    #[test]
    fn an_older_deployment_is_upgraded_to_the_apps_release() {
        let root = laid_out("v0.3.0", false);
        assert_eq!(
            due(&root, &released("v0.3.1")),
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
            assert_eq!(due(&root, &released("v0.3.1")), None, "{installed}");
            std::fs::remove_dir_all(root).unwrap();
        }
        // A candidate newer than the app is not moved back either.
        let root = laid_out("v0.3.2-rc.1", true);
        assert_eq!(due(&root, &released("v0.3.1")), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The one rule for every build: a pinned build upgrades a deployment that is not its own
    /// release the same way, rather than laying its release out over it at Install.
    #[test]
    fn a_pinned_build_upgrades_by_the_same_rule() {
        let root = laid_out("v0.3.0", false);
        assert_eq!(
            due(&root, &pinned("internal-abc")),
            Some(Move {
                from: "v0.3.0".into(),
                to: "internal-abc".into()
            })
        );
        std::fs::remove_dir_all(root).unwrap();

        let root = laid_out("internal-abc", true);
        assert_eq!(due(&root, &pinned("internal-abc")), None);
        assert_eq!(
            due(&root, &pinned("internal-def")).map(|planned| planned.to),
            Some("internal-def".into())
        );
        // A stable app moves a deployment a test build left behind to its own release.
        assert_eq!(
            due(&root, &released("v0.3.1")).map(|planned| planned.to),
            Some("v0.3.1".into())
        );
        std::fs::remove_dir_all(root).unwrap();

        // The same version of the other kind is laid out as this build's own.
        let root = laid_out("v0.3.1", true);
        assert!(due(&root, &released("v0.3.1")).is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_deployment_install_still_has_to_lay_out_is_left_to_install() {
        let root = laid_out("v0.3.0", false);
        std::fs::remove_file(deployment::images_path(&root)).unwrap();
        assert_eq!(due(&root, &released("v0.3.1")), None);
        std::fs::remove_dir_all(root).unwrap();

        let root = temp_root("upgrade-due-nothing");
        assert_eq!(due(&root, &released("v0.3.1")), None);

        // A release whose server ran on the host: Install lays the latest out instead.
        let root = laid_out("v0.2.0", false);
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  supervisor: {}\n",
        )
        .unwrap();
        assert_eq!(due(&root, &released("v0.3.1")), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn this_app_is_the_release_its_package_names() {
        let package: serde_json::Value = serde_json::from_slice(
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
    fn what_is_said_is_one_plain_sentence() {
        let planned = Move {
            from: "v0.3.0".into(),
            to: "v0.3.1".into(),
        };
        for said in [kept_said(&planned), moving_said(&planned).said] {
            assert!(!said.contains('\u{2014}'), "{said}");
            // The releases are the log's, never the screen's.
            assert!(!said.contains("0.3"), "{said}");
        }
        assert_eq!(
            kept_said(&planned),
            "OpenBot couldn't update, so it's still on the version it had, with your data as it was."
        );
        assert!(moving_said(&planned)
            .log_entry()
            .contains("from v0.3.0 to v0.3.1"));
    }

    /// The screen a failed Start leaves has Retry, Change AI connection and Repair installation,
    /// and no Start. Retry runs Start again, which puts the previous version back first.
    #[test]
    fn a_previous_version_that_could_not_go_back_names_the_retry_that_is_on_screen() {
        let planned = Move {
            from: "v0.3.0".into(),
            to: "v0.3.1".into(),
        };
        let said = stuck_said(&planned);
        assert!(said.contains("Choose Retry"), "{said}");
        assert!(!said.contains("Choose Start"), "{said}");
    }

    // ---- The steps, against files on disk and a recording of what ran ----

    /// Lays out `version` as the new release: its Compose file.
    struct Recorded {
        root: PathBuf,
        version: String,
        ran: Vec<String>,
        fail: Option<&'static str>,
        database: String,
        /// Whether the installation has a database at all. One that never started has none.
        has_database: bool,
        /// What the line under Start's rows says now, and what it said as each step ran.
        line: Option<String>,
        lines: Vec<Option<String>>,
    }

    impl Recorded {
        fn step(&mut self, name: &'static str) -> Result<(), Problem> {
            self.ran.push(name.into());
            self.lines.push(self.line.clone());
            if self.fail == Some(name) {
                return Err(Problem::with("failed", name));
            }
            Ok(())
        }
    }

    impl Steps for Recorded {
        fn now(&mut self, now: Now) {
            self.line = Some(now_said(now, &self.root, &released(&self.version)).said);
        }
        fn stop(&mut self) -> Result<(), Problem> {
            self.step("stop")
        }
        fn has_database(&mut self) -> Result<bool, Problem> {
            Ok(self.has_database)
        }
        fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
            self.step("back_up")?;
            std::fs::write(to, &self.database).unwrap();
            Ok(())
        }
        fn lay_out(&mut self) -> Result<(), Problem> {
            self.step("lay_out")?;
            std::fs::write(
                self.root.join("docker-compose.yml"),
                format!(
                    "# {}\nservices:\n  server: {{}}\n  worker: {{}}\n",
                    self.version
                ),
            )
            .unwrap();
            std::fs::write(deployment::images_path(&self.root), &self.version).unwrap();
            deployment::record(&self.root, &self.version, false).unwrap();
            Ok(())
        }
        fn install(&mut self) -> Result<(), Problem> {
            self.step("install")?;
            std::fs::write(self.root.join(preparation::FILE), &self.version).unwrap();
            Ok(())
        }
        fn start(&mut self) -> Result<(), Problem> {
            self.step("start")?;
            // A server's migration changes the database as it starts.
            self.database = format!(
                "{}; started {}",
                self.database,
                deployment::installed(&self.root).unwrap().version
            );
            Ok(())
        }
        fn restore(&mut self, from: &Path) -> Result<(), Problem> {
            self.step("restore")?;
            self.database = std::fs::read_to_string(from).unwrap();
            Ok(())
        }
    }

    fn installation() -> (PathBuf, Recorded) {
        let root = laid_out("v0.3.0", false);
        std::fs::create_dir_all(root.join("agent-computer/node_modules")).unwrap();
        std::fs::write(root.join("agent-computer/package.json"), "v0.3.0").unwrap();
        std::fs::write(root.join(preparation::FILE), "v0.3.0").unwrap();
        std::fs::write(root.join(".env"), "KEY_ENCRYPTION_KEY=kept\n").unwrap();
        std::fs::create_dir_all(root.join(".openbot")).unwrap();
        std::fs::write(root.join(".openbot/sign-in.json"), "kept").unwrap();
        std::fs::write(root.join("docker-compose.override.yml"), "kept").unwrap();
        let steps = Recorded {
            root: root.clone(),
            version: "v0.3.1".into(),
            ran: Vec::new(),
            fail: None,
            database: "rows at v0.3.0".into(),
            has_database: true,
            line: None,
            lines: Vec::new(),
        };
        (root, steps)
    }

    fn untouched(root: &Path) {
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "KEY_ENCRYPTION_KEY=kept\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".openbot/sign-in.json")).unwrap(),
            "kept"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.override.yml")).unwrap(),
            "kept"
        );
    }

    #[test]
    fn an_upgrade_stops_backs_up_lays_out_pulls_and_starts_in_that_order() {
        let (root, mut steps) = installation();
        assert!(matches!(run(&root, &mut steps), Ran::Moved));
        assert_eq!(
            steps.ran,
            ["stop", "back_up", "lay_out", "install", "start"]
        );
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.1");
        assert!(!root.join(PREVIOUS).exists(), "nothing is left aside");
        // The browser an earlier version ran on the desktop went with its files: this one runs none.
        assert!(!root.join("agent-computer").exists());
        untouched(&root);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Start's window shows one line under its rows for the whole upgrade, and it says the step
    /// that runs now. Each step used to say itself only if it was the stop, the backup or the
    /// restore, so "Stopping OpenBot." or "Backing up OpenBot's database." stayed on that line
    /// through the download, the install and the start that came after them.
    #[test]
    fn every_step_of_an_upgrade_runs_under_its_own_sentence() {
        let lines = |steps: &Recorded| -> Vec<(String, String)> {
            steps
                .ran
                .iter()
                .cloned()
                .zip(
                    steps
                        .lines
                        .iter()
                        .map(|line| line.clone().unwrap_or_default()),
                )
                .collect()
        };
        let said = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(step, line)| (step.to_string(), line.to_string()))
                .collect()
        };

        let (root, mut steps) = installation();
        assert!(matches!(run(&root, &mut steps), Ran::Moved));
        assert_eq!(
            lines(&steps),
            said(&[
                ("stop", "Stopping OpenBot."),
                ("back_up", "Backing up your data."),
                ("lay_out", "Downloading the update."),
                ("install", "Installing the update."),
                ("start", "Starting OpenBot."),
            ])
        );
        std::fs::remove_dir_all(root).unwrap();

        // No database: the stop's sentence is not left there for the rest of the upgrade.
        let (root, mut steps) = installation();
        steps.has_database = false;
        assert!(matches!(run(&root, &mut steps), Ran::Moved));
        assert_eq!(
            lines(&steps),
            said(&[
                ("stop", "Stopping OpenBot."),
                ("lay_out", "Downloading the update."),
                ("install", "Installing the update."),
                ("start", "Starting OpenBot."),
            ])
        );
        std::fs::remove_dir_all(root).unwrap();

        // A failed install puts v0.3.0 back, and the start says that is the version starting.
        let (root, mut steps) = installation();
        steps.fail = Some("install");
        assert!(matches!(run(&root, &mut steps), Ran::Kept(_)));
        assert_eq!(
            lines(&steps),
            said(&[
                ("stop", "Stopping OpenBot."),
                ("back_up", "Backing up your data."),
                ("lay_out", "Downloading the update."),
                ("install", "Installing the update."),
                ("stop", "Stopping OpenBot."),
                ("restore", "Putting your data back."),
                ("start", "Starting OpenBot."),
            ])
        );
        assert_eq!(
            put_back_said(&root).said,
            "OpenBot is back on the version it had."
        );
        assert_eq!(
            put_back_said(&root).detail.as_deref(),
            Some("OpenBot is back on v0.3.0.")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// An installation that never started (on Windows every 0.3.1 one: Intelligence never set up)
    /// has no database. Backing it up would start Postgres, which creates an empty database volume
    /// with no encryption key beside it, and the new version's Start then refuses it as a previous
    /// installation's data ("Start fresh"). Nothing is backed up, and nothing is restored.
    #[test]
    fn an_installation_with_no_database_is_upgraded_without_creating_one() {
        let (root, mut steps) = installation();
        steps.has_database = false;
        assert!(matches!(run(&root, &mut steps), Ran::Moved));
        assert_eq!(steps.ran, ["stop", "lay_out", "install", "start"]);
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.1");
        std::fs::remove_dir_all(&root).unwrap();

        let (root, mut steps) = installation();
        steps.has_database = false;
        steps.fail = Some("install");
        let ran = run(&root, &mut steps);
        assert!(matches!(ran, Ran::Kept(_)), "{ran:?}");
        assert_eq!(
            steps.ran,
            ["stop", "lay_out", "install", "stop", "start"],
            "no backup, so no restore"
        );
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_start_puts_the_previous_version_and_its_database_back_and_starts_it() {
        let (root, mut steps) = installation();
        steps.fail = Some("install");
        let ran = run(&root, &mut steps);
        assert!(matches!(ran, Ran::Kept(_)), "{ran:?}");
        assert_eq!(
            steps.ran,
            ["stop", "back_up", "lay_out", "install", "stop", "restore", "start"]
        );
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert_eq!(
            std::fs::read_to_string(root.join("agent-computer/package.json")).unwrap(),
            "v0.3.0"
        );
        assert!(root.join("agent-computer/node_modules").is_dir());
        assert_eq!(
            std::fs::read_to_string(root.join(preparation::FILE)).unwrap(),
            "v0.3.0"
        );
        assert_eq!(steps.database, "rows at v0.3.0; started v0.3.0");
        assert!(!root.join(PREVIOUS).exists());
        untouched(&root);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_version_that_migrated_and_then_failed_has_its_database_restored() {
        let (root, mut steps) = installation();
        // Started (and migrated), then reported a failure: the readiness wait, say.
        struct FailsAfterStarting(Recorded, bool);
        impl Steps for FailsAfterStarting {
            fn stop(&mut self) -> Result<(), Problem> {
                self.0.stop()
            }
            fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
                self.0.back_up(to)
            }
            fn lay_out(&mut self) -> Result<(), Problem> {
                self.0.lay_out()
            }
            fn install(&mut self) -> Result<(), Problem> {
                self.0.install()
            }
            fn start(&mut self) -> Result<(), Problem> {
                self.0.start()?;
                if !self.1 {
                    self.1 = true;
                    return Err(Problem::plain("did not answer"));
                }
                Ok(())
            }
            fn restore(&mut self, from: &Path) -> Result<(), Problem> {
                self.0.restore(from)
            }
        }
        steps.database = "rows at v0.3.0".into();
        let mut failing = FailsAfterStarting(steps, false);
        assert!(matches!(run(&root, &mut failing), Ran::Kept(_)));
        // The new version's start is gone with the restore; only the previous version's own is left.
        assert_eq!(failing.0.database, "rows at v0.3.0; started v0.3.0");
        assert_eq!(
            failing.0.ran,
            ["stop", "back_up", "lay_out", "install", "start", "stop", "restore", "start"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_backup_changes_nothing_and_starts_the_previous_version() {
        let (root, mut steps) = installation();
        steps.fail = Some("back_up");
        assert!(matches!(run(&root, &mut steps), Ran::Kept(_)));
        assert_eq!(steps.ran, ["stop", "back_up", "start"]);
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert!(!root.join(PREVIOUS).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_previous_version_that_does_not_start_again_says_both() {
        let (root, mut steps) = installation();
        steps.fail = Some("start");
        let ran = run(&root, &mut steps);
        let Ran::Back { failed, start } = ran else {
            panic!("{ran:?}")
        };
        assert_eq!(failed.detail.as_deref(), Some("start"));
        assert_eq!(start.detail.as_deref(), Some("start"));
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_previous_version_that_cannot_go_back_is_kept_aside_for_the_next_start() {
        let (root, mut steps) = installation();
        struct RestoreFails(Recorded);
        impl Steps for RestoreFails {
            fn stop(&mut self) -> Result<(), Problem> {
                self.0.stop()
            }
            fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
                self.0.back_up(to)
            }
            fn lay_out(&mut self) -> Result<(), Problem> {
                self.0.lay_out()
            }
            fn install(&mut self) -> Result<(), Problem> {
                Err(Problem::plain("pull failed"))
            }
            fn start(&mut self) -> Result<(), Problem> {
                self.0.start()
            }
            fn restore(&mut self, _: &Path) -> Result<(), Problem> {
                Err(Problem::plain("restore failed"))
            }
        }
        steps.database = "rows at v0.3.0".into();
        let mut failing = RestoreFails(steps);
        assert!(matches!(run(&root, &mut failing), Ran::Stuck { .. }));
        assert!(interrupted(&root));
        assert!(root.join(PREVIOUS).join(DUMP).is_file());

        // The next Start finishes putting it back.
        let mut steps = failing.0;
        steps.ran.clear();
        assert!(recover(&root, &mut steps).unwrap());
        assert_eq!(steps.ran, ["stop", "restore"]);
        assert!(!interrupted(&root));
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert_eq!(steps.database, "rows at v0.3.0");
        untouched(&root);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The app quit after the previous files were set aside and the new ones laid out: the next
    /// Start puts back exactly what was set aside, removes what the new version added where the
    /// previous one had nothing, and restores the database.
    #[test]
    fn an_upgrade_the_app_stopped_part_way_is_put_back_at_the_next_start() {
        let (root, mut steps) = installation();
        std::fs::create_dir_all(root.join(PREVIOUS)).unwrap();
        std::fs::write(root.join(PREVIOUS).join(DUMP), "rows at v0.3.0").unwrap();
        keep(&root).unwrap();
        steps.lay_out().unwrap();
        steps.install().unwrap();
        std::fs::write(root.join(preparation::LAUNCH), "made by v0.3.1").unwrap();
        steps.start().unwrap();
        steps.ran.clear();

        assert!(recover(&root, &mut steps).unwrap());
        assert_eq!(steps.ran, ["stop", "restore"]);
        assert_eq!(steps.database, "rows at v0.3.0");
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert!(
            !root.join(preparation::LAUNCH).exists(),
            "the previous version had no launch record"
        );
        assert!(!interrupted(&root));
        untouched(&root);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Stopped before anything moved: the dump is there, nothing else is, and the database never
    /// changed, so nothing is restored.
    #[test]
    fn an_upgrade_stopped_before_anything_moved_restores_nothing() {
        let (root, mut steps) = installation();
        std::fs::create_dir_all(root.join(PREVIOUS)).unwrap();
        std::fs::write(root.join(PREVIOUS).join(DUMP), "rows at v0.3.0").unwrap();
        assert!(recover(&root, &mut steps).unwrap());
        assert_eq!(steps.ran, ["stop"]);
        assert_eq!(deployment::installed(&root).unwrap().version, "v0.3.0");
        assert!(!interrupted(&root));
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// The upgrade against a real container engine, with the product's own layout (`deployment`), pull
/// (`pull_metrics`), Start (`stack::up`), Stop (`stack::down`), `pg_dump` and `pg_restore` (`stack`).
/// Releases are two versions of a fixture with the shape of OpenBot's own Compose file: Postgres, a
/// `migrate` that `server` depends on, and the other services Start raises, all from a "server"
/// image the fixture pushes to a local registry, so every pull is a real pull. Each migration
/// records that it ran, so "once" is counted rather than assumed. Its own Compose project, volume,
/// folder and image tags; nothing else on the engine is touched.
///
/// ```sh
/// OPENBOT_TEST_REGISTRY=127.0.0.1:5050 cargo test --locked --lib upgrade::real_engine -- --ignored --test-threads=1
/// ```
#[cfg(test)]
mod real_engine {
    use super::*;
    use crate::{engine, pull_metrics, stack};

    const POSTGRES: &str = "pgvector/pgvector:pg17";
    const N: &str = "v0.0.1";
    const NEXT: &str = "v0.0.2";

    fn compose(version: &str) -> String {
        let migration = format!(
            "create table if not exists fixture_migrations(version text not null, ran_at timestamptz not null default now()); insert into fixture_migrations(version) values ('{version}');"
        );
        format!(
            r#"# OpenBot fixture {version}
services:
  postgres:
    image: {POSTGRES}
    environment:
      POSTGRES_DB: openbot
      POSTGRES_USER: openbot
      POSTGRES_PASSWORD: openbot
    # Published on loopback, as OpenBot's own Compose file does, so a client on the host can reach it.
    ports:
      - "127.0.0.1:${{POSTGRES_PORT:-5432}}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openbot -d openbot"]
      interval: 1s
      timeout: 5s
      retries: 60
  migrate:
    image: ${{SERVER_IMAGE:-openbot-upgrade-fixture-unset}}
    command: ["psql", "postgres://openbot:openbot@postgres:5432/openbot", "-v", "ON_ERROR_STOP=1", "-c", "{migration}"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"
  server:
    profiles: ["openbot"]
    image: ${{SERVER_IMAGE:-openbot-upgrade-fixture-unset}}
    # Connected to the database for as long as it runs, as the real server's pool is.
    command: ["psql", "postgres://openbot:openbot@postgres:5432/openbot", "-c", "select pg_sleep(100000)"]
    depends_on:
      migrate:
        condition: service_completed_successfully
  worker:
    profiles: ["openbot"]
    image: ${{SERVER_IMAGE:-openbot-upgrade-fixture-unset}}
    command: ["psql", "postgres://openbot:openbot@postgres:5432/openbot", "-c", "select pg_sleep(100000)"]
    depends_on:
      migrate:
        condition: service_completed_successfully
  supervisor:
    image: ${{SUPERVISOR_IMAGE:-openbot-upgrade-fixture-unset}}
    command: ["sleep", "infinity"]
    environment:
      COMPUTER_NAMESPACE: ${{COMPUTER_NAMESPACE:-upgrade-fixture}}
  agent-computer:
    image: ${{COMPUTER_IMAGE:-openbot-upgrade-fixture-unset}}
    command: ["sleep", "infinity"]
volumes:
  postgres-data:
"#
        )
    }

    /// GitHub's tag tarball for `version`: the Compose file, beside what the deployment leaves out.
    fn tarball(version: &str) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tarball = tar::Builder::new(encoder);
        let compose = compose(version);
        let source = format!("// the computer at {version}\n");
        let files: Vec<(&str, &str)> = vec![
            ("docker-compose.yml", compose.as_str()),
            ("agent-computer/src/index.ts", source.as_str()),
        ];
        for (path, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tarball
                .append_data(
                    &mut header,
                    format!("OpenBot-{}/{path}", version.trim_start_matches('v')),
                    body.as_bytes(),
                )
                .unwrap();
        }
        tarball.into_inner().unwrap().finish().unwrap()
    }

    fn images(version: &str, server: &str) -> Vec<u8> {
        let images: serde_json::Map<String, serde_json::Value> = deployment::IMAGE_VARIABLES
            .iter()
            .map(|(name, _)| {
                (
                    (*name).to_string(),
                    serde_json::json!({ "reference": server }),
                )
            })
            .collect();
        serde_json::to_vec(&serde_json::json!({ "version": version, "images": images })).unwrap()
    }

    struct Fixture {
        root: PathBuf,
        project: String,
        /// The host port the fixture's Postgres is published on.
        port: u16,
        address: engine::Address,
        /// What `get` answers for each release: its tarball and its image list.
        releases: Vec<(String, Vec<u8>, Vec<u8>)>,
        tags: Vec<String>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let unique = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let project = format!("openbot-upgrade-fixture-{label}-{unique}");
            let root = std::env::temp_dir().join(&project);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(
                root.join(stack::PROJECT_FILE),
                serde_json::json!({ "project": project }).to_string(),
            )
            .unwrap();
            let selected = match std::env::var("OPENBOT_TEST_ENGINE").as_deref() {
                Ok("podman") => engine::Engine::Podman,
                Ok("docker") | Err(_) => engine::Engine::Docker,
                Ok(other) => panic!("unknown explicit test engine: {other}"),
            };
            let address =
                engine::Address::new(selected, std::env::var("OPENBOT_TEST_CONNECTION").ok())
                    .pin()
                    .expect("the explicitly selected test engine answers");
            let port = std::net::TcpListener::bind(("127.0.0.1", 0))
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            Self {
                root,
                project,
                port,
                address,
                releases: Vec::new(),
                tags: Vec::new(),
            }
        }

        fn engine(&self, args: &[&str]) -> std::process::Output {
            self.address
                .command()
                .current_dir(&self.root)
                .args(args)
                .output()
                .unwrap()
        }

        fn ok(&self, args: &[&str]) -> String {
            let output = self.engine(args);
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        /// A "server" image for `version` in the local registry, and not on the engine, so
        /// installing the release really pulls it.
        fn publish(&mut self, version: &str) -> String {
            let registry =
                std::env::var("OPENBOT_TEST_REGISTRY").unwrap_or_else(|_| "127.0.0.1:5050".into());
            let tag = format!(
                "{registry}/openbot-upgrade-fixture/server:{version}-{}",
                self.project.rsplit('-').next().unwrap()
            );
            // Recorded first, so a push that fails still leaves no tag behind.
            self.tags.push(tag.clone());
            self.ok(&["tag", POSTGRES, &tag]);
            self.ok(&["push", "--quiet", &tag]);
            self.ok(&["image", "rm", &tag]);
            tag
        }

        /// A release whose image list names `server`.
        fn release(&mut self, version: &str, server: &str) {
            self.releases
                .push((version.into(), tarball(version), images(version, server)));
        }

        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            for (version, tarball, images) in &self.releases {
                if url
                    == format!(
                        "https://github.com/CopilotKit/OpenBot/archive/refs/tags/{version}.tar.gz"
                    )
                {
                    return Ok(tarball.clone());
                }
                if url
                    == format!("https://github.com/CopilotKit/OpenBot/releases/download/{version}/container-images.json")
                {
                    return Ok(images.clone());
                }
            }
            Err(format!("404 {url}"))
        }

        fn sql(&self, query: &str) -> String {
            self.ok(&[
                "compose",
                "-p",
                &self.project,
                "exec",
                "-T",
                "postgres",
                "psql",
                "-U",
                "openbot",
                "-d",
                "openbot",
                "-tAc",
                query,
            ])
        }

        fn running(&self) -> Vec<String> {
            let listed = self.ok(&[
                "compose",
                "-p",
                &self.project,
                "--profile",
                "openbot",
                "ps",
                "--status",
                "running",
                "--format",
                "{{.Service}} {{.Image}}",
            ]);
            let mut running: Vec<String> = listed.lines().map(str::to_string).collect();
            running.sort();
            running
        }
    }

    impl Fixture {
        /// Something outside the installation's Compose project that keeps connecting to its
        /// database through the published port, and reconnects whenever it is cut off: what a
        /// developer's OpenBot server left running on the host does to the Desktop's Postgres on
        /// 5432 (found holding 12 sessions in the real failure). Six sessions, each opened again as
        /// soon as it ends. Not part of the project, so no Stop or `down` of it touches them.
        fn connect_from_outside(&mut self) {
            let url = format!(
                "postgres://openbot:openbot@host.docker.internal:{}/openbot",
                self.port
            );
            let session = format!(
                "(while true; do psql '{url}' -c 'select pg_sleep(100000)' >/dev/null 2>&1; sleep 0.2; done) &"
            );
            let script = format!("{} wait", session.repeat(6));
            let name = format!("{}-outside-client", self.project);
            self.ok(&[
                "run",
                "--detach",
                "--name",
                &name,
                "--add-host",
                "host.docker.internal:host-gateway",
                "--entrypoint",
                "sh",
                POSTGRES,
                "-c",
                &script,
            ]);
            // Connected before anything below runs.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while self.outside_sessions() < 6 {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the outside client never connected"
                );
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }

        /// Sessions open to the database from anything but the project's own containers.
        fn outside_sessions(&self) -> usize {
            self.sql(
                "select count(*) from pg_stat_activity where datname = 'openbot' and query like '%pg_sleep(100000)%' and pid <> pg_backend_pid()",
            )
            .parse::<usize>()
            .unwrap_or(0)
                .saturating_sub(2)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.engine(&["rm", "--force", &format!("{}-outside-client", self.project)]);
            let _ = self.engine(&[
                "compose",
                "-p",
                &self.project,
                "--profile",
                "openbot",
                "down",
                "--volumes",
                "--remove-orphans",
            ]);
            // Whatever a failed run left that `down` did not take: this project's, by its label.
            let label = format!("label=com.docker.compose.project={}", self.project);
            let leftovers: [(&[&str], &[&str]); 3] = [
                (&["ps", "--all", "--quiet"], &["rm", "--force"]),
                (&["volume", "ls", "--quiet"], &["volume", "rm", "--force"]),
                (&["network", "ls", "--quiet"], &["network", "rm"]),
            ];
            for (list, remove) in leftovers {
                let mut listing = list.to_vec();
                listing.extend(["--filter", label.as_str()]);
                let listed = self.engine(&listing);
                for id in String::from_utf8_lossy(&listed.stdout).split_whitespace() {
                    let mut removing = remove.to_vec();
                    removing.push(id);
                    let _ = self.engine(&removing);
                }
            }
            for tag in &self.tags {
                let _ = self.engine(&["image", "rm", tag]);
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Each step as the window's (`DesktopSteps` in main.rs) runs it, through the same functions.
    struct Real<'a> {
        fixture: &'a Fixture,
        to: String,
        ran: Vec<&'static str>,
    }

    impl Real<'_> {
        fn secrets(&self) -> stack::Secrets {
            // Start writes the image variables into `.env` and hands them to Compose.
            let variables = deployment::image_variables(&self.fixture.root).unwrap_or_default();
            let env: String = variables
                .iter()
                .map(|(key, value)| format!("{key}={value}\n"))
                .collect();
            let env = format!("{env}POSTGRES_PORT={}\n", self.fixture.port);
            std::fs::write(self.fixture.root.join(".env"), env).unwrap();
            let mut secrets: stack::Secrets = variables.into_iter().collect();
            secrets.insert("POSTGRES_PORT".into(), self.fixture.port.to_string());
            secrets
        }

        fn down(&self) -> Result<(), Problem> {
            stack::down(&self.fixture.address, &self.fixture.root).map_err(Problem::from)
        }
    }

    impl Steps for Real<'_> {
        fn stop(&mut self) -> Result<(), Problem> {
            self.ran.push("stop");
            self.down()
        }
        fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
            self.ran.push("back_up");
            let secrets = self.secrets();
            let backed_up = stack::backup_runtime_database(
                &self.fixture.address,
                &self.fixture.root,
                &secrets,
                to,
            );
            self.down()?;
            backed_up.map_err(Problem::from)
        }
        fn lay_out(&mut self) -> Result<(), Problem> {
            self.ran.push("lay_out");
            deployment::fetch_with(&self.fixture.root, &self.to, &|url| self.fixture.get(url))
                .map_err(Problem::from)
        }
        fn install(&mut self) -> Result<(), Problem> {
            self.ran.push("install");
            let mut references: Vec<String> = deployment::image_variables(&self.fixture.root)
                .map_err(Problem::from)?
                .into_iter()
                .map(|(_, reference)| reference)
                .collect();
            references.push(POSTGRES.into());
            references.sort();
            references.dedup();
            for reference in references {
                pull_metrics::pull_image(&self.fixture.address, &reference, |_| {}, |_| {})?;
            }
            Ok(())
        }
        fn start(&mut self) -> Result<(), Problem> {
            self.ran.push("start");
            let secrets = self.secrets();
            stack::up(&self.fixture.address, &self.fixture.root, false, &secrets).map(|_| ())
        }
        fn restore(&mut self, from: &Path) -> Result<(), Problem> {
            self.ran.push("restore");
            let secrets = self.secrets();
            let restored =
                stack::start_runtime_database(&self.fixture.address, &self.fixture.root, &secrets)
                    .and_then(|()| {
                        stack::restore_runtime_database(
                            &self.fixture.address,
                            &self.fixture.root,
                            &secrets,
                            from,
                        )
                    });
            self.down()?;
            restored.map_err(Problem::from)
        }
    }

    /// Release N installed as Install lays it out and pulls it, started, and used: a conversation
    /// written to its database.
    fn installed_and_used(fixture: &mut Fixture) -> String {
        let server = fixture.publish(N);
        fixture.release(N, &server);
        let mut steps = Real {
            fixture,
            to: N.into(),
            ran: Vec::new(),
        };
        steps.lay_out().unwrap();
        steps.install().unwrap();
        steps.start().unwrap();
        fixture.sql("create table conversations(id int primary key, said text not null)");
        fixture.sql("insert into conversations values (1, 'hello from N')");
        server
    }

    #[test]
    #[ignore = "pushes to a local registry and runs an isolated Compose project on the selected engine"]
    fn an_installation_on_n_is_upgraded_to_the_next_release_with_its_data_and_one_migration() {
        let mut fixture = Fixture::new("moves");
        let previous = installed_and_used(&mut fixture);
        assert_eq!(fixture.sql("select count(*) from fixture_migrations"), "1");
        let next = fixture.publish(NEXT);
        fixture.release(NEXT, &next);
        let own = Own {
            version: NEXT.into(),
            pinned: false,
        };
        assert_eq!(
            due(&fixture.root, &own),
            Some(Move {
                from: N.into(),
                to: NEXT.into()
            })
        );

        let mut steps = Real {
            fixture: &fixture,
            to: NEXT.into(),
            ran: Vec::new(),
        };
        let ran = run(&fixture.root, &mut steps);
        assert!(matches!(ran, Ran::Moved), "{ran:?}");
        assert_eq!(
            steps.ran,
            ["stop", "back_up", "lay_out", "install", "start"]
        );

        assert_eq!(deployment::installed(&fixture.root).unwrap().version, NEXT);
        assert_eq!(due(&fixture.root, &own), None);
        assert!(!interrupted(&fixture.root));
        let running = fixture.running();
        for service in ["agent-computer", "server", "worker"] {
            assert!(
                running.contains(&format!("{service} {next}")),
                "{service} is not running {next}: {running:?}"
            );
        }
        assert!(!running.iter().any(|line| line.contains(&previous)));
        assert_eq!(
            fixture.sql("select said from conversations where id = 1"),
            "hello from N"
        );
        // N's migration once at its install, the next release's once at its start: never twice.
        assert_eq!(
            fixture.sql("select version || '=' || count(*) from fixture_migrations group by version order by version"),
            format!("{N}=1\n{NEXT}=1")
        );
    }

    #[test]
    #[ignore = "pushes to a local registry and runs an isolated Compose project on the selected engine"]
    fn an_upgrade_whose_image_cannot_be_pulled_puts_n_back_with_its_data_and_starts_it() {
        let mut fixture = Fixture::new("kept");
        let previous = installed_and_used(&mut fixture);
        let compose_before = std::fs::read(fixture.root.join("docker-compose.yml")).unwrap();
        let images_before = std::fs::read(deployment::images_path(&fixture.root)).unwrap();
        // Published in the image list, on a registry that is not answering: a stopped registry,
        // or this computer offline. Nothing listens on that port once the listener is dropped.
        let closed = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        fixture.release(
            NEXT,
            &format!("127.0.0.1:{closed}/openbot-upgrade-fixture/never-pushed:{NEXT}"),
        );
        // And the database is in use from outside OpenBot the whole time.
        fixture.connect_from_outside();

        let mut steps = Real {
            fixture: &fixture,
            to: NEXT.into(),
            ran: Vec::new(),
        };
        let ran = run(&fixture.root, &mut steps);
        let Ran::Kept(failed) = ran else {
            panic!("{ran:?}")
        };
        assert!(
            detail(&failed).contains("never-pushed"),
            "the pull is what failed: {failed:?}"
        );
        // Said as a download that failed, never as the engine being down: it answered throughout.
        assert!(failed.said.contains("couldn't download"), "{}", failed.said);
        assert!(!failed.said.contains("container engine"), "{}", failed.said);
        assert_eq!(
            steps.ran,
            ["stop", "back_up", "lay_out", "install", "stop", "restore", "start"]
        );

        // The previous files are back, byte for byte, and nothing is left aside.
        assert_eq!(deployment::installed(&fixture.root).unwrap().version, N);
        assert_eq!(
            std::fs::read(fixture.root.join("docker-compose.yml")).unwrap(),
            compose_before
        );
        assert_eq!(
            std::fs::read(deployment::images_path(&fixture.root)).unwrap(),
            images_before
        );
        assert!(!interrupted(&fixture.root));
        // N is running, with its data, and the next release's migration never ran.
        let running = fixture.running();
        for service in ["agent-computer", "server", "worker"] {
            assert!(
                running.contains(&format!("{service} {previous}")),
                "{service} is not running {previous}: {running:?}"
            );
        }
        assert_eq!(
            fixture.sql("select said from conversations where id = 1"),
            "hello from N"
        );
        assert_eq!(
            fixture.sql("select version || '=' || count(*) from fixture_migrations group by version order by version"),
            // N's install, then N's start again after the restore: its own migration, re-run by
            // Compose's dependency on every `up`, and never the next release's.
            format!("{N}=2")
        );
    }

    /// The state a real Desktop was left in: an upgrade that set the previous version aside, laid
    /// the next one out and then could not put the database back, because a client outside
    /// OpenBot kept sessions open to it. Retry runs Start, which puts the previous version back
    /// (`recover`) and starts it, with that client still connected.
    #[test]
    #[ignore = "pushes to a local registry and runs an isolated Compose project on the selected engine"]
    fn a_previous_version_left_aside_is_put_back_and_started_while_the_database_is_in_use() {
        let mut fixture = Fixture::new("stuck");
        let previous = installed_and_used(&mut fixture);
        let next = fixture.publish(NEXT);
        fixture.release(NEXT, &next);
        fixture.connect_from_outside();
        let mut steps = Real {
            fixture: &fixture,
            to: NEXT.into(),
            ran: Vec::new(),
        };
        // Stopped, backed up, set aside, and the next release laid out, pulled and started: its
        // migration ran. Then the app stopped before it finished.
        steps.stop().unwrap();
        let aside = fixture.root.join(PREVIOUS);
        std::fs::create_dir_all(&aside).unwrap();
        steps.back_up(&aside.join(DUMP)).unwrap();
        keep(&fixture.root).unwrap();
        steps.lay_out().unwrap();
        steps.install().unwrap();
        steps.start().unwrap();
        fixture.sql("insert into conversations values (2, 'written by the next release')");
        assert!(interrupted(&fixture.root));

        steps.ran.clear();
        assert!(recover(&fixture.root, &mut steps).unwrap());
        steps.start().unwrap();
        assert_eq!(steps.ran, ["stop", "restore", "start"]);

        assert!(!interrupted(&fixture.root));
        assert_eq!(deployment::installed(&fixture.root).unwrap().version, N);
        let running = fixture.running();
        for service in ["agent-computer", "server", "worker"] {
            assert!(
                running.contains(&format!("{service} {previous}")),
                "{service} is not running {previous}: {running:?}"
            );
        }
        // The database as it was when the upgrade began: nothing the next release wrote.
        assert_eq!(
            fixture.sql("select string_agg(said, ',' order by id) from conversations"),
            "hello from N"
        );
        assert_eq!(
            fixture.sql("select count(*) from fixture_migrations where version = 'v0.0.2'"),
            "0"
        );
        // And the client outside OpenBot is back on it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while fixture.outside_sessions() < 6 {
            assert!(
                std::time::Instant::now() < deadline,
                "the outside client did not reconnect"
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
}
