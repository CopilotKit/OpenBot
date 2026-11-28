use super::*;

/// Podman as Windows Installer registered it on a Windows box OpenBot 1.1.2 set up.
fn installed_by_openbot() -> Registration {
    Registration {
        name: "Podman CLI".into(),
        uninstall: "MsiExec.exe /X{4C417685-0B46-4DA6-AD48-61F93BCC5066}".into(),
        install_source: Some(r"C:\Users\Administrator\OpenBot\openbot-engine\".into()),
    }
}

fn downloads() -> Vec<PathBuf> {
    vec![PathBuf::from(
        r"C:\Users\Administrator\OpenBot\openbot-engine",
    )]
}

fn only_openbot() -> Users {
    Users {
        machines: vec!["openbot".into()],
        connections: vec!["openbot".into(), "openbot-root".into()],
        podman_desktop: false,
    }
}

const PRODUCT: &str = "{4C417685-0B46-4DA6-AD48-61F93BCC5066}";

#[test]
fn podman_openbot_installed_and_only_openbot_uses_goes_with_it() {
    assert_eq!(
        judge(
            &[installed_by_openbot()],
            Ok(only_openbot()),
            &downloads(),
            false
        ),
        Verdict::Ours {
            product: PRODUCT.into()
        }
    );
    // Recorded with other case, forward slashes, no trailing separator: the same folder.
    let mut recorded = installed_by_openbot();
    recorded.install_source = Some("c:/users/administrator/openbot/OPENBOT-ENGINE".into());
    assert!(matches!(
        judge(&[recorded], Ok(only_openbot()), &downloads(), false),
        Verdict::Ours { .. }
    ));
}

#[test]
fn podman_installed_by_anyone_else_stays() {
    let mut theirs = installed_by_openbot();
    theirs.install_source = Some(r"C:\Users\Administrator\Downloads\".into());
    assert!(matches!(
        judge(&[theirs], Ok(only_openbot()), &downloads(), false),
        Verdict::Kept { .. }
    ));
    let mut unknown = installed_by_openbot();
    unknown.install_source = None;
    assert!(matches!(
        judge(&[unknown], Ok(only_openbot()), &downloads(), false),
        Verdict::Kept { .. }
    ));
    assert!(matches!(
        judge(&[], Ok(only_openbot()), &downloads(), false),
        Verdict::Kept { .. }
    ));
}

#[test]
fn podman_anything_else_uses_stays() {
    let desktop = Registration {
        name: "Podman Desktop 1.20.0".into(),
        uninstall:
            r#""C:\Users\a\AppData\Local\Programs\podman-desktop\Uninstall Podman Desktop.exe""#
                .into(),
        install_source: None,
    };
    assert!(matches!(
        judge(
            &[installed_by_openbot(), desktop],
            Ok(only_openbot()),
            &downloads(),
            false
        ),
        Verdict::Kept { .. }
    ));

    let cases = [
        Users {
            podman_desktop: true,
            ..only_openbot()
        },
        Users {
            machines: vec!["openbot".into(), "podman-machine-default".into()],
            ..only_openbot()
        },
        Users {
            connections: vec!["openbot".into(), "mine".into()],
            ..only_openbot()
        },
    ];
    for users in cases {
        assert!(
            matches!(
                judge(
                    &[installed_by_openbot()],
                    Ok(users.clone()),
                    &downloads(),
                    false
                ),
                Verdict::Kept { .. }
            ),
            "{users:?}"
        );
    }
    // What uses it couldn't be read: it stays.
    assert!(matches!(
        judge(
            &[installed_by_openbot()],
            Err("podman machine list failed".into()),
            &downloads(),
            false
        ),
        Verdict::Kept { .. }
    ));
}

#[test]
fn podman_is_never_removed_from_under_openbots_own_machine() {
    // Judged for removal, after OpenBot's machine should be gone: still listed, Podman stays.
    assert!(matches!(
        judge(
            &[installed_by_openbot()],
            Ok(only_openbot()),
            &downloads(),
            true
        ),
        Verdict::Kept { .. }
    ));
    assert!(matches!(
        judge(
            &[installed_by_openbot()],
            Ok(Users::default()),
            &downloads(),
            true
        ),
        Verdict::Ours { .. }
    ));
}

#[test]
fn product_codes_are_read_from_the_uninstall_string() {
    assert_eq!(
        product_code("MsiExec.exe /X{4C417685-0B46-4DA6-AD48-61F93BCC5066}").as_deref(),
        Some(PRODUCT)
    );
    assert_eq!(product_code("MsiExec.exe /X{not-a-guid}"), None);
    assert_eq!(product_code(r#""C:\x\Uninstall.exe""#), None);
}

#[test]
fn what_uses_podman_is_read_from_its_listings() {
    let users = users_in(
        r#"[{"Name":"openbot","Running":false},{"Name":"mine","Running":true}]"#,
        r#"[{"Name":"openbot","Default":false},{"Name":"mine","Default":true}]"#,
        false,
    )
    .unwrap();
    assert_eq!(users.machines, ["openbot", "mine"]);
    assert_eq!(users.connections, ["openbot", "mine"]);
    // Podman 6.1.1 on Windows lists no machines as `[]`.
    assert_eq!(users_in("[]", "[]", false).unwrap(), Users::default());
    assert!(users_in("", "[]", false).is_err());
}

/// A computer that records what is done to it.
struct Fake {
    registrations: Vec<Registration>,
    users: Result<Users, String>,
    usermode: bool,
    unregister: Result<(), String>,
    uninstall: Result<(), String>,
    done: Vec<String>,
}

impl Fake {
    fn openbots(users: Users) -> Fake {
        Fake {
            registrations: vec![installed_by_openbot()],
            users: Ok(users),
            usermode: true,
            unregister: Ok(()),
            uninstall: Ok(()),
            done: Vec::new(),
        }
    }
}

impl Computer for Fake {
    fn registrations(&mut self) -> Vec<Registration> {
        self.registrations.clone()
    }
    fn users(&mut self) -> Result<Users, String> {
        self.users.clone()
    }
    fn distribution(&mut self, name: &str) -> Option<PathBuf> {
        (self.usermode && name == USERMODE)
            .then(|| PathBuf::from(r"C:\wsldist\podman-net-usermode"))
    }
    fn program_folder(&mut self) -> Option<PathBuf> {
        Some(PathBuf::from(r"C:\Programs\Podman"))
    }
    fn unregister(&mut self, distribution: &str) -> Result<(), String> {
        self.done.push(format!("wsl --unregister {distribution}"));
        self.unregister.clone()
    }
    fn uninstall(&mut self, product: &str) -> Result<(), String> {
        self.done.push(format!("msiexec /x {product}"));
        self.uninstall.clone()
    }
}

#[test]
fn removing_unregisters_the_helper_then_uninstalls_podman() {
    let mut computer = Fake::openbots(Users::default());
    assert!(remove(&mut computer, &downloads()).is_empty());
    assert_eq!(
        computer.done,
        [
            format!("wsl --unregister {USERMODE}"),
            format!("msiexec /x {PRODUCT}")
        ]
    );
}

#[test]
fn a_podman_that_stays_is_left_untouched_and_unmentioned() {
    let mut used = Fake::openbots(Users {
        machines: vec!["podman-machine-default".into()],
        ..Users::default()
    });
    assert!(remove(&mut used, &downloads()).is_empty());
    assert!(used.done.is_empty());

    let mut machine_left = Fake::openbots(only_openbot());
    assert!(remove(&mut machine_left, &downloads()).is_empty());
    assert!(machine_left.done.is_empty());

    assert!(parts(&mut used, &downloads()).is_empty());
}

#[test]
fn a_failed_uninstall_says_what_stayed() {
    let mut computer = Fake::openbots(Users::default());
    computer.uninstall = Err("exit Some(1603)".into());
    assert_eq!(remove(&mut computer, &downloads()), [LEFT_BEHIND]);
    let mut computer = Fake::openbots(Users::default());
    computer.unregister = Err("exit Some(1)".into());
    assert_eq!(remove(&mut computer, &downloads()), [LEFT_BEHIND]);
}

#[test]
fn what_podman_takes_is_counted_only_when_it_goes() {
    let mut computer = Fake::openbots(only_openbot());
    assert_eq!(
        parts(&mut computer, &downloads()),
        [
            PathBuf::from(r"C:\Programs\Podman"),
            PathBuf::from(r"C:\wsldist\podman-net-usermode")
        ]
    );
}

/// Podman's registration as Windows keeps it, in both of the places a Windows box had it: Installed
/// apps' `Uninstall\{code}` and Windows Installer's `UserData\<SID>\Products\<packed>\InstallProperties`.
/// Read once, beside Podman Desktop's and an app that isn't Podman.
#[cfg(target_os = "windows")]
#[test]
fn podmans_registration_is_read_from_the_registry() {
    use windows_registry::CURRENT_USER;

    let base = format!(r"Software\OpenBot\Tests\OwnPodman-{}", std::process::id());
    let write = |path: &str, values: &[(&str, &str)]| {
        let key = CURRENT_USER.create(format!(r"{base}\{path}")).unwrap();
        for (name, value) in values {
            key.set_string(name, value).unwrap();
        }
    };
    let podman = [
        ("DisplayName", "Podman CLI"),
        (
            "UninstallString",
            "MsiExec.exe /X{4C417685-0B46-4DA6-AD48-61F93BCC5066}",
        ),
        (
            "InstallSource",
            r"C:\Users\Administrator\OpenBot\openbot-engine\",
        ),
    ];
    write(r"Uninstall\{4C417685-0B46-4DA6-AD48-61F93BCC5066}", &podman);
    write(
        r"Uninstall\Podman Desktop",
        &[
            ("DisplayName", "Podman Desktop 1.20.0"),
            ("UninstallString", r#""C:\pd\Uninstall Podman Desktop.exe""#),
        ],
    );
    write(r"Uninstall\Other", &[("DisplayName", "Something else")]);
    write(
        r"UserData\S-1-5-21-1\Products\586714C464B06AD4DA84169FB3CC0566\InstallProperties",
        &podman,
    );

    let uninstall = [CURRENT_USER.open(format!(r"{base}\Uninstall")).unwrap()];
    let user_data = CURRENT_USER.open(format!(r"{base}\UserData")).unwrap();
    let found = registered_in(&uninstall, Some(&user_data));
    let _ = CURRENT_USER.remove_tree(&base);

    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found.contains(&installed_by_openbot()), "{found:?}");
    assert!(found.iter().any(is_podman_desktop), "{found:?}");
}
