//! Where the person's choice is kept: `connection.json` in the app's configuration folder.
//!
//! `{ "mode": "local" | "connected", "address": "https://..." }`. No file means local, which is
//! what every installation from before this choice is. Never a secret: the sign-in is in the
//! system's credential store (`credentials`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = "connection.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// OpenBot runs on this computer.
    #[default]
    Local,
    /// The app is connected to an OpenBot at an address.
    Connected,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    #[serde(default)]
    pub mode: Mode,
    /// The normalised address last connected to. Kept through a sign-out and a switch back to
    /// this computer, so it can be offered again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// The organisation the person picked in the app at that address, which the relay names on
    /// every request. Not a secret. Kept through a sign-out, so signing in again at the same
    /// address works where the person left off (an app's token carries no memory of it, so the
    /// app is what remembers). Gone with a new address and back on this computer.
    #[serde(
        default,
        rename = "organizationId",
        skip_serializing_if = "Option::is_none"
    )]
    pub organization_id: Option<String>,
}

/// Whether `id` can be an organisation's id: letters, digits, `_` and `-`, at most 128.
pub fn valid_organization(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl Choice {
    /// The address, when the choice is to be connected to it.
    pub fn connected_to(&self) -> Option<&str> {
        match self.mode {
            Mode::Connected => self.address.as_deref(),
            Mode::Local => None,
        }
    }
}

/// The choice once signed in at `address`: connected there, with the organisation picked earlier
/// kept only when it was picked at that same address. An organisation belongs to the OpenBot it
/// was picked at, and one the person has since left is answered as not found there, which the app
/// turns back into their own.
pub fn signed_in_at(earlier: &Choice, address: &str) -> Choice {
    Choice {
        mode: Mode::Connected,
        address: Some(address.to_owned()),
        organization_id: earlier
            .organization_id
            .clone()
            .filter(|_| earlier.address.as_deref() == Some(address)),
    }
}

pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE)
}

/// The choice on record. No file, or one that cannot be read, is local: the app then behaves as
/// it did before there was a choice.
pub fn read(config_dir: &Path) -> Choice {
    std::fs::read(path(config_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Choice>(&bytes).ok())
        // Connected to nothing is not connected.
        .filter(|choice| choice.mode == Mode::Local || choice.address.is_some())
        .map(|mut choice| {
            // The file can be edited by hand; an id that is not one is not sent anywhere.
            choice.organization_id = choice.organization_id.filter(|id| valid_organization(id));
            choice
        })
        .unwrap_or_default()
}

/// Keep `choice`, replacing the file whole so a reader never sees half of one.
pub fn write(config_dir: &Path, choice: &Choice) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let target = path(config_dir);
    let partial = config_dir.join(format!("{FILE}.partial"));
    std::fs::write(&partial, serde_json::to_vec_pretty(choice)?)?;
    std::fs::rename(&partial, &target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    fn no_file_is_local_and_a_written_choice_reads_back() {
        let dir = temp_root("connection-choice");
        assert_eq!(read(&dir), Choice::default());
        assert_eq!(read(&dir).mode, Mode::Local);

        let connected = Choice {
            mode: Mode::Connected,
            address: Some("https://openbot.example.com".into()),
            organization_id: None,
        };
        write(&dir, &connected).unwrap();
        assert_eq!(read(&dir), connected);
        assert_eq!(
            read(&dir).connected_to(),
            Some("https://openbot.example.com")
        );
        // The file is the agreed shape, and nothing else is written beside it.
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(
            file,
            serde_json::json!({ "mode": "connected", "address": "https://openbot.example.com" })
        );
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from(FILE)]);

        // Back on this computer, the address is remembered and not connected to.
        let local = Choice {
            mode: Mode::Local,
            ..connected
        };
        write(&dir, &local).unwrap();
        assert_eq!(read(&dir).connected_to(), None);
        assert_eq!(
            read(&dir).address.as_deref(),
            Some("https://openbot.example.com")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_organisation_is_kept_beside_the_address_and_a_bad_id_is_not() {
        let dir = temp_root("connection-choice-organisation");
        let chosen = Choice {
            mode: Mode::Connected,
            address: Some("https://openbot.example.com".into()),
            organization_id: Some("org_9fK2-a".into()),
        };
        write(&dir, &chosen).unwrap();
        assert_eq!(read(&dir), chosen);
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(file["organizationId"], "org_9fK2-a");

        for bad in ["", "two words", "a/b", "line\nbreak", &"x".repeat(129)] {
            assert!(!valid_organization(bad), "{bad:?}");
        }
        assert!(valid_organization(&"x".repeat(128)));
        std::fs::write(
            dir.join(FILE),
            r#"{"mode":"connected","address":"https://openbot.example.com","organizationId":"a b"}"#,
        )
        .unwrap();
        assert_eq!(read(&dir).organization_id, None);
        assert_eq!(
            read(&dir).connected_to(),
            Some("https://openbot.example.com")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_cannot_be_read_or_names_no_address_is_local() {
        let dir = temp_root("connection-choice-bad");
        std::fs::create_dir_all(&dir).unwrap();
        for bad in [
            "",
            "not json",
            r#"{"mode":"connected"}"#,
            r#"{"mode":"elsewhere"}"#,
        ] {
            std::fs::write(dir.join(FILE), bad).unwrap();
            assert_eq!(read(&dir), Choice::default(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
