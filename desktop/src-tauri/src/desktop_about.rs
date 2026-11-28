/*!
What About OpenBot says about where OpenBot runs: OpenBot (Self-Contained) on this computer, or
OpenBot Cloud, and the account the app is signed in to there.

Found in dogfooding: nothing in the app said which of the two it was, or which account it used on
OpenBot Cloud. The About box said only the version and the build.

The mode is the person's choice on record (`connection.json`, `desktop_connected::chosen`). The
account is asked of the OpenBot the app shows once its sign-in is live, the same way the move to
OpenBot Cloud asks which account it went into (`move_to_cloud::Api::account`), so the two say the
same email. The menus are built again once it answers (`desktop_connected::learn_account`).
*/

use openbot_desktop_lib::connected::{choice, host_of};

/// OpenBot Cloud's addresses: the one this app signs in to and talks to (`api.open.bot`), and the
/// one people open in a browser (`my.open.bot`). The setup window's `OPENBOT_CLOUD_URL` and
/// `OPENBOT_CLOUD_WEB_URL`.
const OPENBOT_CLOUD_HOSTS: [&str; 2] = ["api.open.bot", "my.open.bot"];

/// Where OpenBot runs for this app, as About says it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Runs {
    /// Not set up yet: the person is still choosing, and About says nothing about it.
    NotSetUp,
    /// OpenBot (Self-Contained): everything on this computer.
    SelfContained,
    /// Connected to OpenBot Cloud.
    Cloud,
    /// Connected to an OpenBot somewhere else, such as a company's own, by its host.
    Elsewhere(String),
}

/// Whether `address` is OpenBot Cloud.
pub fn is_openbot_cloud(address: &str) -> bool {
    reqwest::Url::parse(address)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| OPENBOT_CLOUD_HOSTS.contains(&host.as_str()))
}

/// Where OpenBot runs, from the choice on record and whether it is installed on this computer.
pub fn runs(chosen: &choice::Choice, installed_here: bool) -> Runs {
    match chosen.connected_to() {
        Some(address) if is_openbot_cloud(address) => Runs::Cloud,
        Some(address) => Runs::Elsewhere(host_of(address)),
        None if installed_here => Runs::SelfContained,
        None => Runs::NotSetUp,
    }
}

/// The lines About adds above the build: where OpenBot runs, and as whom when the app is signed in
/// to an OpenBot elsewhere and it has said.
pub fn lines(runs: &Runs, signed_in_as: Option<&str>) -> Vec<String> {
    let mode = match runs {
        Runs::NotSetUp => return Vec::new(),
        Runs::SelfContained => return vec!["OpenBot (Self-Contained)".to_owned()],
        Runs::Cloud => "OpenBot Cloud".to_owned(),
        Runs::Elsewhere(host) => format!("Connected to the OpenBot at {host}"),
    };
    let mut lines = vec![mode];
    if let Some(email) = signed_in_as
        .map(str::trim)
        .filter(|email| !email.is_empty())
    {
        lines.push(format!("Signed in as {email}"));
    }
    lines
}

/// About's lines for this app now.
pub fn lines_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    let chosen = crate::desktop_connected::chosen(app);
    let installed_here = chosen.connected_to().is_none() && {
        use tauri::Manager;
        let root = crate::cleanup_root(
            &app.state::<crate::Shell>(),
            &openbot_desktop_lib::stack::default_root(),
        );
        openbot_desktop_lib::deployment::installed(&root).is_some()
    };
    lines(
        &runs(&chosen, installed_here),
        crate::desktop_connected::signed_in_as(app).as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(address: &str) -> choice::Choice {
        choice::Choice {
            mode: choice::Mode::Connected,
            address: Some(address.to_owned()),
            organization_id: None,
        }
    }

    #[test]
    fn about_names_where_openbot_runs_and_as_whom() {
        let local = choice::Choice::default();
        assert_eq!(runs(&local, true), Runs::SelfContained);
        assert_eq!(runs(&local, false), Runs::NotSetUp);
        assert_eq!(runs(&connected("https://api.open.bot"), false), Runs::Cloud);
        assert_eq!(runs(&connected("https://my.open.bot"), true), Runs::Cloud);
        assert_eq!(
            runs(&connected("https://openbot.example.com:8443"), false),
            Runs::Elsewhere("openbot.example.com:8443".into())
        );
        // Back on this computer with Cloud's address remembered: Self-Contained.
        let back = choice::Choice {
            mode: choice::Mode::Local,
            ..connected("https://api.open.bot")
        };
        assert_eq!(runs(&back, true), Runs::SelfContained);
        // Only Cloud's own names: a lookalike is somewhere else.
        assert!(!is_openbot_cloud("https://api.open.bot.example.com"));
        assert!(!is_openbot_cloud("https://open.bot"));

        assert_eq!(
            lines(&Runs::SelfContained, None),
            ["OpenBot (Self-Contained)"]
        );
        assert_eq!(lines(&Runs::Cloud, None), ["OpenBot Cloud"]);
        assert_eq!(
            lines(&Runs::Cloud, Some(" sam@example.com ")),
            ["OpenBot Cloud", "Signed in as sam@example.com"]
        );
        assert_eq!(
            lines(
                &Runs::Elsewhere("openbot.example.com".into()),
                Some("sam@example.com")
            ),
            [
                "Connected to the OpenBot at openbot.example.com",
                "Signed in as sam@example.com"
            ]
        );
        assert!(lines(&Runs::NotSetUp, Some("sam@example.com")).is_empty());
        assert_eq!(lines(&Runs::Cloud, Some("  ")), ["OpenBot Cloud"]);
    }
}
