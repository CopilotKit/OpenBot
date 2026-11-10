/*!
Setup that looks stuck, and a setup window that stopped answering: what the desktop says of them in
its usage data (`oss.desktop.setup_stalled`, `oss.desktop.ui_stalled`) and in its log. A hang is not
a failure, so `setup_failed` never says it.

STEPS THAT RUN LONG (`StepWatch`). The Start, update and setup journeys measure how long each step
typically takes: a first setup and an update of the back end on Windows D30 (`SETUP`, `UPDATE`),
OpenBot's own start (`OPEN`) in desktop/src/journey.ts, and OpenBot updating itself (`RELEASE`) in
StartJourney.tsx. `journeyTimings.json` beside them holds the same numbers for this side, and
journeyTimings.test.ts fails when the two differ. A step that runs three times as long as it
typically takes, and two minutes over at least (`limit`), is said once. If it then finishes,
nothing more is said; if it fails, `setup_failed` says so.

Downloads are not timed as steps. The journeys measure a download by its bytes rather than by the
step it holds up, and a download that stops moving fails on its own (`local_images::Limits::stall`,
the CLI's own pull limit). So the steps inside a plan's download stretch, and OpenBot's own download
rows, are not timed, and a download that is moving restarts the clock of the step it holds up.

THE WINDOW (`UiWatch`). On Windows a setup window froze for minutes: the native side kept working
and sending its progress, and the page took none of it until a click or Alt+Tab. The page sends a
heartbeat every few seconds while its setup, start or update screens show, and again as soon as a
progress event reaches it, carrying the highest progress number it has taken. Progress the page has
not taken for over 30 seconds, while the window is on screen (shown, not minimised, and on macOS
not covered), is a stall. It is said once, with its length, when the page catches up, the window
leaves the screen, the page is replaced, or OpenBot quits.

Neither watch reads a clock: every call is given the time, so the rules are tested second by second.
*/

use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::telemetry::{FailingStep, StallPart, StallStep};

/// The journeys' measured timings, mirrored from desktop/src (`journeyTimings.test.ts`).
const TIMINGS: &str = include_str!("../../src/journeyTimings.json");

/// OpenBot's own download, as start rows: "Downloading OpenBot." (`plain_row`).
const START_DOWNLOADS: [&str; 2] = ["deployment", "images"];

/// The seconds a step that typically takes `typical` may run before it is said: three times as
/// long, and two minutes over at least.
pub fn limit(typical: u64) -> u64 {
    typical.saturating_mul(3).max(typical.saturating_add(120))
}

/// One step of a journey, in its order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    /// What the native side calls it: the CLI's step, the setup row, or the release row's line.
    pub key: String,
    /// What usage data calls it: `dependencies_wait`, `carry_over`, `backing_up`.
    pub name: String,
    /// Seconds it typically takes.
    pub typical: u64,
    /// False for a download, which is measured by its bytes.
    pub timed: bool,
}

#[derive(Default)]
pub struct Plans {
    setup: Vec<Step>,
    update: Vec<Step>,
    start: Vec<Step>,
    release: Vec<Step>,
}

#[derive(Deserialize)]
struct Mirror {
    setup: Ends,
    update: Ends,
    start: Ends,
    release: Begins,
}

/// Seconds into the run by which each step typically finished, in order.
#[derive(Deserialize)]
struct Ends {
    ends: Vec<(String, u64)>,
    #[serde(default)]
    download: Option<(u64, u64)>,
}

/// Seconds into the run at which each step typically begins, by the line its row says then.
#[derive(Deserialize)]
struct Begins {
    begins: Vec<(String, String, u64)>,
    length: u64,
    download: Option<(u64, u64)>,
}

fn snake(key: &str) -> String {
    key.replace('-', "_")
}

/// Steps from when each ends: each takes from the one before it ended to when it ends.
fn by_ends(plan: &Ends, untimed: impl Fn(&str, u64) -> bool) -> Vec<Step> {
    let mut before = 0;
    plan.ends
        .iter()
        .map(|(key, end)| {
            let typical = end.saturating_sub(before);
            before = *end;
            Step {
                key: key.clone(),
                name: snake(key),
                typical,
                timed: !untimed(key, *end),
            }
        })
        .collect()
}

