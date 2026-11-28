/*!
Podman, removed with OpenBot when OpenBot installed it and nothing else on the computer uses it.

On Windows OpenBot installs Podman itself when there is none (`install::install_podman`): it
downloads Podman's MSI into its own downloads folder (`acquire::download_dir`) and runs it from
there. Windows Installer records that folder as the product's `InstallSource`, so Podman's own
registration says whether OpenBot installed it. On the two Windows boxes that moved to OpenBot Cloud,
"Podman CLI" was registered with `InstallSource` `C:\Users\Administrator\OpenBot\openbot-engine\`,
and what it left after OpenBot's machine was removed came to about 1 GB: its program folder (69 MB)
and the WSL distribution `podman-net-usermode` (949 MB), the helper Podman makes for a machine's
user-mode networking.

So moving to OpenBot Cloud removes Podman too, but only when all of these hold:

- Podman's registration names one of OpenBot's downloads folders as where it was installed from.
  A Podman the person installed, or one Podman Desktop installed, came from somewhere else and stays.
- Podman Desktop isn't installed: it runs on that Podman.
- Podman lists no machine and no connection but OpenBot's own. Somebody who made a machine of their
  own uses Podman, whoever installed it. And when the lists can't be read, Podman stays.

Removing it is the uninstall Windows would run (`msiexec /x`), after `podman-net-usermode` is
unregistered from WSL, and only once OpenBot's own machine is gone. Never on a Mac or Linux: there
OpenBot asks the system to install Podman, and removing it would ask for the password again.
*/

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::acquire::MACHINE;

/// The WSL distribution Podman makes for a machine's user-mode networking, shared by every machine.
pub const USERMODE: &str = "podman-net-usermode";

/// What the person reads when Podman stays behind. "Podman" is named here, unlike in setup: it is
/// the name they look for in Installed apps.
pub const LEFT_BEHIND: &str =
    "Couldn't remove Podman, the software OpenBot ran on. You can remove \
     it in Windows Settings under Installed apps.";

/// A product Windows Installer has registered, as Installed apps lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    /// `DisplayName`: "Podman CLI", "Podman Desktop".
    pub name: String,
    /// `UninstallString`: `MsiExec.exe /X{product code}`.
    pub uninstall: String,
    /// `InstallSource`: the folder the MSI was run from.
    pub install_source: Option<String>,
}

/// What uses Podman on this computer, besides OpenBot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Users {
    /// Every machine `podman machine list` lists.
    pub machines: Vec<String>,
    /// Every connection `podman system connection list` lists.
    pub connections: Vec<String>,
    /// Podman Desktop is installed.
    pub podman_desktop: bool,
}

/// Whether Podman goes with OpenBot, and if not, why not (for the log).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ours { product: String },
    Kept { why: String },
}

/// What removing Podman needs of a computer, so the rules and the order are tested without one.
pub trait Computer {
    /// Every product Windows Installer has registered whose name starts with "Podman".
    fn registrations(&mut self) -> Vec<Registration>;
    /// What uses Podman here, or why that couldn't be read.
    fn users(&mut self) -> Result<Users, String>;
    /// The folder WSL keeps the distribution `name` in, when it is registered.
    fn distribution(&mut self, name: &str) -> Option<PathBuf>;
    /// The folder Podman's program is in.
    fn program_folder(&mut self) -> Option<PathBuf>;
    fn unregister(&mut self, distribution: &str) -> Result<(), String>;
    fn uninstall(&mut self, product: &str) -> Result<(), String>;
}

