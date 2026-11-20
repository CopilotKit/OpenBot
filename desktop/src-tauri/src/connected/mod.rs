/*!
OpenBot Desktop connected to an OpenBot that runs somewhere else.

The person types one address. The app signs in to that OpenBot in the system browser (OAuth 2.1
authorization code with PKCE and a loopback redirect, `sign_in`), keeps the sign-in in the operating
system's credential store (`credentials`), and shows that OpenBot's own pages in the window through
a relay on `127.0.0.1` (`relay`), which is the only thing that ever holds a token. Nothing of a local
installation is started, read or written while the app is connected.

- `choice`: which of the two the person chose, in `connection.json`.
- `address`: a typed address made into one the app can use, and checked to be an OpenBot it can
  connect to.
- `sign_in`: the browser sign-in, the token exchange, refresh and sign-out.
- `credentials`: the refresh token, in Keychain, Credential Manager or the Secret Service.
- `relay`: the loopback HTTP server the window loads.
*/

pub mod address;
pub mod choice;
pub mod credentials;
pub mod relay;
pub mod sign_in;

// The file's name ends in `_tests.rs` so the repository's scan of hand-written server addresses
// (api/client-boundary.test.ts) reads it as the test stand-in it is.
#[cfg(test)]
#[path = "fake_openbot_tests.rs"]
pub(crate) mod fake_openbot;

use crate::problem::Problem;

/// The public client this app signs in as. It has no secret.
pub const CLIENT_ID: &str = "openbot-desktop-oauth";

/// Why a connection could not be made or kept, for the window to choose what to offer next. The
/// sentence for each is written here, once, and the window shows it as given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    AddressInvalid,
    Unreachable,
    NotOpenBot,
    SinglePerson,
    TooOld,
    /// This app is older than that OpenBot serves: the window offers this app's own update.
    AppTooOld,
    /// The same, for a minimum that OpenBot raised because of a security problem.
    AppTooOldSecurity,
    SignInCancelled,
    SignInFailed,
    /// Signed in, and then the OpenBot refused the new sign-in on the app's screens (401 or 403).
    AccessRefused,
    SessionEnded,
    CredentialStore,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::AddressInvalid => "address-invalid",
            Kind::Unreachable => "unreachable",
            Kind::NotOpenBot => "not-openbot",
            Kind::SinglePerson => "single-person",
            Kind::TooOld => "too-old",
            Kind::AppTooOld => crate::client_version::APP_TOO_OLD,
            Kind::AppTooOldSecurity => crate::client_version::APP_TOO_OLD_SECURITY,
            Kind::SignInCancelled => "sign-in-cancelled",
            Kind::SignInFailed => "sign-in-failed",
            Kind::AccessRefused => "access-refused",
            Kind::SessionEnded => "session-ended",
            Kind::CredentialStore => "credential-store",
        }
    }

    /// The sentence for the person. `host` is the OpenBot's, as they typed it.
    pub fn said(self, host: &str) -> String {
        match self {
            Kind::AddressInvalid => "That isn't an address OpenBot can connect to. Use one that \
                                     starts with https://, such as https://openbot.example.com."
                .into(),
            Kind::Unreachable => format!(
                "OpenBot couldn't reach {host}. Check the address and your network, then try again."
            ),
            Kind::NotOpenBot => format!(
                "There's no OpenBot at {host}. Check the address with whoever runs your OpenBot."
            ),
            Kind::SinglePerson => format!(
                "The OpenBot at {host} is set up for one person on its own computer, so the app \
                 can't connect to it."
            ),
            Kind::TooOld => format!(
                "The OpenBot at {host} is on a release this app can't connect to yet. Ask whoever \
                 runs it to update OpenBot, or open it in your browser."
            ),
            Kind::AppTooOld => format!(
                "The OpenBot at {host} needs a newer version of this app. Update OpenBot, then \
                 connect again."
            ),
            Kind::AppTooOldSecurity => crate::client_version::SECURITY_UPDATE.into(),
            Kind::SignInCancelled => "Sign-in didn't finish. Try again when you're ready.".into(),
            Kind::SignInFailed => format!(
                "OpenBot couldn't sign you in at {host}. Try again, or ask whoever runs your OpenBot."
            ),
            Kind::AccessRefused => format!(
                "You signed in, but the OpenBot at {host} didn't let this app in. Ask whoever runs \
                 it to give you access, then sign in again."
            ),
            Kind::SessionEnded => {
                format!("Your sign-in to {host} has ended. Sign in again to keep going.")
            }
            Kind::CredentialStore => if cfg!(windows) {
                "OpenBot couldn't save your sign-in on this computer. Check Windows Credential \
                 Manager, then try again."
            } else {
                "OpenBot couldn't save your sign-in on this computer. Unlock your keychain, then \
                 try again."
            }
            .into(),
        }
    }

    /// The problem the window is given: the sentence, this kind, and `detail` for the log. Never a
    /// token: callers pass a status, an error code or a transport error.
    pub fn problem(self, host: &str, detail: impl Into<String>) -> Problem {
        let mut problem = Problem::with(self.said(host), detail);
        problem.kind = Some(self.id());
        problem
    }
}