impl Plans {
    fn parse(json: &str) -> Result<Self, serde_json::Error> {
        let mirror: Mirror = serde_json::from_str(json)?;
        let in_download = |download: Option<(u64, u64)>| {
            move |_: &str, end: u64| download.is_some_and(|(from, to)| end > from && end <= to)
        };
        let begins = &mirror.release.begins;
        let release = begins
            .iter()
            .enumerate()
            .map(|(at, (name, line, begin))| {
                let next = begins
                    .get(at + 1)
                    .map_or(mirror.release.length, |(_, _, next)| *next);
                Step {
                    key: line.clone(),
                    name: name.clone(),
                    typical: next.saturating_sub(*begin),
                    timed: !mirror
                        .release
                        .download
                        .is_some_and(|(from, to)| *begin >= from && next <= to),
                }
            })
            .collect();
        Ok(Self {
            setup: by_ends(&mirror.setup, in_download(mirror.setup.download)),
            update: by_ends(&mirror.update, in_download(mirror.update.download)),
            start: by_ends(&mirror.start, |key, _| START_DOWNLOADS.contains(&key)),
            release,
        })
    }

    pub fn of(&self, part: StallPart) -> &[Step] {
        match part {
            StallPart::Setup => &self.setup,
            StallPart::Update => &self.update,
            StallPart::Start => &self.start,
            StallPart::Release => &self.release,
        }
    }

    /// The step a run of `part` is in once `ended` have ended: the one after the furthest of them
    /// in the plan's order. The CLI logs a step when it ends and nothing when one begins.
    pub fn running(&self, part: StallPart, ended: &[String]) -> Option<usize> {
        let steps = self.of(part);
        let next = ended
            .iter()
            .filter_map(|done| steps.iter().position(|step| step.key == *done))
            .max()
            .map_or(0, |last| last + 1);
        (next < steps.len()).then_some(next)
    }
}

/// The journeys' steps and their timings.
pub fn plans() -> &'static Plans {
    static PLANS: OnceLock<Plans> = OnceLock::new();
    PLANS.get_or_init(|| {
        Plans::parse(TIMINGS).unwrap_or_else(|error| {
            log::warn!("[stall] the journeys' timings could not be read: {error}");
            Plans::default()
        })
    })
}

/// Every timed step's name, once each: the closed set `StallStep` accepts.
pub fn step_names() -> &'static [&'static str] {
    static NAMES: OnceLock<Vec<&'static str>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let plans = plans();
        let mut names: Vec<&'static str> = Vec::new();
        for part in StallPart::ALL {
            for step in plans.of(part).iter().filter(|step| step.timed) {
                if !names.contains(&step.name.as_str()) {
                    names.push(&step.name);
                }
            }
        }
        names
    })
}

/// A step that has run past its limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stalled {
    pub part: StallPart,
    pub step: StallStep,
    /// What the native side calls it, for the log.
    pub key: String,
    pub typical_seconds: u64,
    pub elapsed_seconds: u64,
}

/// The step one journey is in now, and since when its clock runs.
struct Slot {
    part: StallPart,
    step: usize,
    run: String,
    since: Instant,
    said: bool,
}

/// The step each journey is in, and whether it has run past its limit. One step at a time per
/// journey; the journeys themselves can overlap (a first setup's back end beside OpenBot's install).
#[derive(Default)]
pub struct StepWatch {
    slots: Vec<Slot>,
}

impl StepWatch {
    /// `part` is in the step with `key` for its run `run`, timed from `since`. The same step of the
    /// same run keeps its clock and whether it was said; a step that is not timed, or not in the
    /// journey, leaves nothing timed.
    pub fn now_in(&mut self, part: StallPart, key: &str, run: &str, since: Instant) {
        let step = plans().of(part).iter().position(|step| step.key == key);
        self.place(part, step, run, since);
    }

    /// A CLI setup or update `run` whose steps `ended` have ended, the last at `since` (or which
    /// began then).
    pub fn cli(&mut self, part: StallPart, run: &str, ended: &[String], since: Instant) {
        let step = plans().running(part, ended);
        self.place(part, step, run, since);
    }

