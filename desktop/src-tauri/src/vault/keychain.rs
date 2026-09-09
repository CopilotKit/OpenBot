//! Legacy file-Keychain interaction policy is process-wide. Own it for the whole operation,
//! including Add's duplicate-item Update, and restore the caller's exact prior policy.
use crate::problem::Problem;
use std::sync::{Mutex, MutexGuard};

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainGetUserInteractionAllowed(allowed: *mut u8) -> i32;
    fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
}

trait InteractionPolicy {
    fn get(&self) -> Result<bool, i32>;
    fn set(&self, allowed: bool) -> Result<(), i32>;
}

struct SystemPolicy;
impl InteractionPolicy for SystemPolicy {
    fn get(&self) -> Result<bool, i32> {
        let mut allowed = 0;
        // Security writes one Boolean byte; its status must succeed before using the output.
        let status = unsafe { SecKeychainGetUserInteractionAllowed(&mut allowed) };
        if status == 0 {
            Ok(allowed != 0)
        } else {
            Err(status)
        }
    }
    fn set(&self, allowed: bool) -> Result<(), i32> {
        let status = unsafe { SecKeychainSetUserInteractionAllowed(u8::from(allowed)) };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }
}

// Some(prior) means restoration is still owed. After a failed restoration, a later operation
// must first successfully restore that exact state. A poisoned gate always fails closed.
static OPERATIONS: Mutex<Option<bool>> = Mutex::new(None);

pub(super) fn without_ui<T>(
    operation: &str,
    name: &str,
    run: impl FnOnce() -> Result<T, Problem>,
) -> Result<T, Problem> {
    with_policy(&OPERATIONS, &SystemPolicy, operation, name, run)
}

fn with_policy<T>(
    gate: &Mutex<Option<bool>>,
    policy: &impl InteractionPolicy,
    operation: &str,
    name: &str,
    run: impl FnOnce() -> Result<T, Problem>,
) -> Result<T, Problem> {
    let mut held = gate
        .lock()
        .map_err(|_| problem(operation, name, "gate-poisoned", None))?;
    if let Some(prior) = *held {
        policy
            .set(prior)
            .map_err(|status| problem(operation, name, "pending-restore", Some(status)))?;
        *held = None;
    }
    let prior = policy
        .get()
        .map_err(|status| problem(operation, name, "get-policy", Some(status)))?;
    *held = Some(prior);
    let session = Session {
        held,
        policy,
        operation,
        name,
        armed: true,
    };
    if let Err(status) = policy.set(false) {
        return session.finish(Err(problem(operation, name, "disable-ui", Some(status))));
    }
    session.finish(run())
}

struct Session<'a, P: InteractionPolicy> {
    held: MutexGuard<'a, Option<bool>>,
    policy: &'a P,
    operation: &'a str,
    name: &'a str,
    armed: bool,
}

impl<P: InteractionPolicy> Session<'_, P> {
    fn restore(&mut self) -> Result<(), Problem> {
        if let Some(prior) = *self.held {
            self.policy.set(prior).map_err(|status| {
                problem(self.operation, self.name, "restore-policy", Some(status))
            })?;
            *self.held = None;
        }
        Ok(())
    }

    fn finish<T>(mut self, result: Result<T, Problem>) -> Result<T, Problem> {
        let restored = self.restore();
        self.armed = false;
        match restored {
            Ok(()) => result,
            Err(mut restore) => {
                if let Err(original) = result {
                    if let Some(detail) = original.detail {
                        restore
                            .detail
                            .get_or_insert_with(String::new)
                            .push_str(&format!("; operation failure: {detail}"));
                    }
                }
                Err(restore)
            }
        }
    }
}

impl<P: InteractionPolicy> Drop for Session<'_, P> {
    fn drop(&mut self) {
        if self.armed {
            // This is the unwind path. Keep restoration debt and poison the gate on failure;
            // never report success, lose the prior policy, or silently reopen the operation gate.
            if let Err(error) = self.restore() {
                eprintln!(
                    "Keychain policy restoration failed during unwind: {}",
                    error.detail.as_deref().unwrap_or("policy error")
                );
            }
        }
    }
}

