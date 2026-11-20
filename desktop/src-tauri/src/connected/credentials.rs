//! The sign-in to an OpenBot that runs elsewhere, kept in the operating system's credential store.
//!
//! Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux, through the
//! `keyring` crate. One entry per OpenBot: the service is this app's identifier and the account is
//! the normalised address. Only the refresh token is kept. The access token lives in memory for
//! its hour and is never written anywhere; nothing token-shaped is written to a file or a log.

use super::{host_of, Kind};
use crate::problem::Problem;
use std::sync::Arc;

/// The service every entry is filed under: the app's identifier.
pub const SERVICE: &str = "ai.copilotkit.openbot.desktop";

type MakeEntry = dyn Fn(&str) -> keyring_core::Result<keyring_core::Entry> + Send + Sync;

/// Where sign-ins are kept. Cheap to clone; every clone is the same store.
#[derive(Clone)]
pub struct Store {
    entry: Arc<MakeEntry>,
}

impl Store {
    /// The operating system's own store.
    pub fn system() -> Self {
        Self {
            entry: Arc::new(|address| {
                keyring::Entry::new(SERVICE, address).map(|entry| entry.inner)
            }),
        }
    }

    /// A store of the caller's choosing: `keyring`'s in-memory one, in tests.
    pub fn of(store: Arc<keyring_core::CredentialStore>) -> Self {
        Self {
            entry: Arc::new(move |address| store.build(SERVICE, address, None)),
        }
    }

    /// The refresh token kept for `address`, or None when there is no sign-in for it.
    pub fn get(&self, address: &str) -> Result<Option<String>, Problem> {
        match (self.entry)(address).and_then(|entry| entry.get_password()) {
            Ok(token) if token.is_empty() => Ok(None),
            Ok(token) => Ok(Some(token)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(refused(address, "read", &error)),
        }
    }

    /// Keep `refresh_token` as the sign-in for `address`, in place of any earlier one.
    pub fn set(&self, address: &str, refresh_token: &str) -> Result<(), Problem> {
        (self.entry)(address)
            .and_then(|entry| entry.set_password(refresh_token))
            .map_err(|error| refused(address, "save", &error))
    }

    /// Forget the sign-in for `address`. Forgetting one that is not there is not a failure.
    pub fn forget(&self, address: &str) -> Result<(), Problem> {
        match (self.entry)(address).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(refused(address, "remove", &error)),
        }
    }
}

/// The store's own words go to the log. They name the failure, never the secret: `keyring`'s
/// errors carry no credential except `BadEncoding`, whose bytes are left out here.
fn refused(address: &str, what: &str, error: &keyring_core::Error) -> Problem {
    let detail = match error {
        keyring_core::Error::BadEncoding(_) => "the stored sign-in is not text".to_owned(),
        keyring_core::Error::BadDataFormat(_, _) => "the stored sign-in is not readable".to_owned(),
        other => other.to_string(),
    };
    Kind::CredentialStore.problem(
        &host_of(address),
        format!("could not {what} the sign-in in the credential store: {detail}"),
    )
}

#[cfg(test)]
pub(crate) fn in_memory() -> Store {
    Store::of(keyring_core::mock::Store::new().expect("keyring's in-memory store"))
}

#[cfg(test)]
mod tests {
    use super::super::kind_of;
    use super::*;

    const ADDRESS: &str = "https://openbot.example.com";

    // Built at run time, so no token-shaped literal sits in the source for a scanner to stop.
    fn refresh_token(body: &str) -> String {
        format!("obr_{}", body.repeat(8))
    }

    #[test]
    fn a_sign_in_is_kept_per_address_replaced_and_forgotten() {
        let store = in_memory();
        assert_eq!(store.get(ADDRESS).unwrap(), None);
        store.forget(ADDRESS).expect("forgetting nothing is fine");

        let first = refresh_token("Ab3x");
        store.set(ADDRESS, &first).unwrap();
        assert_eq!(store.get(ADDRESS).unwrap(), Some(first));
        // Another OpenBot has a sign-in of its own.
        assert_eq!(store.get("https://other.example.com").unwrap(), None);

        let second = refresh_token("Zq9k");
        store.set(ADDRESS, &second).unwrap();
        assert_eq!(store.clone().get(ADDRESS).unwrap(), Some(second));

        store.forget(ADDRESS).unwrap();
        assert_eq!(store.get(ADDRESS).unwrap(), None);
    }

    /// A store that refuses (a locked keychain, a Credential Manager that is turned off) is said
    /// as that, with the next thing to do, and its failure never repeats the token.
    #[test]
    fn a_store_that_refuses_says_so_without_the_token() {
        let mock = keyring_core::mock::Store::new().unwrap();
        let store = Store::of(mock.clone());
        let entry = {
            use keyring_core::api::CredentialStoreApi;
            mock.build(SERVICE, ADDRESS, None).unwrap()
        };
        let cred: &keyring_core::mock::Cred = entry.as_any().downcast_ref().unwrap();
        cred.set_error(keyring_core::Error::NoStorageAccess(
            "the keychain is locked".into(),
        ));
        let token = refresh_token("Lm4p");
        let problem = store.set(ADDRESS, &token).expect_err("the store refused");
        assert_eq!(kind_of(&problem), Some(Kind::CredentialStore));
        assert_eq!(
            problem.said,
            if cfg!(windows) {
                "OpenBot couldn't save your sign-in on this computer. Check Windows Credential Manager, then try again."
            } else {
                "OpenBot couldn't save your sign-in on this computer. Unlock your keychain, then try again."
            }
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains("the keychain is locked"), "{detail}");
        assert!(!detail.contains(&token), "{detail}");
    }
}
