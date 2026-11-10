//! Whether the engine is new enough to run OpenBot, and the one place that says what "enough" is.
//!
//! An engine that answers is not an engine that can run OpenBot. A tester on Docker Desktop 4.27.2
//! (Compose v2.24.5) got through setup and then stopped at Start with "Compose config exited with
//! exit status: 15": that Compose rejected the project before it applied profiles. Fixing that one
//! file does not fix the next feature an old Compose lacks, so the version is checked at setup and
//! at every Start, and an engine that is too old is updated for the person:
//!
//! - **Podman** (macOS and Windows): OpenBot's own pinned installer (`install::PODMAN`) is run over
//!   the old one, and OpenBot's own Compose provider is placed in front of an old one. Existing
//!   machines and everything in them stay: a newer client works with machines an older one made on
//!   macOS and Windows (Podman 6.0 release notes), and the installer never touches them.
//! - **Docker Desktop**: the newest signed release is downloaded from Docker, checked, and installed
//!   over the old one with Docker's documented command line (see `docker_desktop_update`).
//!
//! Only when neither can be done for them (a Docker that is not Docker Desktop, an Intel Mac whose
//! Podman OpenBot has no installer for) is the person told one plain step.
//!
//! Linux is left as it is. Its engine comes from the distribution, OpenBot never installs Docker
//! there, and an Ubuntu LTS ships a Compose older than this on purpose.
//!
//! THE MINIMUMS, AND WHY EACH ONE.
//!
//! - Compose 2.27.2: Start runs `compose config --environment` to find the installation's Compose
//!   files whenever it adds one of its own (Podman on a Mac, a picked harness's port). That flag
//!   arrived in Compose v2.27.2 (docker/compose#11891); v2.27.1 answers "unknown flag:
//!   --environment". Measured by running each release's binary against the shipped
//!   `docker-compose.yml` and the desktop's own override files. Earlier still, v2.25.0 and older
//!   reject the project outright when no harness is picked (the exit status 15 above).
//! - Docker Desktop 4.32.0 is the first release that bundles a Compose this new (v2.28.1; 4.31.x
//!   bundles v2.27.1). Docker Desktop's version is only reported: Compose is what is checked,
//!   because newer Docker Desktops can update Compose on its own.
//! - Docker Engine 20.10.0: the oldest engine that understands `host-gateway`, which the Compose
//!   file maps `host.docker.internal` to. Nothing else in the file asks more of the engine.
//! - Podman 6.1.0: OpenBot creates its machine without `--provider`, relying on `applehv` being the
//!   default on Apple silicon, which it is again from 6.1 (5.7 and 6.0 default to libkrun, whose
//!   bind mounts OpenBot cannot use; see `acquire::create_machine`). It is also the release line
//!   OpenBot installs and tests (`install::PODMAN`).

use std::fmt;
use std::time::{Duration, Instant};

use crate::engine::{Address, Engine, StepLine};
use crate::problem::Problem;

/// A release number, `MAJOR.MINOR.PATCH`. Suffixes such as Docker Desktop's `-desktop.1` are not
/// part of it: `2.24.5-desktop.1` is Compose 2.24.5.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// The first `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` in `text`, with or without a leading `v`.
    ///
    /// Found rather than parsed whole, because every tool says its version in a sentence of its
    /// own: "Docker Compose version v2.24.5-desktop.1", "podman version 6.1.1", "5.5.1".
    pub fn find(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            if bytes[start].is_ascii_digit()
                && (start == 0
                    || !bytes[start - 1].is_ascii_alphanumeric()
                    || bytes[start - 1] == b'v')
                && (start == 0 || bytes[start - 1] != b'.')
            {
                let rest = &text[start..];
                let numbers: Vec<&str> = rest
                    .split(|c: char| !(c.is_ascii_digit() || c == '.'))
                    .next()
                    .unwrap_or("")
                    .split('.')
                    .collect();
                if numbers.len() >= 2 && numbers[..2].iter().all(|part| !part.is_empty()) {
                    let number = |index: usize| -> Option<u64> {
                        match numbers.get(index) {
                            Some(part) if !part.is_empty() => part.parse().ok(),
                            _ => Some(0),
                        }
                    };
                    return Some(Self::new(number(0)?, number(1)?, number(2)?));
                }
            }
            start += 1;
        }
        None
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The oldest Compose that runs OpenBot. See the module comment.
pub const COMPOSE: Version = Version::new(2, 27, 2);
/// The oldest Docker Engine that runs OpenBot. See the module comment.
pub const DOCKER_ENGINE: Version = Version::new(20, 10, 0);
/// The oldest Podman OpenBot runs on, on macOS and Windows. See the module comment.
pub const PODMAN: Version = Version::new(6, 1, 0);
/// The first Docker Desktop that bundles `COMPOSE` or newer, for the log.
pub const DOCKER_DESKTOP: Version = Version::new(4, 32, 0);

/// What `docker version` is asked for: the engine's version, and the product that runs it.
///
/// A template rather than `--format json`, because a template has given the same answer on every
/// Docker CLI since 1.x. Docker Desktop names itself in `Platform.Name`, as "Docker Desktop 4.76.0
/// (228118)"; Docker Engine on Linux says "Docker Engine - Community".
pub const DOCKER_VERSION_FORMAT: &str = "{{.Server.Version}}|{{.Server.Platform.Name}}";