pub(super) fn problem(operation: &str, name: &str, phase: &str, status: Option<i32>) -> Problem {
    // Names outside the fixed setting allowlist must not enter diagnostics (or contain values).
    let category = if super::is_secret(name) {
        name
    } else {
        "other-credential"
    };
    let said = match status {
        Some(-25293 | -25308 | -128) => "OpenBot could not access a saved credential without macOS authorization. OpenBot stopped this action.",
        _ => "OpenBot could not complete a saved-credential operation. OpenBot stopped this action.",
    };
    Problem::with(
        said,
        format!(
            "Keychain operation={operation} key={category} phase={phase} os_status={}",
            status.map_or_else(|| "none".to_string(), |code| code.to_string())
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering::SeqCst},
        Arc, Barrier,
    };

    struct FakePolicy {
        allowed: AtomicBool,
        get_error: Mutex<Option<i32>>,
        set_results: Mutex<std::collections::VecDeque<Result<(), i32>>>,
        events: Mutex<Vec<String>>,
    }
    impl FakePolicy {
        fn new(allowed: bool, results: Vec<Result<(), i32>>) -> Self {
            Self {
                allowed: AtomicBool::new(allowed),
                get_error: Mutex::new(None),
                set_results: Mutex::new(results.into()),
                events: Mutex::new(vec![]),
            }
        }
    }
    impl InteractionPolicy for FakePolicy {
        fn get(&self) -> Result<bool, i32> {
            self.events.lock().unwrap().push("get".into());
            match *self.get_error.lock().unwrap() {
                Some(status) => Err(status),
                None => Ok(self.allowed.load(SeqCst)),
            }
        }
        fn set(&self, allowed: bool) -> Result<(), i32> {
            self.events.lock().unwrap().push(format!("set:{allowed}"));
            self.set_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(()))?;
            self.allowed.store(allowed, SeqCst);
            Ok(())
        }
    }

    #[test]
    fn operations_and_errors_restore_exact_prior_policy() {
        for prior in [false, true] {
            for operation in ["read", "save", "delete"] {
                for refused in [false, true] {
                    let policy = FakePolicy::new(prior, vec![]);
                    let gate = Mutex::new(None);
                    let result =
                        with_policy(&gate, &policy, operation, "KEY_ENCRYPTION_KEY", || {
                            assert!(!policy.allowed.load(SeqCst));
                            policy.events.lock().unwrap().push(operation.into());
                            if refused {
                                Err(problem(
                                    operation,
                                    "KEY_ENCRYPTION_KEY",
                                    "item",
                                    Some(-25308),
                                ))
                            } else {
                                Ok(())
                            }
                        });
                    assert_eq!(result.is_err(), refused);
                    assert_eq!(policy.allowed.load(SeqCst), prior);
                    assert_eq!(*gate.lock().unwrap(), None);
                    assert_eq!(
                        *policy.events.lock().unwrap(),
                        [
                            "get".to_string(),
                            "set:false".into(),
                            operation.into(),
                            format!("set:{prior}")
                        ]
                    );
                }
            }
        }
    }

    #[test]
    fn setup_failure_never_runs_operation_and_checks_restoration() {
        let policy = FakePolicy::new(true, vec![]);
        *policy.get_error.lock().unwrap() = Some(-50);
        let gate = Mutex::new(None);
        let get = with_policy(
            &gate,
            &policy,
            "read",
            "OPENAI_API_KEY",
            || -> Result<(), Problem> { panic!("get failed") },
        )
        .unwrap_err();
        assert!(get.detail.unwrap().contains("get-policy os_status=-50"));
        assert_eq!(*policy.events.lock().unwrap(), ["get"]);
        let policy = FakePolicy::new(true, vec![Err(-25308), Err(-50)]);
        let disable = with_policy(
            &gate,
            &policy,
            "read",
            "OPENAI_API_KEY",
            || -> Result<(), Problem> { panic!("disable failed") },
        )
        .unwrap_err();
        let detail = disable.detail.unwrap();
        assert!(detail.contains("restore-policy os_status=-50"));
        assert!(detail.contains("disable-ui os_status=-25308"));
        assert_eq!(*gate.lock().unwrap(), Some(true));
    }

    #[test]
    fn restoration_debt_blocks_until_successfully_reestablished() {
        let gate = Mutex::new(None);
        let policy = FakePolicy::new(
            true,
            vec![Ok(()), Err(-50), Err(-50), Ok(()), Ok(()), Ok(())],
        );
        let first =
            with_policy(&gate, &policy, "save", "KEY_ENCRYPTION_KEY", || Ok(())).unwrap_err();
        assert!(first.detail.unwrap().contains("restore-policy"));
        let second = with_policy(
            &gate,
            &policy,
            "delete",
            "KEY_ENCRYPTION_KEY",
            || -> Result<(), Problem> { panic!("unrestored policy") },
        )
        .unwrap_err();
        assert!(second.detail.unwrap().contains("pending-restore"));
        with_policy(&gate, &policy, "read", "KEY_ENCRYPTION_KEY", || {
            assert!(!policy.allowed.load(SeqCst));
            Ok(())
        })
        .unwrap();
        assert!(policy.allowed.load(SeqCst));
        assert_eq!(*gate.lock().unwrap(), None);
    }

    #[test]
    fn unwind_restores_policy_and_poisoned_gate_never_forwards() {
        for restoration_fails in [false, true] {
            let gate = Mutex::new(None);
            let policy = FakePolicy::new(
                true,
                vec![Ok(()), if restoration_fails { Err(-50) } else { Ok(()) }],
            );
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _: Result<(), Problem> =
                    with_policy(&gate, &policy, "read", "KEY_ENCRYPTION_KEY", || {
                        panic!("synthetic unwind")
                    });
            }))
            .is_err());
            assert_eq!(policy.allowed.load(SeqCst), !restoration_fails);
            let prior_events = policy.events.lock().unwrap().len();
            let error = with_policy(
                &gate,
                &policy,
                "read",
                "KEY_ENCRYPTION_KEY",
                || -> Result<(), Problem> { panic!("poisoned gate") },
            )
            .unwrap_err();
            assert!(error.detail.unwrap().contains("gate-poisoned"));
            assert_eq!(policy.events.lock().unwrap().len(), prior_events);
        }
    }

    #[test]
    fn concurrent_operations_cannot_restore_policy_inside_another_operation() {
        let gate = Arc::new(Mutex::new(None));
        let policy = Arc::new(FakePolicy::new(true, vec![]));
        let started = Arc::new(Barrier::new(3));
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    started.wait();
                    for _ in 0..100 {
                        with_policy(&gate, &*policy, "read", "KEY_ENCRYPTION_KEY", || {
                            assert_eq!(active.fetch_add(1, SeqCst), 0);
                            assert!(!policy.allowed.load(SeqCst));
                            std::thread::yield_now();
                            assert!(!policy.allowed.load(SeqCst));
                            assert_eq!(active.fetch_sub(1, SeqCst), 1);
                            Ok(())
                        })
                        .unwrap();
                    }
                });
            }
            started.wait();
        });
        assert!(policy.allowed.load(SeqCst));
        let events = policy.events.lock().unwrap();
        assert_eq!(events.len(), 600);
        for event in events.chunks_exact(3) {
            assert_eq!(event, ["get", "set:false", "set:true"]);
        }
    }
}