    fn place(&mut self, part: StallPart, step: Option<usize>, run: &str, since: Instant) {
        let timed = step.filter(|at| plans().of(part)[*at].timed);
        if let Some(slot) = self.slots.iter().find(|slot| slot.part == part) {
            if Some(slot.step) == timed && slot.run == run {
                return;
            }
        }
        self.done(part);
        if let Some(step) = timed {
            self.slots.push(Slot {
                part,
                step,
                run: run.to_owned(),
                since,
                said: false,
            });
        }
    }

    /// `part`'s step has ended, or its run has.
    pub fn done(&mut self, part: StallPart) {
        self.slots.retain(|slot| slot.part != part);
    }

    /// A download `part`'s step waits on brought in more bytes: its time is the download's.
    pub fn moved(&mut self, part: StallPart, now: Instant) {
        for slot in self.slots.iter_mut().filter(|slot| slot.part == part) {
            slot.since = now;
        }
    }

    /// The step `part` is timing now, by its key.
    pub fn timing(&self, part: StallPart) -> Option<&str> {
        let slot = self.slots.iter().find(|slot| slot.part == part)?;
        Some(&plans().of(part)[slot.step].key)
    }

    /// Every step that has run past its limit by `now` and has not been said.
    pub fn tick(&mut self, now: Instant) -> Vec<Stalled> {
        let mut stalled = Vec::new();
        for slot in self.slots.iter_mut().filter(|slot| !slot.said) {
            let step = &plans().of(slot.part)[slot.step];
            let elapsed = now.saturating_duration_since(slot.since).as_secs();
            if elapsed <= limit(step.typical) {
                continue;
            }
            let Some(name) = StallStep::named(&step.name) else {
                continue;
            };
            slot.said = true;
            stalled.push(Stalled {
                part: slot.part,
                step: name,
                key: step.key.clone(),
                typical_seconds: step.typical,
                elapsed_seconds: elapsed,
            });
        }
        stalled
    }
}

/// How long progress may go untaken, with the window on screen, before it is a stall.
pub const QUIET: Duration = Duration::from_secs(30);

/// At most this many seconds of untaken progress are kept: one entry a second.
const KEPT: usize = 3600;

/// Progress sent and not yet taken by the page. One entry stands for every event sent in the second
/// it began, up to `seq`.
struct Sent {
    seq: u64,
    at: Instant,
    step: FailingStep,
}

/// The page stopped taking progress, since when, and during which part of setup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stall {
    pub step: FailingStep,
    pub since: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiNews {
    /// The page has taken nothing sent since `since`, for over `QUIET`, with the window on screen.
    Stopped { step: FailingStep, since: Instant },
    /// It is over: the stall's length, to be said once.
    Answered { step: FailingStep, seconds: u64 },
}

/// Whether the setup page is taking the progress the native side sends it. See the module.
#[derive(Default)]
pub struct UiWatch {
    /// A setup page is showing and sending heartbeats.
    armed: bool,
    /// The last progress number sent.
    seq: u64,
    /// The highest the page has said it took.
    taken: u64,
    untaken: VecDeque<Sent>,
    /// Since when the window has been on screen without a break.
    on_screen_since: Option<Instant>,
    stall: Option<Stall>,
}

impl UiWatch {
    /// The native side sent the page a progress event about `step`: its number.
    pub fn sent(&mut self, step: FailingStep, now: Instant) -> u64 {
        self.seq += 1;
        if !self.armed {
            return self.seq;
        }
        let kept = self.untaken.len();
        match self.untaken.back_mut() {
            Some(last) if now.saturating_duration_since(last.at) < Duration::from_secs(1) => {
                last.seq = self.seq;
            }
            _ if kept < KEPT => self.untaken.push_back(Sent {
                seq: self.seq,
                at: now,
                step,
            }),
            _ => {}
        }
        self.seq
    }

    /// The page's heartbeat: the highest progress number it has taken. `fresh` is the first from a
    /// page that has just loaded, which counts what was sent before it listened as taken.
    pub fn heartbeat(&mut self, seen: u64, fresh: bool, now: Instant) -> Option<UiNews> {
        self.armed = true;
        self.taken = self
            .taken
            .max(if fresh { self.seq } else { seen.min(self.seq) });
        while self
            .untaken
            .front()
            .is_some_and(|sent| sent.seq <= self.taken)
        {
            self.untaken.pop_front();
        }
        if self.stall.is_some() && self.behind(now).is_none() {
            return self.end(now);
        }
        None
    }