/**
Whether Podman goes with OpenBot: installed from one of `downloads` (OpenBot's downloads folders),
and used by nothing but OpenBot. With `own_machine_gone`, OpenBot's own machine must be gone too,
which is how it is judged just before removing: Podman is never removed from under a machine.
*/
pub fn judge(
    registrations: &[Registration],
    users: Result<Users, String>,
    downloads: &[PathBuf],
    own_machine_gone: bool,
) -> Verdict {
    let kept = |why: String| Verdict::Kept { why };
    if registrations.iter().any(is_podman_desktop) {
        return kept("Podman Desktop is installed".into());
    }
    let podman: Vec<&Registration> = registrations
        .iter()
        .filter(|registration| !is_podman_desktop(registration))
        .collect();
    let registration = match podman.as_slice() {
        [] => return kept("no Podman registered with Windows Installer".into()),
        [one] => *one,
        more => return kept(format!("{} Podman products registered", more.len())),
    };
    let Some(source) = registration.install_source.as_deref() else {
        return kept(format!("{} has no install source", registration.name));
    };
    if !downloads.iter().any(|dir| same_folder(source, dir)) {
        return kept(format!(
            "{} was installed from {source}, not by OpenBot",
            registration.name
        ));
    }
    let Some(product) = product_code(&registration.uninstall) else {
        return kept(format!(
            "{} has no product code in {:?}",
            registration.name, registration.uninstall
        ));
    };
    let users = match users {
        Ok(users) => users,
        Err(error) => return kept(format!("couldn't tell what uses Podman: {error}")),
    };
    if users.podman_desktop {
        return kept("Podman Desktop is installed".into());
    }
    let machines: Vec<&String> = users
        .machines
        .iter()
        .filter(|name| own_machine_gone || name.as_str() != MACHINE)
        .collect();
    if !machines.is_empty() {
        return kept(format!("Podman has other machines: {machines:?}"));
    }
    let connections: Vec<&String> = users
        .connections
        .iter()
        .filter(|name| own_machine_gone || !crate::podman_default::is_ours(name))
        .collect();
    if !connections.is_empty() {
        return kept(format!("Podman has other connections: {connections:?}"));
    }
    Verdict::Ours { product }
}

fn is_podman_desktop(registration: &Registration) -> bool {
    registration
        .name
        .to_ascii_lowercase()
        .starts_with("podman desktop")
}