// Ordinary library tests must not reach the real Security framework even if a callsite regresses.
// The binary tests install the same six traps at their executable boundary in main.rs.
#[cfg(test)]
mod native_traps {
    use std::ffi::c_void;
    #[export_name = "SecItemCopyMatching"]
    extern "C" fn read(_: *const c_void, _: *mut *const c_void) -> i32 {
        -25293
    }
    #[export_name = "SecItemAdd"]
    extern "C" fn add(_: *const c_void, _: *mut *const c_void) -> i32 {
        -25293
    }
    #[export_name = "SecItemUpdate"]
    extern "C" fn update(_: *const c_void, _: *const c_void) -> i32 {
        -25293
    }
    #[export_name = "SecItemDelete"]
    extern "C" fn delete(_: *const c_void) -> i32 {
        -25293
    }
    #[export_name = "SecKeychainGetUserInteractionAllowed"]
    extern "C" fn get(_: *mut u8) -> i32 {
        -25293
    }
    #[export_name = "SecKeychainSetUserInteractionAllowed"]
    extern "C" fn set(_: u8) -> i32 {
        -25293
    }

    #[test]
    fn all_native_operations_are_nonforwarding_in_ordinary_tests() {
        std::hint::black_box([
            read as *const (),
            add as *const (),
            update as *const (),
            delete as *const (),
            get as *const (),
            set as *const (),
        ]);
    }
}