    /// Whether the window is on screen now: shown, not minimised, and on macOS not covered.
    pub fn window(&mut self, on_screen: bool, now: Instant) -> Option<UiNews> {
        if on_screen {
            self.on_screen_since.get_or_insert(now);
            None
        } else {
            self.on_screen_since = None;
            self.end(now)
        }
    }

    /// The window loaded another page: until it sends a heartbeat, nothing is expected of it.
    pub fn page_left(&mut self, now: Instant) -> Option<UiNews> {
        self.armed = false;
        self.untaken.clear();
        self.end(now)
    }

    /// OpenBot is quitting: a stall still going is said now.
    pub fn quit(&mut self, now: Instant) -> Option<UiNews> {
        self.end(now)
    }

    /// A stall that has begun by `now`, once.
    pub fn tick(&mut self, now: Instant) -> Option<UiNews> {
        if !self.armed || self.stall.is_some() {
            return None;
        }
        let stall = self.behind(now)?;
        self.stall = Some(stall);
        Some(UiNews::Stopped {
            step: stall.step,
            since: stall.since,
        })
    }

    /// Progress untaken for over `QUIET`, counted only while the window has been on screen.
    fn behind(&self, now: Instant) -> Option<Stall> {
        let oldest = self.untaken.front()?;
        let since = oldest.at.max(self.on_screen_since?);
        (now.saturating_duration_since(since) > QUIET).then_some(Stall {
            step: oldest.step,
            since,
        })
    }

