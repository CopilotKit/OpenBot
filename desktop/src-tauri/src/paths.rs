//! A folder as a person reads it.
//!
//! `std::fs::canonicalize` answers on Windows in the extended-length form,
//! `\\?\C:\Users\Ada\OpenBot`, which every Windows API accepts and nobody types. Kept, it reached
//! Settings as "Installed in \\?\C:\Users\Ada\OpenBot". `plain` gives the same folder back as
//! `C:\Users\Ada\OpenBot`, and `\\?\UNC\server\share\OpenBot` as `\\server\share\OpenBot`.
//!
//! Not the `dunce` crate, which does this for drive paths: its last release is from August 2024,
//! and it leaves a UNC path in its extended-length form.

use std::path::PathBuf;

/// `path` without its `\\?\` prefix when Windows reads what is left as the same place, and `path`
/// unchanged otherwise, and on every other system.
///
/// What is left is the same place when the prefix is a drive followed by its root, or a UNC server
/// and share, and every name after it means itself without the prefix: no `.` or `..`, no reserved
/// character, no trailing space or period, no device name such as `CON`. The prefix also lifts the
/// 260-character limit, and the standard library puts it back by itself on a longer path it opens.
///
/// Two canonical paths compare equal after this exactly when they did before it, since a path loses
/// its prefix or keeps it on its own merits. Containment does not carry over the same way: a folder
/// that loses its prefix no longer `starts_with` a child that keeps one. Checks that compare by
/// containment, the host-access ones, compare canonical paths and only show this form.
#[cfg(windows)]
pub fn plain(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let (verbatim, lead) = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            // Only with its root: `C:` alone is the drive's current folder, somewhere else.
            Prefix::VerbatimDisk(_) if components.next() == Some(Component::RootDir) => {
                (r"\\?\", "")
            }
            Prefix::VerbatimUNC(server, share)
                if same_without_prefix(server) && same_without_prefix(share) =>
            {
                (r"\\?\UNC\", r"\\")
            }
            _ => return path,
        },
        _ => return path,
    };
    let names_unchanged = components.all(|component| match component {
        Component::RootDir => true,
        Component::Normal(name) => same_without_prefix(name),
        _ => false,
    });
    let rest = path.to_str().and_then(|text| text.get(verbatim.len()..));
    match rest {
        Some(rest) if names_unchanged => PathBuf::from(format!("{lead}{rest}")),
        _ => path,
    }
}

#[cfg(not(windows))]
pub fn plain(path: PathBuf) -> PathBuf {
    path
}

/// The device names Windows answers in every folder, from "Naming Files, Paths, and Namespaces".
#[cfg(any(windows, test))]
const DEVICES: [&str; 28] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9", "LPT¹", "LPT²", "LPT³",
];

/// Whether Windows reads this one name the same with the `\\?\` prefix and without it. The prefix
/// sends a name to the file system as written; without it Windows trims a trailing space or period,
/// splits at a reserved character, and reads `NUL.txt` and `NUL .tar.gz` as the device `NUL`.
#[cfg(any(windows, test))]
fn same_without_prefix(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    !name.is_empty()
        && !name.ends_with([' ', '.'])
        && !name
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        && !DEVICES
            .iter()
            .any(|device| base.eq_ignore_ascii_case(device))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn a_name_means_itself_without_the_prefix_unless_windows_would_rewrite_it() {
        for name in [
            "OpenBot",
            "Administrator",
            "My Documents",
            ".openbot",
            "report.v2.txt",
            "Ünïcødé",
            "CONSOLE",
            "COM0",
            "COM10",
            "LPT",
            "con-fig",
            "aux_files",
        ] {
            assert!(same_without_prefix(OsStr::new(name)), "{name}");
        }
        for name in [
            "",
            "CON",
            "con",
            "Nul.txt",
            "NUL .tar.gz",
            "com1",
            "COM¹",
            "lpt9.log",
            "trailing.",
            "trailing ",
            "a/b",
            "a:b",
            "what?",
            "star*",
            "pipe|",
            "quote\"",
            "less<",
            "more>",
            "tab\there",
        ] {
            assert!(!same_without_prefix(OsStr::new(name)), "{name:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn plain_drops_the_extended_length_prefix_from_drive_and_unc_paths() {
        for (verbatim, expected) in [
            (
                r"\\?\C:\Users\Administrator\OpenBot",
                r"C:\Users\Administrator\OpenBot",
            ),
            (r"\\?\c:\Users\ada\OpenBot", r"c:\Users\ada\OpenBot"),
            (r"\\?\D:\", r"D:\"),
            (
                r"\\?\C:\Users\RUNNER~1\AppData\Local\Temp\openbot-1",
                r"C:\Users\RUNNER~1\AppData\Local\Temp\openbot-1",
            ),
            (
                r"\\?\UNC\fileserver\homes\ada\OpenBot",
                r"\\fileserver\homes\ada\OpenBot",
            ),
            (r"\\?\UNC\fileserver\homes", r"\\fileserver\homes"),
        ] {
            assert_eq!(plain(PathBuf::from(verbatim)), PathBuf::from(expected));
        }
    }

    #[cfg(windows)]
    #[test]
    fn plain_keeps_a_path_whose_meaning_the_prefix_carries() {
        for path in [
            // Already plain.
            r"C:\Users\Administrator\OpenBot",
            r"\\fileserver\homes\ada",
            // Names Windows would rewrite or read as a device.
            r"\\?\C:\Users\ada\CON",
            r"\\?\C:\Users\ada\nul.txt\OpenBot",
            r"\\?\C:\Users\ada\trailing.",
            r"\\?\C:\Users\ada\trailing ",
            r"\\?\C:\Users\ada\a/b",
            r"\\?\C:\Users\ada\..\bob",
            r"\\?\C:\Users\ada\.\OpenBot",
            r"\\?\UNC\fileserver\CON\ada",
            // A drive without its root is that drive's current folder.
            r"\\?\C:",
            // Not a drive or a share: no plain form names them.
            r"\\?\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\OpenBot",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\OpenBot",
            r"\\.\C:\OpenBot",
            r"\\?\UNC\fileserver",
        ] {
            assert_eq!(plain(PathBuf::from(path)), PathBuf::from(path), "{path}");
        }
    }

    /// The real shape: a folder `canonicalize` resolves on this runner, which answers in the
    /// extended-length form on Windows, comes back plain and still names the same folder.
    #[test]
    fn a_canonical_folder_comes_back_plain_and_still_the_same_folder() {
        let root = crate::test_support::temp_root("plain-path");
        std::fs::create_dir_all(root.join("OpenBot")).unwrap();
        let canonical = std::fs::canonicalize(root.join("OpenBot")).unwrap();
        let shown = plain(canonical.clone());
        assert!(
            !shown.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            shown.display()
        );
        if cfg!(windows) {
            assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        }
        assert_eq!(std::fs::canonicalize(&shown).unwrap(), canonical);
        std::fs::remove_dir_all(root).unwrap();
    }
}