/// The same Windows folder, whatever the case, the slashes and a trailing separator.
fn same_folder(recorded: &str, dir: &Path) -> bool {
    let plain = |path: &str| {
        path.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    plain(recorded) == plain(&dir.to_string_lossy())
}

/// The `{GUID}` in an `UninstallString`, as `msiexec /x` takes it.
pub fn product_code(uninstall: &str) -> Option<String> {
    let start = uninstall.find('{')?;
    let end = start + uninstall[start..].find('}')?;
    let code = &uninstall[start..=end];
    let inner = &code[1..code.len() - 1];
    let shaped = inner.len() == 36
        && inner.chars().enumerate().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    shaped.then(|| code.to_owned())
}

/// What uses Podman, from `podman machine list --format json` and
/// `podman system connection list --format json`.
pub fn users_in(machines: &str, connections: &str, podman_desktop: bool) -> Result<Users, String> {
    #[derive(Deserialize)]
    struct Listed {
        #[serde(rename = "Name")]
        name: String,
    }
    let listed: Vec<Listed> = serde_json::from_str(machines).map_err(|error| {
        format!("could not read podman machine list JSON: {error}; stdout: {machines}")
    })?;
    Ok(Users {
        machines: listed.into_iter().map(|machine| machine.name).collect(),
        connections: crate::podman_default::connections_in(connections)?.names,
        podman_desktop,
    })
}

/// What Podman takes on this computer, when it goes with OpenBot (judged with OpenBot's machine
/// still there): its program folder and `USERMODE`'s. Nothing when it stays.
pub fn parts(computer: &mut dyn Computer, downloads: &[PathBuf]) -> Vec<PathBuf> {
    let registrations = computer.registrations();
    if registrations.is_empty() {
        return Vec::new();
    }
    let users = computer.users();
    match judge(&registrations, users, downloads, false) {
        Verdict::Ours { .. } => computer
            .program_folder()
            .into_iter()
            .chain(computer.distribution(USERMODE))
            .collect(),
        Verdict::Kept { .. } => Vec::new(),
    }
}

/**
Podman removed, when it goes with OpenBot (`judge`, with OpenBot's own machine already gone):
`USERMODE` unregistered from WSL, then Podman uninstalled as Installed apps would. What couldn't be,
in plain words. A Podman that stays is no failure: nothing is said.
*/
pub fn remove(computer: &mut dyn Computer, downloads: &[PathBuf]) -> Vec<String> {
    let registrations = computer.registrations();
    if registrations.is_empty() {
        return Vec::new();
    }
    let users = computer.users();
    let product = match judge(&registrations, users, downloads, true) {
        Verdict::Ours { product } => product,
        Verdict::Kept { why } => {
            log::info!("[move] Podman stays: {why}");
            return Vec::new();
        }
    };
    log::info!("[move] removing Podman {product}, which OpenBot installed and nothing else uses");
    let mut left = Vec::new();
    if computer.distribution(USERMODE).is_some() {
        if let Err(error) = computer.unregister(USERMODE) {
            log::warn!("[move] wsl --unregister {USERMODE}: {error}");
            left.push(LEFT_BEHIND.to_owned());
        }
    }
    if let Err(error) = computer.uninstall(&product) {
        log::warn!("[move] msiexec /x {product}: {error}");
        if left.is_empty() {
            left.push(LEFT_BEHIND.to_owned());
        }
    }
    left
}

/// This computer's Podman. Off Windows there is never a registration, so nothing is touched.
pub struct ThisComputer;

impl Computer for ThisComputer {
    fn registrations(&mut self) -> Vec<Registration> {
        #[cfg(target_os = "windows")]
        return registered();
        #[cfg(not(target_os = "windows"))]
        Vec::new()
    }

    fn users(&mut self) -> Result<Users, String> {
        let machines = crate::acquire::podman(&["machine", "list", "--format", "json"])?;
        let connections = crate::acquire::podman(&crate::podman_default::LIST)?;
        users_in(&machines, &connections, podman_desktop_folder())
    }

    fn distribution(&mut self, name: &str) -> Option<PathBuf> {
        crate::windows::distribution_base(name)
    }

    fn program_folder(&mut self) -> Option<PathBuf> {
        crate::engine::program(crate::engine::Engine::Podman)
            .and_then(|program| program.parent().map(Path::to_path_buf))
    }

    fn unregister(&mut self, distribution: &str) -> Result<(), String> {
        run(
            crate::quiet::command("wsl.exe").args(["--unregister", distribution]),
            &[0],
        )
    }

    /// 1605 is "This action is only valid for products that are currently installed": already gone.
    /// 3010 is success that asks for a restart, which nothing here needs.
    fn uninstall(&mut self, product: &str) -> Result<(), String> {
        run(
            crate::quiet::command("msiexec").args(["/x", product, "/qn", "/norestart"]),
            &[0, 1605, 3010],
        )
    }
}

fn run(command: &mut std::process::Command, success: &[i32]) -> Result<(), String> {
    let output = crate::quiet::output_within(command, std::time::Duration::from_secs(300))
        .map_err(|e| format!("could not run: {e}"))?;
    match output.status.code() {
        Some(code) if success.contains(&code) => Ok(()),
        code => Err(format!(
            "exit {code:?}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

/// Podman Desktop's own folder, for an install Installed apps doesn't list.
fn podman_desktop_folder() -> bool {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .is_some_and(|local| local.join("Programs").join("podman-desktop").is_dir())
}

/// Every product named "Podman..." that Windows Installer has registered: in Installed apps for
/// everyone and for this person, and in Windows Installer's own record of per-person installs.
#[cfg(target_os = "windows")]
fn registered() -> Vec<Registration> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const USER_DATA: &str = r"Software\Microsoft\Windows\CurrentVersion\Installer\UserData";

    let uninstall: Vec<_> = [CURRENT_USER, LOCAL_MACHINE]
        .iter()
        .filter_map(|root| root.open(UNINSTALL).ok())
        .collect();
    registered_in(&uninstall, LOCAL_MACHINE.open(USER_DATA).ok().as_ref())
}

/// `registered`, from Installed apps' keys `uninstall` and Windows Installer's `user_data`.
#[cfg(target_os = "windows")]
fn registered_in(
    uninstall: &[windows_registry::Key],
    user_data: Option<&windows_registry::Key>,
) -> Vec<Registration> {
    use windows_registry::Key;

    fn read(key: &Key) -> Option<Registration> {
        let name = key.get_string("DisplayName").ok()?;
        if !name.to_ascii_lowercase().starts_with("podman") {
            return None;
        }
        Some(Registration {
            name,
            uninstall: key.get_string("UninstallString").unwrap_or_default(),
            install_source: key.get_string("InstallSource").ok(),
        })
    }
    fn children(key: &Key) -> Vec<Key> {
        let Ok(names) = key.keys() else {
            return Vec::new();
        };
        names.filter_map(|name| key.open(&name).ok()).collect()
    }

    let mut found: Vec<Registration> = Vec::new();
    for key in uninstall {
        found.extend(children(key).iter().filter_map(read));
    }
    if let Some(users) = user_data {
        for user in children(users) {
            let Ok(products) = user.open("Products") else {
                continue;
            };
            for product in children(&products) {
                if let Some(registration) = product
                    .open("InstallProperties")
                    .ok()
                    .and_then(|k| read(&k))
                {
                    found.push(registration);
                }
            }
        }
    }
    // The same product is in more than one of these: once per product code.
    let mut seen = Vec::new();
    found.retain(|registration| {
        let key = product_code(&registration.uninstall)
            .unwrap_or_else(|| registration.name.clone())
            .to_ascii_uppercase();
        if seen.contains(&key) {
            return false;
        }
        seen.push(key);
        true
    });
    found
}

#[cfg(test)]
mod tests;