    fn end(&mut self, now: Instant) -> Option<UiNews> {
        let stall = self.stall.take()?;
        Some(UiNews::Answered {
            step: stall.step,
            seconds: now.saturating_duration_since(stall.since).as_secs(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    /// The numbers come from the journeys: a step takes from the end of the one before it to its
    /// own end, a release line from when it is said to when the next is, and downloads are not
    /// timed.
    #[test]
    fn each_step_takes_what_the_journeys_measured() {
        let plans = plans();
        let typical = |part, key: &str| {
            let step = plans.of(part).iter().find(|step| step.key == key).unwrap();
            (step.typical, step.timed)
        };
        assert_eq!(typical(StallPart::Setup, "dependencies-wait"), (27, true));
        assert_eq!(typical(StallPart::Setup, "engine-check"), (0, true));
        assert_eq!(typical(StallPart::Setup, "image-download"), (14, false));
        assert_eq!(
            typical(StallPart::Setup, "system-image-download"),
            (25, false)
        );
        assert_eq!(typical(StallPart::Setup, "secrets-apply"), (10, true));
        assert_eq!(
            typical(StallPart::Update, "update-quiesce-wait"),
            (31, true)
        );
        assert_eq!(typical(StallPart::Start, "services"), (9, true));
        assert_eq!(typical(StallPart::Start, "images"), (1, false));
        assert_eq!(
            typical(StallPart::Release, "Backing up your data."),
            (13, true)
        );
        assert_eq!(
            typical(StallPart::Release, "Downloading the update."),
            (50, false)
        );
        assert_eq!(typical(StallPart::Release, "Starting OpenBot."), (35, true));
        assert!(step_names().contains(&"dependencies_wait"));
        assert!(step_names().contains(&"carry_over"));
        assert!(!step_names().contains(&"image_download"));
        assert_eq!(limit(0), 120);
        assert_eq!(limit(27), 147);
        assert_eq!(limit(90), 270);
    }

    /// The CLI says a step when it ends: the step running is the one after the furthest ended,
    /// even when the CLI skipped some (a cluster that already existed).
    #[test]
    fn the_step_running_is_the_one_after_the_furthest_ended() {
        let plans = plans();
        let ended = |keys: &[&str]| keys.iter().map(|key| key.to_string()).collect::<Vec<_>>();
        let key = |part, ended: &[String]| {
            plans
                .running(part, ended)
                .map(|at| plans.of(part)[at].key.clone())
        };
        assert_eq!(key(StallPart::Setup, &[]), Some("engine-check".to_string()));
        assert_eq!(
            key(
                StallPart::Setup,
                &ended(&["engine-check", "cluster-discovery", "kubeconfig"])
            ),
            Some("ownership-check".to_string())
        );
        assert_eq!(
            key(StallPart::Update, &ended(&["update-agent-wait"])),
            Some("dependencies-install".to_string())
        );
        assert_eq!(key(StallPart::Update, &ended(&["service-status"])), None);
    }

    /// A step that runs three times as long as it typically takes, and two minutes over, is said
    /// once, with how long it typically takes and how long it has run. Nothing more when it then
    /// finishes; a retry of it is a new step.
    #[test]
    fn a_step_running_three_times_over_is_said_once() {
        let start = Instant::now();
        let mut watch = StepWatch::default();
        let ended = vec!["dependencies-install".to_string()];
        // `dependencies-wait` typically takes 27 seconds: said past 147.
        for second in [0, 60, 120, 147] {
            watch.cli(StallPart::Setup, "attempt-1", &ended, start);
            assert_eq!(watch.tick(at(start, second)), vec![], "at {second}s");
        }
        let said = watch.tick(at(start, 148));
        assert_eq!(
            said,
            vec![Stalled {
                part: StallPart::Setup,
                step: StallStep::named("dependencies_wait").unwrap(),
                key: "dependencies-wait".into(),
                typical_seconds: 27,
                elapsed_seconds: 148,
            }]
        );
        for second in [149, 300, 3600] {
            watch.cli(StallPart::Setup, "attempt-1", &ended, start);
            assert_eq!(
                watch.tick(at(start, second)),
                vec![],
                "said twice at {second}s"
            );
        }
        // It finished; the next step's clock starts when it did.
        let next = vec!["dependencies-install".into(), "dependencies-wait".into()];
        watch.cli(StallPart::Setup, "attempt-1", &next, at(start, 3600));
        assert_eq!(watch.tick(at(start, 3601)), vec![]);
        // Retry: the same step in a new run may be said again.
        watch.cli(StallPart::Setup, "attempt-2", &ended, at(start, 4000));
        assert_eq!(watch.tick(at(start, 4148)).len(), 1);
    }

    /// A short step is said only two minutes over, never at three times a few seconds. A download
    /// is never timed as a step, and a moving download restarts the clock of the step it holds up.
    #[test]
    fn short_steps_get_two_minutes_and_downloads_are_not_timed() {
        let start = Instant::now();
        let mut watch = StepWatch::default();
        watch.now_in(StallPart::Start, "services", "", start);
        assert_eq!(watch.tick(at(start, 128)), vec![]);
        assert_eq!(watch.tick(at(start, 130)).len(), 1);

        let mut watch = StepWatch::default();
        watch.now_in(StallPart::Start, "images", "", start);
        watch.now_in(StallPart::Release, "Downloading the update.", "", start);
        let image_steps = vec!["runtime-identity-write".to_string()];
        watch.cli(StallPart::Setup, "attempt", &image_steps, start);
        assert_eq!(watch.tick(at(start, 3600)), vec![]);

        // The back end's images downloaded before the CLI's first step: bytes kept arriving.
        let mut watch = StepWatch::default();
        for second in (0..=600).step_by(5) {
            watch.cli(StallPart::Update, "attempt", &[], start);
            watch.moved(StallPart::Update, at(start, second));
            assert_eq!(watch.tick(at(start, second)), vec![], "at {second}s");
        }
        // Then nothing more arrived: `release-download` (1 second) is said 121 seconds later.
        assert_eq!(watch.tick(at(start, 721)), vec![]);
        assert_eq!(watch.tick(at(start, 722)).len(), 1);
    }

    /// The page stops taking progress while the native side keeps sending it, with the window on
    /// screen: one stall, said when the page catches up, as long as it lasted.
    #[test]
    fn progress_untaken_while_on_screen_is_one_stall_of_its_length() {
        let start = Instant::now();
        let mut watch = UiWatch::default();
        assert_eq!(watch.window(true, start), None);
        watch.heartbeat(0, true, start);
        // Taken as it comes, with heartbeats: no stall however long.
        for second in 1..=60 {
            let seq = watch.sent(FailingStep::CreateMachine, at(start, second));
            watch.heartbeat(seq, false, at(start, second));
            assert_eq!(watch.tick(at(start, second)), None);
        }
        // From 61, nothing taken. The page's timers still beat, with the old number.
        let taken = watch.sent(FailingStep::CreateMachine, at(start, 60));
        watch.heartbeat(taken, false, at(start, 60));
        for second in 61..=91 {
            watch.sent(FailingStep::StartMachine, at(start, second));
            if second % 5 == 0 {
                watch.heartbeat(taken, false, at(start, second));
            }
            assert_eq!(watch.tick(at(start, second)), None, "at {second}s");
        }
        assert_eq!(
            watch.tick(at(start, 92)),
            Some(UiNews::Stopped {
                step: FailingStep::StartMachine,
                since: at(start, 61)
            })
        );
        assert_eq!(watch.tick(at(start, 95)), None, "said twice");
        let seq = watch.sent(FailingStep::StartMachine, at(start, 103));
        assert_eq!(
            watch.heartbeat(seq, false, at(start, 103)),
            Some(UiNews::Answered {
                step: FailingStep::StartMachine,
                seconds: 42
            })
        );
        assert_eq!(watch.tick(at(start, 200)), None);
        assert_eq!(watch.quit(at(start, 300)), None);
    }

    /// A page whose script stopped altogether sends no heartbeat at all: the same stall. One still
    /// going at quit is said then.
    #[test]
    fn no_heartbeat_at_all_is_a_stall_said_at_quit() {
        let start = Instant::now();
        let mut watch = UiWatch::default();
        watch.window(true, start);
        watch.heartbeat(0, true, start);
        for second in 10..=41 {
            watch.sent(FailingStep::Images, at(start, second));
        }
        assert_eq!(watch.tick(at(start, 40)), None);
        assert!(matches!(
            watch.tick(at(start, 41)),
            Some(UiNews::Stopped { .. })
        ));
        assert_eq!(
            watch.quit(at(start, 100)),
            Some(UiNews::Answered {
                step: FailingStep::Images,
                seconds: 90
            })
        );
    }

    /// Minimised, hidden or covered, a window's page may be held back by the system: nothing it
    /// misses then is a stall, and the 30 seconds count again from when it is back on screen.
    #[test]
    fn a_window_off_screen_is_never_a_stall() {
        let start = Instant::now();
        let mut watch = UiWatch::default();
        watch.heartbeat(0, true, start);
        watch.window(false, start);
        for second in 1..=600 {
            watch.sent(FailingStep::Services, at(start, second));
            watch.window(false, at(start, second));
            assert_eq!(watch.tick(at(start, second)), None, "at {second}s");
        }
        // Back on screen: it has 30 seconds to catch up.
        watch.window(true, at(start, 601));
        assert_eq!(watch.tick(at(start, 631)), None);
        let seq = watch.sent(FailingStep::Services, at(start, 620));
        watch.heartbeat(seq, false, at(start, 625));
        assert_eq!(watch.tick(at(start, 700)), None);
        // A page never set up (no heartbeat yet) is not watched either.
        let mut unarmed = UiWatch::default();
        unarmed.window(true, start);
        for second in 1..=120 {
            unarmed.sent(FailingStep::Services, at(start, second));
        }
        assert_eq!(unarmed.tick(at(start, 120)), None);
    }

    /// A page that loaded after progress was sent took none of it; its first heartbeat counts that
    /// as taken. A page replaced by another (OpenBot opening) is not waited on.
    #[test]
    fn a_fresh_page_and_a_replaced_page_are_not_stalls() {
        let start = Instant::now();
        let mut watch = UiWatch::default();
        watch.window(true, start);
        watch.heartbeat(0, true, start);
        watch.sent(FailingStep::Engine, at(start, 1));
        watch.page_left(at(start, 2));
        for second in 3..=10 {
            watch.sent(FailingStep::Engine, at(start, second));
        }
        // The new page listens, then says hello having taken nothing.
        watch.heartbeat(0, true, at(start, 11));
        assert_eq!(watch.tick(at(start, 100)), None);
        // Replaced while nothing more comes: not waited on.
        watch.page_left(at(start, 101));
        for second in 102..=300 {
            watch.sent(FailingStep::Answering, at(start, second));
        }
        assert_eq!(watch.tick(at(start, 300)), None);
    }
}