/// What was read from the engine. `None` where it did not say.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Readings {
    /// Docker: the engine's (server's) version. Podman: the client's, which is what OpenBot installs.
    pub engine: Option<Version>,
    pub compose: Option<Version>,
    /// The Docker Desktop release running the engine, when it is Docker Desktop.
    pub docker_desktop: Option<Version>,
}

impl Readings {
    /// For the log: every version that was read.
    pub fn said(&self, engine: Engine) -> String {
        let shown = |version: Option<Version>| {
            version.map_or_else(|| "unknown".to_string(), |version| version.to_string())
        };
        let mut said = format!(
            "{} {}, Compose {}",
            engine.binary(),
            shown(self.engine),
            shown(self.compose)
        );
        if let Some(desktop) = self.docker_desktop {
            said.push_str(&format!(", Docker Desktop {desktop}"));
        }
        said
    }
}

/// `docker version --format DOCKER_VERSION_FORMAT` and `docker compose version --short`, read.
pub fn docker_readings(version: &str, compose: &str) -> Readings {
    let line = version
        .lines()
        .map(str::trim)
        .find(|line| line.contains('|'));
    let (engine, platform) = line
        .and_then(|line| line.split_once('|'))
        .unwrap_or(("", ""));
    Readings {
        engine: Version::find(engine),
        compose: compose_version(compose),
        docker_desktop: platform
            .trim()
            .strip_prefix("Docker Desktop")
            .and_then(Version::find),
    }
}

/// `podman --version` and `podman compose version --short`, read.
pub fn podman_readings(version: &str, compose: &str) -> Readings {
    Readings {
        engine: version
            .lines()
            .find(|line| line.trim_start().starts_with("podman"))
            .and_then(Version::find),
        compose: compose_version(compose),
        docker_desktop: None,
    }
}

/// Compose's version from what `compose version` printed on stdout.
///
/// Podman runs an external provider for `podman compose`, and says so in a banner beginning
/// `>>>>`. The banner goes to stderr, but it names the provider's path, which can hold numbers, so
/// it is skipped here as well.
pub fn compose_version(stdout: &str) -> Option<Version> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(">>>>"))
        .find_map(Version::find)
}

/// Read the versions from the engine at `address`.
pub fn read(address: &Address) -> Readings {
    let stdout = |args: &[&str]| {
        address
            .command()
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    };
    let compose = stdout(&["compose", "version", "--short"]);
    match address.engine {
        Engine::Docker => docker_readings(
            &stdout(&["version", "--format", DOCKER_VERSION_FORMAT]),
            &compose,
        ),
        Engine::Podman => podman_readings(&stdout(&["--version"]), &compose),
    }
}

/// What to do about the engine's versions.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    NewEnough,
    /// Run OpenBot's pinned Podman installer over the old one (`podman`), place OpenBot's own
    /// Compose provider (`compose`), or both.
    UpdatePodman {
        podman: bool,
        compose: bool,
    },
    /// Install the newest Docker Desktop over the old one.
    UpdateDockerDesktop,
    /// It is too old and OpenBot cannot update it: the person's one step.
    CannotUpdate(Problem),
}

fn older(version: Option<Version>, minimum: Version) -> bool {
    version.is_some_and(|version| version < minimum)
}

/// What to do, for `engine` with `readings`, on `os` (`std::env::consts::OS`) and `arch` (the
/// machine's, `windows::machine_arch`).
///
/// A version that could not be read is not called old. Reading can fail for reasons that have
/// nothing to do with age, and Start reports an engine that does not answer or has no Compose on
/// its own; an update OpenBot cannot justify is worse than the error it would have prevented.
pub fn decide(engine: Engine, readings: &Readings, os: &str, arch: &str) -> Verdict {
    if os != "macos" && os != "windows" {
        return Verdict::NewEnough;
    }
    let compose_old = older(readings.compose, COMPOSE);
    match engine {
        Engine::Podman => {
            let podman_old = older(readings.engine, PODMAN);
            if podman_old && os == "macos" && arch != "aarch64" {
                // Podman publishes its Mac package for Apple silicon only (see
                // `install::podman_download`), so there is nothing for OpenBot to install here.
                return Verdict::CannotUpdate(Problem::with(
                    "The software OpenBot runs on is too old, and OpenBot can't update it on an \
                     Intel Mac. Update Podman, then start OpenBot again.",
                    format!(
                        "{}; OpenBot needs Podman {PODMAN} or newer, and Podman publishes its Mac \
                         installer for Apple silicon only",
                        readings.said(engine)
                    ),
                ));
            }
            if podman_old || compose_old {
                Verdict::UpdatePodman {
                    podman: podman_old,
                    compose: compose_old,
                }
            } else {
                Verdict::NewEnough
            }
        }
        Engine::Docker => {
            if !compose_old && !older(readings.engine, DOCKER_ENGINE) {
                return Verdict::NewEnough;
            }
            if readings.docker_desktop.is_some() {
                return Verdict::UpdateDockerDesktop;
            }
            Verdict::CannotUpdate(Problem::with(
                "Docker on this computer is too old to run OpenBot. Update Docker, then start \
                 OpenBot again.",
                format!(
                    "{}; OpenBot needs Compose {COMPOSE} or newer and Docker Engine \
                     {DOCKER_ENGINE} or newer, and only Docker Desktop can be updated for you",
                    readings.said(engine)
                ),
            ))
        }
    }
}

