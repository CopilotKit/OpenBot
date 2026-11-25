/*!
Which OpenBot app this is, said on every request the shell makes to an OpenBot, and whether this app
and the OpenBot it talks to can work together.

Every OpenBot app names itself in `OpenBot-Client: <kind>/<version>`, and every OpenBot says on its
`deployment` which API versions it serves and the oldest release of each app it still serves. When
this app is too old for that OpenBot, the person reads "Update OpenBot" and is offered this app's
update. An OpenBot too old for this app is told as it always was (`connected::Kind::TooOld`).

The rules are `shared/client-version.ts`'s, carried here in Rust. The tests hold them to every case
in `shared/fixtures/client-version/cases.json`, the same cases the web app, the Recorder and
OpenBot Mobile run.
*/

use crate::problem::Problem;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::sync::OnceLock;

/// The request header an app names itself in.
pub const HEADER: &str = "OpenBot-Client";

/// What this app is called in that header.
pub const KIND: &str = "desktop";

/// The API versions this app speaks.
pub const API_VERSIONS: &[&str] = &["v2"];

/// The `kind` a problem carries when this app is too old for the OpenBot it talks to. The window
/// offers this app's own update for it, wherever it shows.
pub const APP_TOO_OLD: &str = "app-too-old";

/// The `kind` for the same when the minimum this app is below was raised because of a security
/// problem in older releases. The window offers the same update and says [`SECURITY_UPDATE`].
pub const APP_TOO_OLD_SECURITY: &str = "app-too-old-security";

/// What the person reads in place of "Update OpenBot" when the minimum was raised for a security
/// problem (`shared/client-version.ts` `SECURITY_UPDATE_SENTENCE`).
pub const SECURITY_UPDATE: &str =
    "This version of OpenBot has a security problem. Update to keep using it.";

static VERSION: OnceLock<String> = OnceLock::new();

/**
The version this app was packaged as: the one the installer, the update check and About name. Set
once at launch from the Tauri configuration (`package_info`), which is the root package.json's
version, or an internal build's own. Until then, and in a process that never starts the app (the
Recorder's native host), Cargo's, which names the same release for every released build.
*/
pub fn set_app_version(version: impl Into<String>) {
    let _ = VERSION.set(version.into());
}

/// This app's version, as it names itself.
pub fn app_version() -> String {
    #[cfg(test)]
    if let Some(version) = TEST_VERSION.with(|version| version.borrow().clone()) {
        return version;
    }
    VERSION
        .get()
        .cloned()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
}

/// `desktop/<version>`, as this app sends it.
pub fn token() -> String {
    format!("{KIND}/{}", app_version())
}

fn header_name() -> HeaderName {
    HeaderName::from_static("openbot-client")
}

/// The header, for a client every request of which goes to an OpenBot.
pub fn headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&token()) {
        headers.insert(header_name(), value);
    }
    headers
}

/**
The header the relay passes on: the one the window's page sent, with this app added after it, as a
User-Agent lists the programs a request went through. `shared/client-version.ts` reads every name in
it. When the page sent none, this app alone.
*/
pub fn added_to(sent: &HeaderMap) -> Option<HeaderValue> {
    let page: Vec<&str> = sent
        .get_all(header_name())
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    let mine = token();
    let joined = if page.is_empty() {
        mine
    } else {
        format!("{} {mine}", page.join(" "))
    };
    HeaderValue::from_str(&joined).ok()
}

/// Whether an app and the OpenBot it talks to can work together.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fit {
    /// They can. Features that OpenBot lacks are hidden by the fields that offer them.
    Ok,
    /// The app is too old: that OpenBot serves only newer API versions, or names a minimum for
    /// this app above its version (`minimum`). "Update OpenBot". `security` when it also names this
    /// app in `securityMinimumClients` above its version: the minimum is there for a security
    /// problem, and the person reads [`SECURITY_UPDATE`] instead.
    App {
        minimum: Option<String>,
        security: bool,
    },
    /// That OpenBot is too old: it serves only API versions older than any the app speaks.
    Server,
}

/// An OpenBot's `deployment`, as it answered it.
pub type Deployment = serde_json::Map<String, serde_json::Value>;

