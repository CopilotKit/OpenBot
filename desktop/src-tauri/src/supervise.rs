//! Keeping the three host processes alive, and not outliving them.
//!
//! `worker/src/index.ts` states the problem it has: "this process has no restart policy watching
//! it; it is somebody's laptop, left running". The shell is that policy. What a policy needs, and
//! what spawning three times is not:
//!
//! - **A restart, with a limit.** A process that dies once at three in the morning should come
//!   back. A process that dies immediately, ten times, is broken, and restarting it forever turns a
//!   fault into a hot laptop and an unreadable log.
//! - **Backoff.** Restarting instantly against a port that is taken, or a database that is not up
//!   yet, is a loop that never resolves and starves the machine while it fails.
//! - **A window that closes on them.** A sidecar that survives the app is the failure Tauri has an
//!   open issue about: quit the window, and an orphaned server still holds port 3001, so the next
//!   launch cannot start and nothing on screen says why.

use std::time::{Duration, Instant};

/// Give up after this many restarts in `WINDOW`. Enough to ride out a transient fault, few enough
/// that a broken process is reported rather than retried forever.
pub const MAX_RESTARTS: u32 = 5;

/// Restarts are only counted while they are close together. A process that has run for an hour and
/// then dies is having its first problem, not its sixth.
pub const WINDOW: Duration = Duration::from_secs(300);

/// How long to wait before the nth restart. Doubling, capped, so a process that cannot start does
/// not spin.
pub fn backoff(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(5); // 1, 2, 4, 8, 16, 32
    Duration::from_secs(seconds.min(32))
}

/// What the supervisor knows about one process.
pub struct Watch {
    pub name: &'static str,
    pub restarts: u32,
    pub first_restart: Option<Instant>,
}

impl Watch {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            restarts: 0,
            first_restart: None,
        }
    }

    /// Record a death and say whether to start it again.
    pub fn should_restart(&mut self, now: Instant) -> bool {
        match self.first_restart {
            // Outside the window: this is a fresh problem, not a continuing one.
            Some(first) if now.duration_since(first) > WINDOW => {
                self.restarts = 1;
                self.first_restart = Some(now);
                true
            }
            Some(_) => {
                self.restarts += 1;
                self.restarts <= MAX_RESTARTS
            }
            None => {
                self.restarts = 1;
                self.first_restart = Some(now);
                true
            }
        }
    }

    /// What to say when it is not coming back.
    pub fn gave_up(&self) -> String {
        format!(
            "{} stopped {} times in {} minutes, so it is not being started again. Its log says why.",
            self.name,
            self.restarts,
            WINDOW.as_secs() / 60
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_then_stops_growing() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(
            backoff(10),
            Duration::from_secs(32),
            "an unbounded wait is not a wait"
        );
    }

    #[test]
    fn a_process_that_dies_once_comes_back() {
        let mut watch = Watch::new("server");
        assert!(watch.should_restart(Instant::now()));
    }

    #[test]
    fn a_process_that_will_not_start_is_given_up_on_rather_than_spun() {
        let mut watch = Watch::new("server");
        let now = Instant::now();
        for _ in 0..MAX_RESTARTS {
            assert!(watch.should_restart(now), "should still be trying");
        }
        assert!(
            !watch.should_restart(now),
            "restarting forever turns a fault into a hot laptop"
        );
        assert!(watch.gave_up().contains("server"));
        assert!(
            watch.gave_up().contains("log"),
            "must point at where the reason is"
        );
    }

    #[test]
    fn a_process_that_ran_for_an_hour_is_having_its_first_problem() {
        let mut watch = Watch::new("worker");
        let long_ago = Instant::now() - WINDOW - Duration::from_secs(60);
        watch.restarts = MAX_RESTARTS;
        watch.first_restart = Some(long_ago);

        assert!(
            watch.should_restart(Instant::now()),
            "an old fault should not count against a new one"
        );
        assert_eq!(watch.restarts, 1, "the count starts again");
    }
}