/// The updates `ensure` can make, so the sequence can be tested without changing a machine.
pub trait Updates {
    fn read(&mut self) -> Readings;
    fn update_podman(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem>;
    fn place_compose(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem>;
    fn update_docker_desktop(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem>;
    /// The engine answers on the connection OpenBot uses, asked until `within` is up, or why not.
    /// For a Podman machine that includes the Docker API Compose uses (`acquire::engine_answers`).
    fn answers(&mut self, within: Duration) -> Result<(), String>;
    /// Stop and start the Podman machine behind that connection, with what was running in it.
    fn restart(&mut self) -> Result<(), String>;
}

/// How long an engine has to answer once it has been updated or started again. `machine start`
/// returns once the machine's API pipe or socket is there, so this is a bound, not a wait.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(60);

/// How `ensure` ended, when it did not fail.
#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    NewEnough(Readings),
    /// New enough, and its machine had to be stopped and started before it answered.
    Restarted(Readings),
    /// What was updated, for the step row, and the versions now.
    Updated {
        said: String,
        now: Readings,
    },
}

/// The row's line while OpenBot stops and starts a Podman machine whose API does not answer.
pub fn restarting_line() -> StepLine {
    StepLine::here("Restarting the software OpenBot runs on.")
}

/**
The engine new enough to run OpenBot, and answering: checked, updated when it is not, and checked
again.

The second check is the point. An update that reported success and left the old version in use (a
second Podman earlier on PATH, a Docker Desktop that did not restart) would otherwise reach Compose
and fail there, with the error this exists to prevent. So is the last one, that the engine answers:
a Podman update read 6.1.1 and said "updated" on a live Windows run while the person's machine had
lost its Docker API, and every pull after it failed (see `answering`).
*/
pub fn ensure(
    engine: Engine,
    os: &str,
    arch: &str,
    updates: &mut dyn Updates,
    progress: &mut dyn FnMut(StepLine),
) -> Result<Checked, Problem> {
    let before = updates.read();
    let said = match decide(engine, &before, os, arch) {
        Verdict::NewEnough => {
            return Ok(match answering_now(engine, os, updates, progress)? {
                false => Checked::NewEnough(before),
                true => Checked::Restarted(before),
            });
        }
        Verdict::CannotUpdate(problem) => return Err(problem),
        Verdict::UpdatePodman { podman, compose } => {
            log::info!(
                "[engine] {} is too old for OpenBot (Podman {PODMAN}, Compose {COMPOSE}); updating",
                before.said(engine)
            );
            let mut compose_old = compose;
            if podman {
                updates.update_podman(progress)?;
                // The installer may have brought a Compose of its own, or found ours.
                compose_old = older(updates.read().compose, COMPOSE);
            }
            if compose_old {
                updates.place_compose(progress)?;
            }
            "OpenBot updated the software it runs on."
        }
        Verdict::UpdateDockerDesktop => {
            log::info!(
                "[engine] {} is too old for OpenBot (Compose {COMPOSE}, first bundled by Docker \
                 Desktop {DOCKER_DESKTOP}); updating Docker Desktop",
                before.said(engine)
            );
            updates.update_docker_desktop(progress)?;
            "OpenBot updated Docker."
        }
    };
    let now = updates.read();
    if decide(engine, &now, os, arch) != Verdict::NewEnough {
        return Err(still_too_old(engine, &before, &now));
    }
    answering(engine, true, updates, progress)?;
    log::info!(
        "[engine] updated: {} (was {})",
        now.said(engine),
        before.said(engine)
    );
    Ok(Checked::Updated {
        said: said.to_string(),
        now,
    })
}

/**
The engine answers, its machine stopped and started once when it does not. Whether it was.

Asked at every check on a Mac or a PC that runs Podman, not only after an update. A Podman machine
can answer `podman` over SSH while the Docker API Compose uses has gone (see `acquire`), and an
update that left it so read as new enough on every later check: a Try again, or a Quit and Install
again, failed on the same missing pipe until the person restarted their machine themselves. Docker
answers through its API already, and is asked again only after it was updated.

Asked once without waiting when nothing was updated, so a healthy engine costs one question. Only
the machine behind OpenBot's own connection is restarted, and only once: an engine that still does not
answer is the person's failure to see, with Try again, which runs this again.
*/
fn answering(
    engine: Engine,
    updated: bool,
    updates: &mut dyn Updates,
    progress: &mut dyn FnMut(StepLine),
) -> Result<bool, Problem> {
    let first = match updates.answers(if updated {
        ANSWER_WITHIN
    } else {
        Duration::ZERO
    }) {
        Ok(()) => return Ok(false),
        Err(why) => why,
    };
    if engine == Engine::Docker {
        return Err(not_answering(engine, updated, first));
    }
    log::warn!("[engine] the engine does not answer ({first}); stopping and starting its machine");
    progress(restarting_line().logged(format!(
        "The Podman machine does not answer ({first}); podman machine stop, then start."
    )));
    if let Err(error) = updates.restart() {
        return Err(not_answering(
            engine,
            updated,
            format!("{first}; restarting its machine: {error}"),
        ));
    }
    updates
        .answers(ANSWER_WITHIN)
        .map(|()| true)
        .map_err(|again| {
            not_answering(
                engine,
                updated,
                format!("{first}; after its machine was restarted: {again}"),
            )
        })
}

/// `answering`, where nothing was updated: at every check (`ensure`), and when OpenBot's back end is
/// about to be asked (`wake_engine`), whose own check says only that Docker is unavailable. Only a
/// Podman machine on macOS or Windows is asked. Whether it was restarted.
pub fn answering_now(
    engine: Engine,
    os: &str,
    updates: &mut dyn Updates,
    progress: &mut dyn FnMut(StepLine),
) -> Result<bool, Problem> {
    if engine != Engine::Podman || (os != "macos" && os != "windows") {
        return Ok(false);
    }
    answering(engine, false, updates, progress)
}

fn not_answering(engine: Engine, updated: bool, detail: String) -> Problem {
    let said = match (engine, updated) {
        (Engine::Podman, true) => "OpenBot updated Podman, but Podman isn't answering. Try again.",
        (Engine::Docker, true) => "OpenBot updated Docker, but Docker isn't answering. Try again.",
        (_, false) => "The software OpenBot runs on isn't answering. Try again.",
    };
    Problem::with(said, detail)
}

fn still_too_old(engine: Engine, before: &Readings, now: &Readings) -> Problem {
    let detail = format!(
        "after the update: {} (before: {}); OpenBot needs Compose {COMPOSE}{}",
        now.said(engine),
        before.said(engine),
        match engine {
            Engine::Podman => format!(" and Podman {PODMAN}"),
            Engine::Docker => format!(" and Docker Engine {DOCKER_ENGINE}"),
        }
    );
    match engine {
        Engine::Podman => Problem::with(
            "OpenBot updated the software it runs on, but an older copy is still in use. Remove \
             the older Podman, then start OpenBot again.",
            detail,
        ),
        Engine::Docker => Problem::with(
            "OpenBot updated Docker, but Docker is still running the old version. Quit Docker \
             Desktop and open it again, then start OpenBot again.",
            detail,
        ),
    }
}

/// `Updates` on this machine, for the engine at `address`.
pub struct OnThisMachine<'a> {
    pub address: Address,
    /// The app's cache directory, where installers are downloaded (`acquire::download_dir`).
    pub cache: std::path::PathBuf,
    /// OpenBot's window to the front again, after another app's window or a system prompt.
    pub back: &'a dyn Fn(),
    /// Stop or Quit while a step waits for the person.
    pub cancelled: &'a dyn Fn() -> bool,
}

impl Updates for OnThisMachine<'_> {
    fn read(&mut self) -> Readings {
        read(&self.address)
    }