/// The major of an API version, `v2` as 2.
fn major(version: &str) -> Option<u32> {
    let digits = version.strip_prefix('v')?;
    (!digits.is_empty() && digits.len() <= 4 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// A release number's parts: `1.2.0-rc.1` as (1, 2, 0) and `rc.1`, with or without a leading v.
fn release(value: &str) -> Option<([u64; 3], Option<&str>)> {
    let value = value.strip_prefix('v').unwrap_or(value);
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (value, None),
    };
    if let Some(pre) = pre {
        let allowed = |b: u8| b.is_ascii_alphanumeric() || b == b'.' || b == b'-';
        if pre.is_empty() || pre.len() > 64 || !pre.bytes().all(allowed) {
            return None;
        }
    }
    let mut parts = [0u64; 3];
    let mut pieces = core.split('.');
    for part in &mut parts {
        let piece = pieces.next()?;
        if piece.is_empty() || piece.len() > 6 || !piece.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *part = piece.parse().ok()?;
    }
    pieces.next().is_none().then_some((parts, pre))
}

/// Whether `value` is a release number: `1.2.0`, `1.2.0-rc.1`, with or without a leading v.
pub fn is_version(value: &str) -> bool {
    release(value).is_some()
}

/**
Release order, by semantic versioning's rules (semver.org, section 11): numbers first, and a
pre-release (`1.2.0-rc.1`) before its release. None when either is not a release number.
*/
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    let (left, left_pre) = release(a)?;
    let (right, right_pre) = release(b)?;
    let order = left.cmp(&right);
    if order != Ordering::Equal {
        return Some(order);
    }
    Some(match (left_pre, right_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => {
            let (mut left, mut right) = (left.split('.'), right.split('.'));
            loop {
                match (left.next(), right.next()) {
                    (None, None) => break Ordering::Equal,
                    (None, Some(_)) => break Ordering::Less,
                    (Some(_), None) => break Ordering::Greater,
                    (Some(l), Some(r)) => {
                        let number = |s: &str| {
                            (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                                .then(|| s.parse::<u64>().ok())
                                .flatten()
                        };
                        let order = match (number(l), number(r)) {
                            (Some(l), Some(r)) => l.cmp(&r),
                            (Some(_), None) => Ordering::Less,
                            (None, Some(_)) => Ordering::Greater,
                            (None, None) => l.cmp(r),
                        };
                        if order != Ordering::Equal {
                            break order;
                        }
                    }
                }
            }
        }
    })
}

/**
Whether an app of `kind` at `version`, speaking `speaks`, and the OpenBot that answered `deployment`
can work together. A `deployment` that publishes no `api` is from a release before it was
published, and every such release that answers `deployment` serves v2.
*/
pub fn compatibility(deployment: &Deployment, kind: &str, version: &str, speaks: &[&str]) -> Fit {
    let served: Vec<&str> = match deployment.get("api") {
        Some(serde_json::Value::Array(api)) => {
            api.iter().filter_map(serde_json::Value::as_str).collect()
        }
        _ => vec!["v2"],
    };
    if !served.iter().any(|version| speaks.contains(version)) {
        // None is below every major, as an empty list's largest is.
        let newest_served = served.iter().filter_map(|v| major(v)).max();
        let newest_spoken = speaks.iter().filter_map(|v| major(v)).max();
        // Only newer versions than any the app speaks: the app is behind. Otherwise the server is.
        return if newest_served > newest_spoken {
            Fit::App {
                minimum: None,
                security: false,
            }
        } else {
            Fit::Server
        };
    }
    let below = |field: &str| {
        deployment
            .get(field)
            .and_then(serde_json::Value::as_object)
            .and_then(|minimums| minimums.get(kind))
            .and_then(serde_json::Value::as_str)
            .filter(|minimum| is_version(minimum))
            .filter(|minimum| compare_versions(version, minimum) == Some(std::cmp::Ordering::Less))
    };
    match below("minimumClients") {
        Some(minimum) => Fit::App {
            minimum: Some(minimum.to_owned()),
            security: below("securityMinimumClients").is_some(),
        },
        None => Fit::Ok,
    }
}

/// [`compatibility`] for this app.
pub fn fit(deployment: &Deployment) -> Fit {
    compatibility(deployment, KIND, &app_version(), API_VERSIONS)
}

/// Why it doesn't fit, for the log: what that OpenBot said, against this app.
pub fn why(deployment: &Deployment, fit: &Fit) -> String {
    let this = format!(
        "this app is {} and speaks {}",
        token(),
        API_VERSIONS.join(", ")
    );
    let served = deployment
        .get("api")
        .map_or_else(|| "no api (v2)".to_owned(), |api| format!("api {api}"));
    match fit {
        Fit::App {
            minimum: Some(minimum),
            security: true,
        } => format!(
            "the deployment's minimumClients.{KIND} is {minimum}, raised for a security problem \
             (securityMinimumClients); {this}"
        ),
        Fit::App {
            minimum: Some(minimum),
            ..
        } => format!("the deployment's minimumClients.{KIND} is {minimum}; {this}"),
        _ => format!("the deployment says {served}; {this}"),
    }
}

/// What the person reads when the OpenBot on this computer needs a newer version of this app.
pub const LOCAL_APP_TOO_OLD: &str =
    "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.";

/// The OpenBot on this computer needs a newer version of this app, for `why` in the log: whether its
/// `deployment` said so, or its release needs a launcher contract this app does not speak
/// (`deployment_release::start_problem`). The window says "Update OpenBot" with this app's update.
pub fn local_app_too_old(why: String) -> Problem {
    let mut problem = Problem::with(LOCAL_APP_TOO_OLD, why);
    problem.kind = Some(APP_TOO_OLD);
    problem
}

/**
Whether the OpenBot on this computer, at `base` (`http://127.0.0.1:<port>` of its server), needs a
newer version of this app: its `deployment` read the way every app reads it, with the install's
token when it has one. Only that is a problem. An OpenBot from an older release, one that answers
no `deployment`, or one that does not answer at all, starts and opens exactly as before: Start
upgrades an older one, and a missing answer is the readiness check's to report, not this one's.
*/
pub fn local_problem(base: &str, install_token: Option<&str>) -> Option<Problem> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(headers())
        .build()
        .ok()?;
    let mut request = client
        .get(format!(
            "{}{}",
            base.trim_end_matches('/'),
            crate::connected::address::DEPLOYMENT
        ))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = install_token.filter(|token| !token.trim().is_empty()) {
        request = request.header(crate::install_token::HEADER, token);
    }
    let answered = request.send().ok()?;
    if !answered.status().is_success() {
        return None;
    }
    let serde_json::Value::Object(deployment) = answered.json::<serde_json::Value>().ok()? else {
        return None;
    };
    let decided = fit(&deployment);
    let Fit::App { security, .. } = decided else {
        return None;
    };
    let why = why(&deployment, &decided);
    if !security {
        return Some(local_app_too_old(why));
    }
    let mut problem = Problem::with(SECURITY_UPDATE, why);
    problem.kind = Some(APP_TOO_OLD_SECURITY);
    Some(problem)
}