/// Which kind a problem from this module is, when it is one.
pub fn kind_of(problem: &Problem) -> Option<Kind> {
    [
        Kind::AddressInvalid,
        Kind::Unreachable,
        Kind::NotOpenBot,
        Kind::SinglePerson,
        Kind::TooOld,
        Kind::AppTooOld,
        Kind::AppTooOldSecurity,
        Kind::SignInCancelled,
        Kind::SignInFailed,
        Kind::AccessRefused,
        Kind::SessionEnded,
        Kind::CredentialStore,
    ]
    .into_iter()
    .find(|kind| problem.kind == Some(kind.id()))
}

/// The host of a normalised address, as the sentences name it: `openbot.example.com`, with its
/// port when it has one.
pub fn host_of(address: &str) -> String {
    reqwest::Url::parse(address)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_owned();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| address.to_owned())
}

/// A client for the few requests the shell itself makes to that OpenBot: short timeouts, a
/// redirect followed only while it stays on the same host, and this app named on every one
/// (`client_version`).
pub(crate) fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_host = attempt.previous().last().is_some_and(|from| {
                from.scheme() == attempt.url().scheme()
                    && from.host_str() == attempt.url().host_str()
                    && from.port_or_known_default() == attempt.url().port_or_known_default()
            });
            if same_host && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .user_agent("OpenBot/desktop")
        .default_headers(crate::client_version::headers())
        .build()
        .map_err(|error| error.to_string())
}

/// A transport error without the address's query, which a sign-in address carries a code in.
pub(crate) fn transport(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut said = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        said.push_str(": ");
        said.push_str(&inner.to_string());
        source = inner.source();
    }
    said
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window reads `kind` beside the sentence, and the sentences are the agreed ones.
    #[test]
    fn a_problem_carries_its_kind_and_the_agreed_sentence() {
        let problem = Kind::Unreachable.problem("openbot.example.com", "connection refused");
        let sent = serde_json::to_value(&problem).unwrap();
        assert_eq!(sent["kind"], "unreachable");
        assert_eq!(
            sent["said"],
            "OpenBot couldn't reach openbot.example.com. Check the address and your network, then try again."
        );
        assert_eq!(sent["detail"], "connection refused");
        assert_eq!(kind_of(&problem), Some(Kind::Unreachable));
        // A problem from anywhere else carries none, and reads as it always did.
        let plain = serde_json::to_value(Problem::plain("OpenBot has stopped.")).unwrap();
        assert!(plain.get("kind").is_none());
        assert_eq!(
            Kind::SessionEnded.said("openbot.example.com"),
            "Your sign-in to openbot.example.com has ended. Sign in again to keep going."
        );
        assert_eq!(
            Kind::TooOld.said("127.0.0.1:4000"),
            "The OpenBot at 127.0.0.1:4000 is on a release this app can't connect to yet. Ask whoever runs it to update OpenBot, or open it in your browser."
        );
        // This app too old for that OpenBot, as every OpenBot app says it (`shared/client-version.ts`).
        assert_eq!(
            Kind::AppTooOld.said("openbot.example.com"),
            "The OpenBot at openbot.example.com needs a newer version of this app. Update OpenBot, then connect again."
        );
        assert_eq!(
            Kind::AppTooOldSecurity.said("openbot.example.com"),
            "This version of OpenBot has a security problem. Update to keep using it."
        );
        let insecure = Kind::AppTooOldSecurity.problem("openbot.example.com", "security");
        assert_eq!(kind_of(&insecure), Some(Kind::AppTooOldSecurity));
        assert_eq!(
            serde_json::to_value(&insecure).unwrap()["kind"],
            "app-too-old-security"
        );
        let too_old = Kind::AppTooOld.problem("openbot.example.com", "minimum 1.2.0");
        assert_eq!(kind_of(&too_old), Some(Kind::AppTooOld));
        assert_eq!(
            serde_json::to_value(&too_old).unwrap()["kind"],
            "app-too-old"
        );
        let refused = Kind::AccessRefused.problem("openbot.example.com", "answered 403");
        assert_eq!(kind_of(&refused), Some(Kind::AccessRefused));
        assert_eq!(
            serde_json::to_value(&refused).unwrap()["kind"],
            "access-refused"
        );
        assert_eq!(
            refused.said,
            "You signed in, but the OpenBot at openbot.example.com didn't let this app in. Ask whoever runs it to give you access, then sign in again."
        );
    }

    #[test]
    fn the_host_is_named_with_its_port_when_it_has_one() {
        assert_eq!(
            host_of("https://openbot.example.com"),
            "openbot.example.com"
        );
        assert_eq!(host_of("http://127.0.0.1:4000"), "127.0.0.1:4000");
        assert_eq!(host_of("http://[::1]:4000"), "[::1]:4000");
    }
}
