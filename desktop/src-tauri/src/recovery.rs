//! One deliberate authorization for one native-owned credential operation.
use crate::problem::Problem;
use serde::Serialize;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Primitive {
    Read,
    Add,
    Update,
    Delete,
}
impl Primitive {
    #[cfg(target_os = "macos")]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Add => "add",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ItemFailure {
    pub primitive: Primitive,
    pub setting: String,
    pub status: i32,
}

/// Never serialized; Debug deliberately omits captured credential bytes.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RefusedOperation {
    pub primitive: Primitive,
    pub setting: String,
    pub value: Option<String>,
}
impl std::fmt::Debug for RefusedOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefusedOperation")
            .field("primitive", &self.primitive)
            .field("setting", &self.setting)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Offer {
    pub ticket: String,
    pub operation: Primitive,
    pub setting: String,
    pub label: String,
    pub explanation: String,
}
impl Offer {
    fn new(op: &RefusedOperation) -> Self {
        let (label,explanation)=match op.primitive {
            Primitive::Read => ("Restore access to saved setup", "This Mac is protecting a credential from your saved OpenBot setup. Restoring access may ask macOS to confirm this app. Your saved data stays in place."),
            Primitive::Add => ("Allow saving this setup", "macOS could not save this OpenBot credential without confirmation. This step may ask macOS to confirm saving it."),
            Primitive::Update => ("Allow saving this change", "macOS is protecting a saved OpenBot credential. This step may ask macOS to confirm saving the changed credential. Your saved data stays in place."),
            Primitive::Delete => ("Allow removing the obsolete credential", "macOS is protecting an obsolete OpenBot credential. This step may ask macOS to confirm removing that credential. Your other saved data stays in place."),
        };
        let explanation = if op.setting == "KEY_ENCRYPTION_KEY" && op.primitive != Primitive::Add {
            format!("{explanation} The original saved key is needed to read existing data; signing into an account again cannot recreate it.")
        } else {
            explanation.into()
        };
        Self {
            ticket: format!(
                "{:032x}{:032x}",
                rand::random::<u128>(),
                rand::random::<u128>()
            ),
            operation: op.primitive,
            setting: op.setting.clone(),
            label: label.into(),
            explanation,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Start,
    Ask,
}
struct Pending {
    offer: Offer,
    operation: RefusedOperation,
}
struct Flight {
    ticket: String,
    epoch: u64,
    valid: bool,
}
#[derive(Default)]
struct Inner {
    epoch: u64,
    root: std::path::PathBuf,
    action: Option<Action>,
    pending: Option<Pending>,
    flight: Option<Flight>,
}
#[derive(Clone, Default)]
pub struct Recovery(Arc<Mutex<Inner>>);
pub struct Attempt {
    epoch: u64,
}
pub(crate) struct Claimed {
    ticket: String,
    epoch: u64,
    pub operation: RefusedOperation,
}
fn stale() -> Problem {
    Problem::plain("That recovery step is no longer current. Press Start or Ask again.")
}
fn busy() -> Problem {
    Problem::plain("Wait for the current macOS confirmation to finish before changing this setup.")
}
impl Recovery {
    pub fn begin(&self, root: &Path, action: Action) -> Result<Attempt, Problem> {
        let mut held = self.0.lock().map_err(|_| stale())?;
        if held.flight.is_some() {
            return Err(busy());
        }
        held.epoch = held.epoch.wrapping_add(1);
        held.root = root.to_path_buf();
        held.action = Some(action);
        held.pending = None;
        Ok(Attempt { epoch: held.epoch })
    }
    pub fn finish<T>(&self, attempt: Attempt, result: Result<T, Problem>) -> Result<T, Problem> {
        let mut held = self.0.lock().map_err(|_| stale())?;
        if held.epoch != attempt.epoch {
            return Err(stale());
        }
        result.map_err(|mut error| {
            if let Some(operation) = error.refused.take() {
                let operation = *operation;
                let offer = Offer::new(&operation);
                error.recovery = Some(Box::new(offer.clone()));
                held.pending = Some(Pending { offer, operation });
            }
            error
        })
    }
    /// Configuration abandonment uses None; a rendered ticket is cancelled by its exact id.
    /// Once dispatched, cancellation prevents publication but cannot undo an OS mutation.
    pub fn cancel(&self, ticket: Option<&str>) -> Result<(), Problem> {
        let mut held = self.0.lock().map_err(|_| stale())?;
        if let Some(ticket) = ticket {
            let matches = held
                .pending
                .as_ref()
                .is_some_and(|p| p.offer.ticket == ticket)
                || held.flight.as_ref().is_some_and(|f| f.ticket == ticket);
            if !matches {
                return Ok(());
            }
        } else if held.flight.is_some() {
            return Err(busy());
        }
        held.epoch = held.epoch.wrapping_add(1);
        held.pending = None;
        if let Some(flight) = &mut held.flight {
            flight.valid = false;
        }
        Ok(())
    }
    pub fn stop(&self) {
        if let Ok(mut held) = self.0.lock() {
            held.epoch = held.epoch.wrapping_add(1);
            held.pending = None;
            if let Some(flight) = &mut held.flight {
                flight.valid = false;
            }
        }
    }
    pub fn ensure_idle(&self) -> Result<(), Problem> {
        let held = self.0.lock().map_err(|_| stale())?;
        if held.flight.is_some() {
            Err(busy())
        } else {
            Ok(())
        }
    }
    pub fn recover(&self, ticket: &str) -> Result<(), Problem> {
        let claimed = self.claim(ticket)?;
        crate::vault::recover_claimed(self, claimed)
    }
    fn claim(&self, ticket: &str) -> Result<Claimed, Problem> {
        let mut held = self.0.lock().map_err(|_| stale())?;
        if held.flight.is_some()
            || !held
                .pending
                .as_ref()
                .is_some_and(|p| p.offer.ticket == ticket)
        {
            return Err(stale());
        }
        let pending = held.pending.take().ok_or_else(stale)?;
        let epoch = held.epoch;
        held.flight = Some(Flight {
            ticket: ticket.into(),
            epoch,
            valid: true,
        });
        Ok(Claimed {
            ticket: ticket.into(),
            epoch,
            operation: pending.operation,
        })
    }
    pub(crate) fn dispatch(&self, claimed: &Claimed) -> Result<(), Problem> {
        let held = self.0.lock().map_err(|_| stale())?;
        if current(&held, claimed) {
            Ok(())
        } else {
            Err(stale())
        }
    }
    pub(crate) fn complete<T>(
        &self,
        claimed: Claimed,
        result: Result<T, Problem>,
        publish: impl FnOnce(T),
    ) -> Result<(), Problem> {
        let mut held = self.0.lock().map_err(|_| stale())?;
        let valid = current(&held, &claimed);
        // Only the owner can retire its flight, even after Stop invalidated its epoch.
        if held
            .flight
            .as_ref()
            .is_some_and(|f| f.ticket == claimed.ticket)
        {
            held.flight = None;
        }
        if !valid {
            return Err(stale());
        }
        match result {
            Ok(value) => {
                publish(value);
                Ok(())
            }
            Err(mut error) => {
                if error.refused.take().is_some() {
                    let offer = Offer::new(&claimed.operation);
                    error.recovery = Some(Box::new(offer.clone()));
                    held.pending = Some(Pending {
                        offer,
                        operation: claimed.operation,
                    });
                }
                Err(error)
            }
        }
    }
}
fn current(held: &Inner, claimed: &Claimed) -> bool {
    held.epoch == claimed.epoch
        && held
            .flight
            .as_ref()
            .is_some_and(|f| f.valid && f.epoch == claimed.epoch && f.ticket == claimed.ticket)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn refusal(value: &str) -> Problem {
        let mut p = Problem::plain("synthetic refusal");
        p.refused = Some(Box::new(RefusedOperation {
            primitive: Primitive::Update,
            setting: "OPENAI_API_KEY".into(),
            value: Some(value.into()),
        }));
        p
    }
    fn offer(state: &Recovery) -> Offer {
        let a = state
            .begin(Path::new("synthetic-root-a"), Action::Start)
            .unwrap();
        *state
            .finish::<()>(a, Err(refusal("SECRET-SENTINEL")))
            .unwrap_err()
            .recovery
            .unwrap()
    }
    #[test]
    fn ticket_is_one_use_and_never_serializes_or_debugs_bytes() {
        let state = Recovery::default();
        let offer = offer(&state);
        let claim = state.claim(&offer.ticket).unwrap();
        assert!(state.claim(&offer.ticket).is_err());
        assert!(!format!("{:?}", claim.operation).contains("SECRET-SENTINEL"));
        assert!(!serde_json::to_string(&refusal("SECRET-SENTINEL"))
            .unwrap()
            .contains("SECRET-SENTINEL"));
        assert!(!format!("{:?}", refusal("SECRET-SENTINEL")).contains("SECRET-SENTINEL"));
        assert!(state.begin(Path::new("root-b"), Action::Ask).is_err());
        state.complete(claim, Ok(()), |_| {}).unwrap();
        assert!(state.claim(&offer.ticket).is_err());
    }
    #[test]
    fn cancel_before_dispatch_and_late_success_do_not_publish() {
        let state = Recovery::default();
        let offer = offer(&state);
        let claim = state.claim(&offer.ticket).unwrap();
        state.cancel(Some(&offer.ticket)).unwrap();
        assert!(state.dispatch(&claim).is_err());
        assert!(state
            .complete(claim, Ok(()), |_| panic!("late publication"))
            .is_err());
        assert!(state.ensure_idle().is_ok());
    }
    #[test]
    fn older_failure_cannot_replace_new_action_and_retry_is_fresh() {
        let state = Recovery::default();
        let old = state.begin(Path::new("root-a"), Action::Start).unwrap();
        let new = state.begin(Path::new("root-b"), Action::Ask).unwrap();
        assert!(state
            .finish::<()>(old, Err(refusal("old")))
            .unwrap_err()
            .recovery
            .is_none());
        let offer = state
            .finish::<()>(new, Err(refusal("new")))
            .unwrap_err()
            .recovery
            .unwrap();
        let claim = state.claim(&offer.ticket).unwrap();
        let retry = state
            .complete::<()>(claim, Err(refusal("new")), |_| panic!())
            .unwrap_err()
            .recovery
            .unwrap();
        assert_ne!(retry.ticket, offer.ticket);
        assert!(state.claim(&offer.ticket).is_err());
        state.stop();
        assert!(state.claim(&retry.ticket).is_err());
    }
    #[test]
    fn exact_payload_survives_refusal_and_configuration_abandonment_drops_it() {
        let state = Recovery::default();
        let first = offer(&state);
        let claim = state.claim(&first.ticket).unwrap();
        assert_eq!(claim.operation.value.as_deref(), Some("SECRET-SENTINEL"));
        assert!(state.cancel(None).is_err());
        assert!(state.begin(Path::new("root-b"), Action::Ask).is_err());
        state.complete(claim, Ok(()), |_| {}).unwrap();
        let attempt = state.begin(Path::new("root-b"), Action::Ask).unwrap();
        let mut error = refusal("different-value");
        error.refused.as_mut().unwrap().setting = "MANAGED_AGENT_TOKEN".into();
        let second = state
            .finish::<()>(attempt, Err(error))
            .unwrap_err()
            .recovery
            .unwrap();
        assert_eq!(second.setting, "MANAGED_AGENT_TOKEN");
        assert_eq!(state.0.lock().unwrap().root, Path::new("root-b"));
        assert_ne!(first.ticket, second.ticket);
        state.cancel(Some(&second.ticket)).unwrap();
        assert!(state.0.lock().unwrap().pending.is_none());
        assert!(state.claim(&second.ticket).is_err());
    }

    #[test]
    fn a_fresh_key_add_does_not_claim_existing_saved_data() {
        let offer = Offer::new(&RefusedOperation {
            primitive: Primitive::Add,
            setting: "KEY_ENCRYPTION_KEY".into(),
            value: Some("synthetic-new-key".into()),
        });
        assert_eq!(offer.label, "Allow saving this setup");
        assert!(!offer.explanation.contains("original saved key"));
        assert!(!offer.explanation.contains("existing data"));
    }

    #[test]
    fn concurrent_clicks_have_exactly_one_winner() {
        let state = Recovery::default();
        let ticket = offer(&state).ticket;
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|s| {
            let a = s.spawn(|| {
                barrier.wait();
                state.claim(&ticket).is_ok()
            });
            let b = s.spawn(|| {
                barrier.wait();
                state.claim(&ticket).is_ok()
            });
            barrier.wait();
            assert_ne!(a.join().unwrap(), b.join().unwrap());
        });
    }
}
