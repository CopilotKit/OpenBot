//! The address a person types, made into one the app can use, and checked to be an OpenBot this
//! app can connect to.
//!
//! Two questions are asked of the address, both public: what it offers
//! (`/api/v2/organizations/default/deployment`, which every OpenBot answers before sign-in) and
//! how an app signs in to it (its authorization server metadata, RFC 8414). What it offers says
//! whether this app is new enough for that OpenBot (`client_version`). Each way that can go wrong
//! is one `Kind`, so the window can say what to do next.

use super::{host_of, http, transport, Kind};
use crate::client_version;
use crate::problem::Problem;

/// What an OpenBot offers, which every OpenBot answers before sign-in. Read here, and of the OpenBot
/// on this computer (`client_version::local_problem`).
pub const DEPLOYMENT: &str = "/api/v2/organizations/default/deployment";
const METADATA: &str = "/.well-known/oauth-authorization-server/api/auth";
/// What keeps a sign-in going after its first hour: a refresh token.
const OFFLINE_ACCESS: &str = "offline_access";

/// How this app signs in to an OpenBot, as that OpenBot publishes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    /// Every scope it lists. The app's screens use the whole API, so all of them are asked for.
    pub scopes: Vec<String>,
}

/// `typed` as the app keeps it: scheme and host (and a port that is not the scheme's own), with
/// no path and no trailing slash. An address with no scheme is taken as `https://`. Only `https`,
/// except for this computer's own `127.0.0.1` and `[::1]`, where `http` is allowed.
pub fn normalise(typed: &str) -> Result<String, Problem> {
    let typed = typed.trim();
    let invalid = |why: &str| Kind::AddressInvalid.problem("", why.to_owned());
    if typed.is_empty() || typed.contains(char::is_whitespace) {
        return Err(invalid("no address, or one with a space in it"));
    }
    let with_scheme = if typed.contains("://") {
        typed.to_owned()
    } else {
        format!("https://{typed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|error| invalid(&error.to_string()))?;
    let host = url.host_str().filter(|host| !host.is_empty());
    let Some(host) = host else {
        return Err(invalid("no host"));
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("a name or password in the address"));
    }
    match url.scheme() {
        "https" => {}
        "http" if matches!(host, "127.0.0.1" | "[::1]") => {}
        "http" => return Err(invalid("http is only for 127.0.0.1 and [::1]")),
        other => return Err(invalid(&format!("the scheme {other}"))),
    }
    // A name needs a dot or to be an IP address: "openbot" alone is a word, not an address.
    let named = host.contains('.') || host.starts_with('[');
    if !named {
        return Err(invalid("a host with no dot in it"));
    }
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// Normalise `typed`, then ask the OpenBot there whether this app can connect to it. The answer is
/// the normalised address and how to sign in.
pub fn check(typed: &str) -> Result<(String, Metadata), Problem> {
    let address = normalise(typed)?;
    let metadata = probe(&address)?;
    Ok((address, metadata))
}

/// Ask a normalised `address` what it is and how an app signs in to it.
pub fn probe(address: &str) -> Result<Metadata, Problem> {
    let host = host_of(address);
    let client = http().map_err(|error| Kind::Unreachable.problem(&host, error))?;
    let get = |path: &str| {
        client
            .get(format!("{address}{path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|error| Kind::Unreachable.problem(&host, transport(error)))
    };

    let answered = get(DEPLOYMENT)?;
    let status = answered.status();
    let deployment = json_object(answered).filter(|_| status.is_success());
    let edition = deployment
        .as_ref()
        .and_then(|deployment| deployment.get("edition"))
        .and_then(serde_json::Value::as_str);
    let (Some(deployment), Some(edition)) = (deployment.as_ref(), edition) else {
        return Err(Kind::NotOpenBot.problem(
            &host,
            format!("GET {DEPLOYMENT} answered {status}, not as an OpenBot does"),
        ));
    };
    let on_its_own_computer = deployment
        .get("localEvaluation")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if on_its_own_computer {
        return Err(Kind::SinglePerson.problem(&host, "the deployment says localEvaluation"));
    }

    // Which API versions it serves and the oldest release of this app it serves, decided as every
    // OpenBot app decides it (`client_version`): asked when the person connects and on every
    // launch, so an OpenBot that raised its minimum past this app since is caught. One that serves
    // only an older API is told as an OpenBot this app can't connect to always was.
    match client_version::fit(deployment) {
        client_version::Fit::Ok => {}
        fit @ client_version::Fit::App { security, .. } => {
            let kind = if security {
                Kind::AppTooOldSecurity
            } else {
                Kind::AppTooOld
            };
            return Err(kind.problem(&host, client_version::why(deployment, &fit)));
        }
        fit @ client_version::Fit::Server => {
            return Err(Kind::TooOld.problem(&host, client_version::why(deployment, &fit)));
        }
    }

    let answered = get(METADATA)?;
    let status = answered.status();
    let Some(document) = json_object(answered).filter(|_| status.is_success()) else {
        // No sign-in for apps. A personal OpenBot has no sign-in at all; any other is a release
        // from before apps could sign in.
        let kind = if edition == "personal" {
            Kind::SinglePerson
        } else {
            Kind::TooOld
        };
        return Err(kind.problem(
            &host,
            format!("GET {METADATA} answered {status}; edition {edition}"),
        ));
    };
    metadata_from(address, &document).map_err(|why| Kind::TooOld.problem(&host, why))
}

fn json_object(
    response: reqwest::blocking::Response,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    match response.json::<serde_json::Value>().ok()? {
        serde_json::Value::Object(object) => Some(object),
        _ => None,
    }
}

/// The endpoints and scopes of a metadata document. Each endpoint has to be on the address itself:
/// the browser is sent to one and a code is posted to another, and neither goes anywhere but the
/// OpenBot the person typed.
fn metadata_from(
    address: &str,
    document: &serde_json::Map<String, serde_json::Value>,
) -> Result<Metadata, String> {
    let home = reqwest::Url::parse(address).map_err(|error| error.to_string())?;
    let endpoint = |name: &str| -> Result<Option<String>, String> {
        let Some(value) = document.get(name).and_then(serde_json::Value::as_str) else {
            return Ok(None);
        };
        let url = reqwest::Url::parse(value).map_err(|_| format!("{name} is not an address"))?;
        let same = url.scheme() == home.scheme()
            && url.host_str() == home.host_str()
            && url.port_or_known_default() == home.port_or_known_default()
            && url.username().is_empty()
            && url.password().is_none();
        if !same {
            return Err(format!("{name} is on another host than the address"));
        }
        Ok(Some(url.into()))
    };
    let scopes: Vec<String> = document
        .get("scopes_supported")
        .and_then(serde_json::Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|scope| scope.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if !scopes.iter().any(|scope| scope == OFFLINE_ACCESS) {
        return Err(format!("the metadata lists no {OFFLINE_ACCESS} scope"));
    }
    let supports_s256 = document
        .get("code_challenge_methods_supported")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|methods| methods.iter().any(|method| method == "S256"));
    if !supports_s256 {
        return Err("the metadata lists no S256 code challenge".into());
    }
    Ok(Metadata {
        authorization_endpoint: endpoint("authorization_endpoint")?
            .ok_or("the metadata names no authorization_endpoint")?,
        token_endpoint: endpoint("token_endpoint")?
            .ok_or("the metadata names no token_endpoint")?,
        revocation_endpoint: endpoint("revocation_endpoint")?,
        scopes,
    })
}

#[cfg(test)]
mod tests {
    use super::super::fake_openbot::{FakeOpenBot, Shape};
    use super::super::kind_of;
    use super::*;

    fn kind(typed: &str) -> Option<Kind> {
        kind_of(&check(typed).expect_err("refused"))
    }

    #[test]
    fn a_typed_address_is_kept_as_scheme_and_host() {
        for (typed, kept) in [
            ("https://openbot.example.com", "https://openbot.example.com"),
            (
                "  https://OpenBot.Example.com/  ",
                "https://openbot.example.com",
            ),
            (
                "https://openbot.example.com/settings/computer?x=1#top",
                "https://openbot.example.com",
            ),
            ("openbot.example.com", "https://openbot.example.com"),
            (
                "openbot.example.com:8443/",
                "https://openbot.example.com:8443",
            ),
            (
                "https://openbot.example.com:443",
                "https://openbot.example.com",
            ),
            ("http://127.0.0.1:4000/", "http://127.0.0.1:4000"),
            ("http://[::1]:4000", "http://[::1]:4000"),
        ] {
            assert_eq!(normalise(typed).as_deref(), Ok(kept), "{typed}");
        }
    }

    #[test]
    fn http_anywhere_but_this_computer_and_anything_that_is_no_address_are_refused() {
        for typed in [
            "",
            "   ",
            "openbot",
            "not an address",
            "http://openbot.example.com",
            "http://localhost:4000",
            "http://192.168.1.20:4000",
            "ftp://openbot.example.com",
            "file:///etc/hosts",
            "https://someone:secret@openbot.example.com",
            "https://",
        ] {
            let problem = normalise(typed).expect_err(typed);
            assert_eq!(kind_of(&problem), Some(Kind::AddressInvalid), "{typed}");
            assert_eq!(
                problem.said,
                "That isn't an address OpenBot can connect to. Use one that starts with https://, such as https://openbot.example.com."
            );
        }
    }

    #[test]
    fn an_openbot_this_app_can_sign_in_to_answers_its_address_and_how() {
        let openbot = FakeOpenBot::start(Shape::Current);
        let (address, metadata) = check(&format!("{}/some/page", openbot.address())).unwrap();
        assert_eq!(address, openbot.address());
        assert_eq!(
            metadata.authorization_endpoint,
            format!("{address}/api/auth/oauth2/authorize")
        );
        assert_eq!(
            metadata.token_endpoint,
            format!("{address}/api/auth/oauth2/token")
        );
        assert_eq!(
            metadata.revocation_endpoint,
            Some(format!("{address}/api/auth/oauth2/revoke"))
        );
        assert!(metadata
            .scopes
            .iter()
            .any(|scope| scope == "offline_access"));
        assert!(metadata.scopes.len() > 1);
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        // A port that was just free: bound, read, and let go.
        let _ports = crate::test_support::hold_ports();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let typed = format!("http://127.0.0.1:{port}");
        let problem = check(&typed).expect_err("nothing is there");
        assert_eq!(kind_of(&problem), Some(Kind::Unreachable));
        assert_eq!(
            problem.said,
            format!("OpenBot couldn't reach 127.0.0.1:{port}. Check the address and your network, then try again.")
        );
    }

    #[test]
    fn a_web_page_and_json_that_is_not_openbots_are_not_an_openbot() {
        for shape in [Shape::WebPage, Shape::OtherJson] {
            let server = FakeOpenBot::start(shape.clone());
            assert_eq!(kind(&server.address()), Some(Kind::NotOpenBot), "{shape:?}");
        }
    }

    #[test]
    fn an_openbot_for_one_person_on_its_own_computer_is_said_to_be_one() {
        for shape in [Shape::LocalEvaluation, Shape::Personal] {
            let server = FakeOpenBot::start(shape.clone());
            assert_eq!(
                kind(&server.address()),
                Some(Kind::SinglePerson),
                "{shape:?}"
            );
        }
    }

    #[test]
    fn an_openbot_from_before_apps_could_sign_in_is_too_old() {
        let server = FakeOpenBot::start(Shape::NoMetadata);
        assert_eq!(kind(&server.address()), Some(Kind::TooOld));
    }

    /// The fixture's real answers (`shared/fixtures/client-version/cases.json`), as this release's
    /// app reads them through the real HTTP path. An OpenBot of this release, and one of 1.1.0
    /// (which publishes no version fields), connect. One whose admin raised the oldest app it
    /// serves above this one, and one that serves only a newer API, say "Update OpenBot", and the
    /// app asks nothing more of them.
    #[test]
    fn an_openbot_this_app_is_too_old_for_says_update_openbot_and_the_rest_connect() {
        let _version = crate::client_version::as_version("1.1.0");
        for name in ["current", "v1.1.0"] {
            let server = FakeOpenBot::start(Shape::Answers(name));
            let (address, metadata) = check(&server.address()).unwrap_or_else(|problem| {
                panic!("{name}: {problem:?}");
            });
            assert_eq!(address, server.address(), "{name}");
            assert!(metadata
                .scopes
                .iter()
                .any(|scope| scope == "offline_access"));
        }
        for name in ["raised", "v3-only"] {
            let server = FakeOpenBot::start(Shape::Answers(name));
            let problem = check(&server.address()).expect_err(name);
            assert_eq!(kind_of(&problem), Some(Kind::AppTooOld), "{name}");
            assert_eq!(
                problem.said,
                format!(
                    "The OpenBot at {} needs a newer version of this app. Update OpenBot, then connect again.",
                    host_of(&server.address())
                ),
                "{name}"
            );
            assert!(server.seen_at(METADATA).is_empty(), "{name}");
        }
        // One that raised this app's minimum for a security problem says so instead, and offers the
        // same update.
        let security = FakeOpenBot::start(Shape::Answers("security"));
        let problem = check(&security.address()).expect_err("security");
        assert_eq!(kind_of(&problem), Some(Kind::AppTooOldSecurity));
        assert_eq!(
            problem.said,
            "This version of OpenBot has a security problem. Update to keep using it."
        );
        assert_eq!(
            problem.detail.as_deref(),
            Some("the deployment's minimumClients.desktop is 1.2.0, raised for a security problem (securityMinimumClients); this app is desktop/1.1.0 and speaks v2")
        );
        assert!(security.seen_at(METADATA).is_empty());
        // What the log says beside the sentence: what that OpenBot asked for, against this app.
        let raised = FakeOpenBot::start(Shape::Answers("raised"));
        let problem = check(&raised.address()).expect_err("raised");
        assert_eq!(
            problem.detail.as_deref(),
            Some("the deployment's minimumClients.desktop is 1.2.0; this app is desktop/1.1.0 and speaks v2")
        );
    }

    /// The check runs on every launch while connected (`probe`, before the saved sign-in is used),
    /// not only when the person connects: an OpenBot that raised its minimum past the app since,
    /// as OpenBot Cloud does, is caught the next time the app opens.
    #[test]
    fn the_launch_check_catches_an_openbot_that_moved_since_the_app_connected() {
        let _version = crate::client_version::as_version("1.1.0");
        for (name, kind) in [
            ("raised", Kind::AppTooOld),
            ("v3-only", Kind::AppTooOld),
            ("security", Kind::AppTooOldSecurity),
        ] {
            let server = FakeOpenBot::start(Shape::Answers(name));
            let problem = probe(&server.address()).expect_err(name);
            assert_eq!(kind_of(&problem), Some(kind), "{name}");
        }
    }

    /// The browser is sent to the authorization endpoint and the code is posted to the token
    /// endpoint. Metadata that names another host for either is not followed there.
    #[test]
    fn metadata_that_names_another_host_is_not_followed() {
        let server = FakeOpenBot::start(Shape::MetadataElsewhere);
        assert_eq!(kind(&server.address()), Some(Kind::TooOld));
    }

    /// A redirect to another host is not followed: the answer is read from the address typed.
    #[test]
    fn a_redirect_to_another_host_is_not_followed() {
        let real = FakeOpenBot::start(Shape::Current);
        let front = FakeOpenBot::start(Shape::RedirectsTo(real.address()));
        assert_eq!(kind(&front.address()), Some(Kind::NotOpenBot));
        assert_eq!(real.requests(), Vec::<String>::new());
    }
}