#[cfg(test)]
thread_local! {
    static TEST_VERSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// This app is `version` on this thread until the guard goes, so a test reads the fixture's real
/// answers against the release they were written for, whatever this build's version is.
#[cfg(test)]
pub(crate) fn as_version(version: &str) -> impl Drop {
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let earlier = self.0.take();
            TEST_VERSION.with(|version| *version.borrow_mut() = earlier);
        }
    }
    let earlier = TEST_VERSION.with(|current| current.borrow_mut().replace(version.to_owned()));
    Restore(earlier)
}

/// The shared fixture: real deployment answers, and what each app decides from them.
#[cfg(test)]
pub(crate) const CASES: &str = include_str!("../../../shared/fixtures/client-version/cases.json");

/// One of the fixture's real deployment answers, by name.
#[cfg(test)]
pub(crate) fn fixture_deployment(name: &str) -> serde_json::Value {
    let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
    let found = cases["deployments"][name].clone();
    assert!(found.is_object(), "the fixture has no deployment {name}");
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every case the shared fixture lists, decided as `shared/client-version.ts` decides it.
    #[test]
    fn every_case_in_the_shared_fixture_is_decided_as_the_contract_says() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        let list = cases["cases"].as_array().unwrap();
        assert!(list.len() >= 19, "the fixture lost its cases");
        for case in list {
            let name = case["deployment"].as_str().unwrap();
            let client = &case["client"];
            let speaks: Vec<&str> = client["speaks"]
                .as_array()
                .map(|speaks| speaks.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_else(|| API_VERSIONS.to_vec());
            let deployment = cases["deployments"][name].as_object().unwrap();
            let decided = compatibility(
                deployment,
                client["kind"].as_str().unwrap(),
                client["version"].as_str().unwrap(),
                &speaks,
            );
            let expected = match case["fit"].as_str().unwrap() {
                "ok" => Fit::Ok,
                "server" => Fit::Server,
                "app" => Fit::App {
                    minimum: case["minimum"].as_str().map(str::to_owned),
                    security: case["security"].as_bool().unwrap_or(false),
                },
                other => panic!("an unknown fit {other}"),
            };
            assert_eq!(decided, expected, "{case}");
        }
    }

    /// Release order as semver.org section 11 has it, which the TypeScript rule follows.
    #[test]
    fn releases_are_ordered_as_semantic_versioning_orders_them() {
        use std::cmp::Ordering::*;
        for (a, b, order) in [
            ("1.0.2", "1.0.2", Equal),
            ("v1.0.2", "1.0.2", Equal),
            ("1.0.1", "1.0.2", Less),
            ("1.10.0", "1.9.9", Greater),
            ("1.0.2-rc.3", "1.0.2", Less),
            ("1.0.0-alpha", "1.0.0-alpha.1", Less),
            ("1.0.0-alpha.1", "1.0.0-alpha.beta", Less),
            ("1.0.0-alpha.beta", "1.0.0-beta", Less),
            ("1.0.0-beta.2", "1.0.0-beta.11", Less),
            ("1.0.0-rc.1", "1.0.0", Less),
            ("1.1.0-internal.892.g0c140734ecf0", "1.1.0", Less),
        ] {
            assert_eq!(compare_versions(a, b), Some(order), "{a} {b}");
        }
        for not_a_release in [
            "",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "1.2.3-",
            "1234567.0.0",
            "1.2.3-a b",
        ] {
            assert!(!is_version(not_a_release), "{not_a_release}");
            assert_eq!(compare_versions(not_a_release, "1.0.0"), None);
        }
    }

    /// The OpenBot on this computer, read as every app reads it, through the real HTTP path with
    /// the fixture's real answers. Only an OpenBot that needs a newer app is a problem: one of this
    /// release, one left at 1.1.0 (no version fields) and one that is not answering all start and
    /// open as before, with no sentence.
    #[test]
    fn the_openbot_on_this_computer_says_update_openbot_only_when_it_needs_a_newer_app() {
        use crate::connected::fake_openbot::{FakeOpenBot, Shape};
        let _version = as_version("1.1.0");
        let plain = Some((
            APP_TOO_OLD,
            "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
        ));
        let security = Some((
            APP_TOO_OLD_SECURITY,
            "This version of OpenBot has a security problem. Update to keep using it.",
        ));
        for (shape, said) in [
            (Shape::Answers("raised"), plain),
            (Shape::Answers("v3-only"), plain),
            (Shape::Answers("security"), security),
            (Shape::Answers("current"), None),
            (Shape::Answers("v1.1.0"), None),
        ] {
            let server = FakeOpenBot::start(shape.clone());
            let problem = local_problem(&server.address(), Some("install-token-abc"));
            assert_eq!(
                problem
                    .as_ref()
                    .map(|problem| (problem.kind.unwrap(), problem.said.as_str())),
                said,
                "{shape:?}: {problem:?}"
            );
            let asked = server.seen_at(crate::connected::address::DEPLOYMENT);
            assert_eq!(asked.len(), 1, "{shape:?}");
            assert_eq!(asked[0].header("openbot-client"), Some("desktop/1.1.0"));
            assert_eq!(
                asked[0].header(crate::install_token::HEADER),
                Some("install-token-abc")
            );
        }
        // Nothing listening: the readiness check says that, not this.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(local_problem(&format!("http://127.0.0.1:{port}"), None).is_none());
    }

    /// The relay names this app after whatever the page named, and only this app when it named none.
    #[test]
    fn the_header_names_this_app_after_the_page() {
        let _version = as_version("1.1.0");
        assert_eq!(token(), "desktop/1.1.0");
        assert_eq!(headers()["openbot-client"], "desktop/1.1.0");
        let mut sent = HeaderMap::new();
        assert_eq!(added_to(&sent).unwrap(), "desktop/1.1.0");
        sent.insert(header_name(), HeaderValue::from_static("web/1.1.0"));
        assert_eq!(added_to(&sent).unwrap(), "web/1.1.0 desktop/1.1.0");
        sent.insert(header_name(), HeaderValue::from_static("  "));
        assert_eq!(added_to(&sent).unwrap(), "desktop/1.1.0");
    }
}