    fn update_podman(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
        crate::install::update_podman(&self.cache, progress, self.back, self.cancelled)
    }

    fn place_compose(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
        progress(
            StepLine::here(
                "Part of the software OpenBot runs on is too old, so OpenBot is updating it.",
            )
            .logged(format!(
                "Compose is older than {COMPOSE}; placing Compose {} in front of it.",
                crate::install::COMPOSE
            )),
        );
        crate::install::place_newer_compose(&crate::acquire::download_dir(&self.cache)).map(|_| ())
    }

    fn update_docker_desktop(&mut self, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
        crate::docker_desktop_update::update(&self.cache, progress, self.back, self.cancelled)
    }

    fn answers(&mut self, within: Duration) -> Result<(), String> {
        let until = Instant::now() + within;
        loop {
            let why = match crate::acquire::engine_answers(&self.address) {
                Ok(()) => return Ok(()),
                Err(why) => why,
            };
            if Instant::now() >= until || (self.cancelled)() {
                return Err(why);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    fn restart(&mut self) -> Result<(), String> {
        // By the name it is reached by, the default connection's included (`machine_reached`).
        let Some(machine) = crate::acquire::machine_reached(&self.address) else {
            return Err("no Podman machine to restart".into());
        };
        let containers = crate::acquire::running_containers(&machine);
        if let Err(error) = crate::acquire::stop_machine_named(&machine) {
            log::info!("[engine] podman machine stop {machine}: {error}");
        }
        crate::acquire::start_machine_named(&machine, &containers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /*
     * Every CLI output below is real, captured from the release it names:
     *
     * - Docker Desktop 4.27.2 (build 137060, the tester's): `docker-compose version` and `version
     *   --short` from the Compose plugin inside the official arm64 Docker.dmg (sha256
     *   05df5baf...ef8a4, signed by Docker's team 9BNSXJN65R). Its engine is 25.0.2 (4.27.1's
     *   upgrade, unchanged in 4.27.2); `Platform.Name` has the shape captured below.
     * - Docker Desktop 4.76.0 (build 228118): `docker version` and `docker compose version` on the
     *   Mac this was written on.
     * - Compose v2.27.1, v2.27.2: the official darwin-aarch64 release binaries, checksums verified.
     * - Podman 6.1.1: `podman --version` on the same Mac. Every Podman prints this sentence
     *   (`podman version X.Y.Z`, Cobra's version template); 5.8.9 is the release the repo's Linux
     *   measurements used.
     * - Docker Engine on Linux names itself "Docker Engine - Community".
     */
    const DESKTOP_4_27_2_VERSION: &str = "25.0.2|Docker Desktop 4.27.2 (137060)\n";
    const DESKTOP_4_27_2_COMPOSE_SHORT: &str = "2.24.5-desktop.1\n";
    const DESKTOP_4_27_2_COMPOSE_LONG: &str = "Docker Compose version v2.24.5-desktop.1\n";
    const DESKTOP_4_76_VERSION: &str = "29.5.2|Docker Desktop 4.76.0 (228118)\n";
    const DESKTOP_4_76_COMPOSE_SHORT: &str = "5.1.4\n";
    const DESKTOP_4_76_COMPOSE_LONG: &str = "Docker Compose version v5.1.4\n";
    const COMPOSE_2_27_1_SHORT: &str = "2.27.1\n";
    const COMPOSE_2_27_2_SHORT: &str = "2.27.2\n";
    const PODMAN_6_1_1: &str = "podman version 6.1.1\n";
    const PODMAN_5_8_9: &str = "podman version 5.8.9\n";
    const COMPOSE_5_5_1_SHORT: &str = "5.5.1\n";
    const LINUX_ENGINE_VERSION: &str = "27.5.1|Docker Engine - Community\n";

    fn docker_4_27_2() -> Readings {
        docker_readings(DESKTOP_4_27_2_VERSION, DESKTOP_4_27_2_COMPOSE_SHORT)
    }

    fn docker_4_76() -> Readings {
        docker_readings(DESKTOP_4_76_VERSION, DESKTOP_4_76_COMPOSE_SHORT)
    }

    #[test]
    fn reads_versions_the_way_each_release_says_them() {
        assert_eq!(
            docker_4_27_2(),
            Readings {
                engine: Some(Version::new(25, 0, 2)),
                compose: Some(Version::new(2, 24, 5)),
                docker_desktop: Some(Version::new(4, 27, 2)),
            }
        );
        assert_eq!(
            docker_4_76(),
            Readings {
                engine: Some(Version::new(29, 5, 2)),
                compose: Some(Version::new(5, 1, 4)),
                docker_desktop: Some(Version::new(4, 76, 0)),
            }
        );
        // The long form says the same version as the short one.
        assert_eq!(
            compose_version(DESKTOP_4_27_2_COMPOSE_LONG),
            compose_version(DESKTOP_4_27_2_COMPOSE_SHORT)
        );
        assert_eq!(
            compose_version(DESKTOP_4_76_COMPOSE_LONG),
            Some(Version::new(5, 1, 4))
        );
        assert_eq!(
            podman_readings(PODMAN_6_1_1, COMPOSE_5_5_1_SHORT),
            Readings {
                engine: Some(Version::new(6, 1, 1)),
                compose: Some(Version::new(5, 5, 1)),
                docker_desktop: None,
            }
        );
        // Docker Engine on Linux is not Docker Desktop.
        assert_eq!(
            docker_readings(LINUX_ENGINE_VERSION, "2.24.6\n").docker_desktop,
            None
        );
        // Podman's banner names the provider's path; the version is the provider's own line.
        assert_eq!(
            compose_version(
                ">>>> Executing external compose provider \"/Users/a/Library/Caches/ai.copilotkit.openbot.desktop/openbot-engine/bin/docker-compose\". Please see podman-compose(1) for how to disable this message. <<<<\n5.5.1\n"
            ),
            Some(Version::new(5, 5, 1))
        );
        // Nothing said is nothing known.
        assert_eq!(docker_readings("", ""), Readings::default());
        assert_eq!(Version::find("no version here"), None);
    }

    #[test]
    fn a_suffix_is_not_part_of_the_version() {
        // Under semver rules 2.27.2-desktop.1 would sort before 2.27.2; it is that release.
        assert!(Version::find("v2.27.2-desktop.1").unwrap() >= COMPOSE);
        assert!(Version::find("2.27.1").unwrap() < COMPOSE);
        assert!(Version::find("2.100.0").unwrap() > COMPOSE);
        assert!(Version::find("5.1.4").unwrap() > COMPOSE);
        assert_eq!(Version::find("6.1"), Some(Version::new(6, 1, 0)));
    }

    #[test]
    fn the_minimums_are_where_the_measurements_put_them() {
        // `config --environment` arrived in Compose v2.27.2: v2.27.1 is too old, v2.27.2 is not.
        assert!(compose_version(COMPOSE_2_27_1_SHORT).unwrap() < COMPOSE);
        assert!(compose_version(COMPOSE_2_27_2_SHORT).unwrap() >= COMPOSE);
        // What OpenBot itself installs is always new enough.
        assert!(Version::find(crate::install::PODMAN).unwrap() >= PODMAN);
        assert!(Version::find(crate::install::COMPOSE).unwrap() >= COMPOSE);
    }

    /// The decision table, with each engine as its release says it.
    #[test]
    fn decides_what_to_do_for_each_engine() {
        let podman = |version: &str, compose: &str| podman_readings(version, compose);
        let cases: Vec<(&str, Engine, Readings, &str, &str, Verdict)> = vec![
            // The tester's Docker Desktop, on a Mac and on a PC: updated for them.
            (
                "4.27.2 mac",
                Engine::Docker,
                docker_4_27_2(),
                "macos",
                "aarch64",
                Verdict::UpdateDockerDesktop,
            ),
            (
                "4.27.2 intel mac",
                Engine::Docker,
                docker_4_27_2(),
                "macos",
                "x86_64",
                Verdict::UpdateDockerDesktop,
            ),
            (
                "4.27.2 windows",
                Engine::Docker,
                docker_4_27_2(),
                "windows",
                "x86_64",
                Verdict::UpdateDockerDesktop,
            ),
            (
                "4.76 mac",
                Engine::Docker,
                docker_4_76(),
                "macos",
                "aarch64",
                Verdict::NewEnough,
            ),
            (
                "4.76 windows",
                Engine::Docker,
                docker_4_76(),
                "windows",
                "aarch64",
                Verdict::NewEnough,
            ),
            (
                "compose 2.27.2",
                Engine::Docker,
                docker_readings(DESKTOP_4_27_2_VERSION, COMPOSE_2_27_2_SHORT),
                "macos",
                "aarch64",
                Verdict::NewEnough,
            ),
            // Podman OpenBot installed, and an older one somebody brought.
            (
                "podman 6.1.1",
                Engine::Podman,
                podman(PODMAN_6_1_1, COMPOSE_5_5_1_SHORT),
                "macos",
                "aarch64",
                Verdict::NewEnough,
            ),
            (
                "podman 5.8.9",
                Engine::Podman,
                podman(PODMAN_5_8_9, COMPOSE_5_5_1_SHORT),
                "windows",
                "x86_64",
                Verdict::UpdatePodman {
                    podman: true,
                    compose: false,
                },
            ),
            (
                "podman with old compose",
                Engine::Podman,
                podman(PODMAN_6_1_1, DESKTOP_4_27_2_COMPOSE_SHORT),
                "macos",
                "aarch64",
                Verdict::UpdatePodman {
                    podman: false,
                    compose: true,
                },
            ),
            (
                "both old",
                Engine::Podman,
                podman(PODMAN_5_8_9, DESKTOP_4_27_2_COMPOSE_SHORT),
                "macos",
                "aarch64",
                Verdict::UpdatePodman {
                    podman: true,
                    compose: true,
                },
            ),
            // Compose alone can still be placed on an Intel Mac.
            (
                "intel compose only",
                Engine::Podman,
                podman(PODMAN_6_1_1, DESKTOP_4_27_2_COMPOSE_SHORT),
                "macos",
                "x86_64",
                Verdict::UpdatePodman {
                    podman: false,
                    compose: true,
                },
            ),
            // Linux is left as it is.
            (
                "linux docker",
                Engine::Docker,
                docker_readings(LINUX_ENGINE_VERSION, "2.24.6\n"),
                "linux",
                "x86_64",
                Verdict::NewEnough,
            ),
            (
                "linux podman",
                Engine::Podman,
                podman("podman version 4.9.3\n", "2.24.6\n"),
                "linux",
                "x86_64",
                Verdict::NewEnough,
            ),
            // Unknown is not old.
            (
                "unread",
                Engine::Docker,
                Readings::default(),
                "macos",
                "aarch64",
                Verdict::NewEnough,
            ),
        ];
        for (name, engine, readings, os, arch, expected) in cases {
            assert_eq!(decide(engine, &readings, os, arch), expected, "{name}");
        }

        // Too old, and nothing OpenBot can update: one plain step each.
        let Verdict::CannotUpdate(intel) = decide(
            Engine::Podman,
            &podman(PODMAN_5_8_9, COMPOSE_5_5_1_SHORT),
            "macos",
            "x86_64",
        ) else {
            panic!("an Intel Mac's old Podman cannot be updated for them");
        };
        assert!(intel.said.contains("Update Podman"));
        let Verdict::CannotUpdate(other_docker) = decide(
            Engine::Docker,
            &Readings {
                engine: Some(Version::new(25, 0, 2)),
                compose: Some(Version::new(2, 24, 5)),
                docker_desktop: None,
            },
            "macos",
            "aarch64",
        ) else {
            panic!("a Docker that is not Docker Desktop cannot be updated for them");
        };
        assert_eq!(
            other_docker.said,
            "Docker on this computer is too old to run OpenBot. Update Docker, then start OpenBot \
             again."
        );
    }

    /// What a Docker client says when a Podman machine's API pipe has gone: Rust's own words for
    /// opening a pipe that is not there, and the address `acquire::ping_api` names.
    const PIPE_GONE: &str =
        "npipe:////./pipe/podman-machine-default: The system cannot find the file specified. (os error 2)";

    /// A machine whose engine says each of `readings` in turn, recording what was done to it.
    struct Fake {
        readings: VecDeque<Readings>,
        done: Vec<&'static str>,
        fails: Option<&'static str>,
        /// Whether its API answers now.
        api: bool,
        /// Whether its API answers after its machine is stopped and started.
        api_after_restart: bool,
        /// What a Podman update does to the API of the machine it finds running: the MSI took the
        /// person's `win-sshproxy` with it on a live Windows run.
        update_takes_the_api: bool,
    }

    impl Fake {
        fn new(readings: Vec<Readings>) -> Self {
            Self {
                readings: readings.into(),
                done: Vec::new(),
                fails: None,
                api: true,
                api_after_restart: true,
                update_takes_the_api: false,
            }
        }

        fn step(&mut self, name: &'static str) -> Result<(), Problem> {
            self.done.push(name);
            if self.fails == Some(name) {
                return Err(Problem::with("It stopped.", name));
            }
            Ok(())
        }
    }

    impl Updates for Fake {
        fn read(&mut self) -> Readings {
            self.done.push("read");
            // The last reading stays: an engine keeps saying what it said.
            if self.readings.len() > 1 {
                self.readings.pop_front().unwrap()
            } else {
                self.readings.front().cloned().unwrap_or_default()
            }
        }
        fn update_podman(&mut self, _: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
            if self.update_takes_the_api {
                self.api = false;
            }
            self.step("update podman")
        }
        fn place_compose(&mut self, _: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
            self.step("place compose")
        }
        fn update_docker_desktop(&mut self, _: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
            self.step("update docker desktop")
        }
        fn answers(&mut self, _: Duration) -> Result<(), String> {
            self.done.push("answers");
            if self.api {
                Ok(())
            } else {
                Err(PIPE_GONE.into())
            }
        }
        fn restart(&mut self) -> Result<(), String> {
            self.done.push("restart");
            self.api = self.api_after_restart;
            Ok(())
        }
    }

    fn run(engine: Engine, fake: &mut Fake) -> Result<Checked, Problem> {
        ensure(engine, "macos", "aarch64", fake, &mut |_| {})
    }

    #[test]
    fn a_new_enough_engine_is_left_alone() {
        let mut fake = Fake::new(vec![docker_4_76()]);
        assert_eq!(
            run(Engine::Docker, &mut fake).unwrap(),
            Checked::NewEnough(docker_4_76())
        );
        assert_eq!(fake.done, ["read"]);
    }

    /// The tester's machine: Docker Desktop 4.27.2 is updated, then checked again.
    #[test]
    fn an_old_docker_desktop_is_updated_and_checked_again() {
        let mut fake = Fake::new(vec![docker_4_27_2(), docker_4_76()]);
        let Checked::Updated { said, now } = run(Engine::Docker, &mut fake).unwrap() else {
            panic!("Docker Desktop 4.27.2 is updated");
        };
        assert_eq!(said, "OpenBot updated Docker.");
        assert_eq!(now, docker_4_76());
        assert_eq!(
            fake.done,
            ["read", "update docker desktop", "read", "answers"]
        );
    }

    #[test]
    fn an_update_that_left_the_old_version_running_says_so() {
        let mut fake = Fake::new(vec![docker_4_27_2()]);
        let problem = run(Engine::Docker, &mut fake).unwrap_err();
        assert!(problem.said.starts_with("OpenBot updated Docker, but"));
        assert!(problem.detail.unwrap().contains("Compose 2.24.5"));
    }

    #[test]
    fn a_failed_update_is_the_failure() {
        let mut fake = Fake::new(vec![docker_4_27_2()]);
        fake.fails = Some("update docker desktop");
        let problem = run(Engine::Docker, &mut fake).unwrap_err();
        assert_eq!(problem.detail.as_deref(), Some("update docker desktop"));
        assert_eq!(fake.done, ["read", "update docker desktop"]);
    }

    #[test]
    fn an_old_podman_is_reinstalled_and_an_old_compose_replaced() {
        let old = podman_readings(PODMAN_5_8_9, DESKTOP_4_27_2_COMPOSE_SHORT);
        let podman_new = podman_readings(PODMAN_6_1_1, DESKTOP_4_27_2_COMPOSE_SHORT);
        let all_new = podman_readings(PODMAN_6_1_1, COMPOSE_5_5_1_SHORT);
        let mut fake = Fake::new(vec![old, podman_new, all_new.clone()]);
        let Checked::Updated { said, now } = run(Engine::Podman, &mut fake).unwrap() else {
            panic!("Podman is updated");
        };
        assert_eq!(said, "OpenBot updated the software it runs on.");
        assert_eq!(now, all_new);
        assert_eq!(
            fake.done,
            [
                "read",
                "update podman",
                "read",
                "place compose",
                "read",
                "answers"
            ]
        );
    }

    #[test]
    fn a_podman_update_that_brought_a_new_compose_places_none() {
        let old = podman_readings(PODMAN_5_8_9, DESKTOP_4_27_2_COMPOSE_SHORT);
        let all_new = podman_readings(PODMAN_6_1_1, COMPOSE_5_5_1_SHORT);
        let mut fake = Fake::new(vec![old, all_new]);
        run(Engine::Podman, &mut fake).unwrap();
        assert_eq!(
            fake.done,
            ["read", "update podman", "read", "read", "answers"]
        );
    }

    #[test]
    fn a_podman_still_old_after_its_update_names_the_older_copy() {
        let old = podman_readings(PODMAN_5_8_9, COMPOSE_5_5_1_SHORT);
        let mut fake = Fake::new(vec![old]);
        let problem = run(Engine::Podman, &mut fake).unwrap_err();
        assert!(problem.said.contains("an older copy is still in use"));
    }

    fn podman_5_8_9() -> Readings {
        podman_readings(PODMAN_5_8_9, COMPOSE_5_5_1_SHORT)
    }

    fn podman_6_1_1() -> Readings {
        podman_readings(PODMAN_6_1_1, COMPOSE_5_5_1_SHORT)
    }

    fn on_windows(fake: &mut Fake, said: &mut Vec<String>) -> Result<Checked, Problem> {
        ensure(Engine::Podman, "windows", "x86_64", fake, &mut |line| {
            said.push(line.said)
        })
    }

    /// The live Windows run: Podman 5.8.9 updated to 6.1.1, the person's machine's API pipe gone
    /// with it. The update brings it back and the check passes; only then is it "updated".
    #[test]
    fn a_podman_update_is_updated_only_once_the_engine_answers() {
        let mut fake = Fake::new(vec![podman_5_8_9(), podman_6_1_1()]);
        fake.update_takes_the_api = true;
        let mut said = Vec::new();
        let Checked::Updated { said: row, now } = on_windows(&mut fake, &mut said).unwrap() else {
            panic!("Podman is updated, and answers");
        };
        assert_eq!(row, "OpenBot updated the software it runs on.");
        assert_eq!(now, podman_6_1_1());
        assert_eq!(
            fake.done,
            [
                "read",
                "update podman",
                "read",
                "read",
                "answers",
                "restart",
                "answers"
            ]
        );
        assert_eq!(said, ["Restarting the software OpenBot runs on."]);
    }

    /// An engine that does not answer after its update is a failure, with Try again, and never
    /// "updated", whatever version it reads.
    #[test]
    fn a_podman_update_whose_engine_does_not_answer_fails_with_try_again() {
        let mut fake = Fake::new(vec![podman_5_8_9(), podman_6_1_1()]);
        fake.update_takes_the_api = true;
        fake.api_after_restart = false;
        let problem = on_windows(&mut fake, &mut Vec::new()).unwrap_err();
        assert_eq!(
            problem.said,
            "OpenBot updated Podman, but Podman isn't answering. Try again."
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(PIPE_GONE), "{detail}");
        assert!(
            detail.contains("after its machine was restarted"),
            "{detail}"
        );
        // Restarted once, not round in a loop.
        assert_eq!(
            fake.done.iter().filter(|done| **done == "restart").count(),
            1
        );
        // The same for Docker Desktop: no "updated" while Docker does not answer.
        let mut docker = Fake::new(vec![docker_4_27_2(), docker_4_76()]);
        docker.api = false;
        let problem = run(Engine::Docker, &mut docker).unwrap_err();
        assert_eq!(
            problem.said,
            "OpenBot updated Docker, but Docker isn't answering. Try again."
        );
        assert!(!docker.done.contains(&"restart"));
    }

    /// Quit and Install again, or Try again, after the update: Podman reads 6.1.1 and is new
    /// enough, and its machine still has no API. It is stopped and started once, then answers.
    #[test]
    fn a_running_machine_whose_api_has_gone_is_restarted_once_then_answers() {
        let mut fake = Fake::new(vec![podman_6_1_1()]);
        fake.api = false;
        let mut said = Vec::new();
        assert_eq!(
            on_windows(&mut fake, &mut said).unwrap(),
            Checked::Restarted(podman_6_1_1())
        );
        assert_eq!(fake.done, ["read", "answers", "restart", "answers"]);
        assert_eq!(said, ["Restarting the software OpenBot runs on."]);

        // The same before the back end is asked on a relaunch, where no versions are read.
        let mut fake = Fake::new(vec![podman_6_1_1()]);
        fake.api = false;
        assert!(answering_now(Engine::Podman, "macos", &mut fake, &mut |_| {}).unwrap());
        assert_eq!(fake.done, ["answers", "restart", "answers"]);

        // One that still does not answer is the failure, with Try again, which runs all this again.
        let mut fake = Fake::new(vec![podman_6_1_1()]);
        fake.api = false;
        fake.api_after_restart = false;
        let problem = on_windows(&mut fake, &mut Vec::new()).unwrap_err();
        assert_eq!(
            problem.said,
            "The software OpenBot runs on isn't answering. Try again."
        );
        assert_eq!(fake.done, ["read", "answers", "restart", "answers"]);
    }

    /// A machine that answers is asked once and left alone. Docker answered through its API to be
    /// found, and Linux runs no machine, so neither is asked again.
    #[test]
    fn an_engine_that_answers_is_asked_once_and_left_alone() {
        let mut fake = Fake::new(vec![podman_6_1_1()]);
        let mut said = Vec::new();
        assert_eq!(
            on_windows(&mut fake, &mut said).unwrap(),
            Checked::NewEnough(podman_6_1_1())
        );
        assert_eq!(fake.done, ["read", "answers"]);
        assert!(said.is_empty());

        let mut fake = Fake::new(vec![podman_6_1_1()]);
        fake.api = false;
        ensure(Engine::Podman, "linux", "x86_64", &mut fake, &mut |_| {}).unwrap();
        assert_eq!(fake.done, ["read"]);
        let mut fake = Fake::new(vec![docker_4_76()]);
        fake.api = false;
        run(Engine::Docker, &mut fake).unwrap();
        assert_eq!(fake.done, ["read"]);
    }

    #[test]
    fn what_cannot_be_updated_is_one_plain_step_and_nothing_is_changed() {
        let mut fake = Fake::new(vec![podman_readings(PODMAN_5_8_9, COMPOSE_5_5_1_SHORT)]);
        let problem =
            ensure(Engine::Podman, "macos", "x86_64", &mut fake, &mut |_| {}).unwrap_err();
        assert!(problem.said.ends_with("then start OpenBot again."));
        assert_eq!(fake.done, ["read"]);
    }
}
