//! Owner approval is collected by native dialogs, never by an app/tool-provided answer.
use openbot_desktop_lib::host_access::{
    command_approval, ApprovedFolder, ChooseFolderPrompt, CommandApproval, CommandPolicy,
    CommandPrompt, HostAccessError, HostAccessResult, HostApprovalUi, LocalCommandAllowList,
    WritePrompt,
};
use openbot_desktop_lib::paths;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const ALLOW_ONCE: &str = "Allow once";
const ALWAYS_HERE: &str = "Always allow in this folder";
const DENY: &str = "Deny";
/// What the server is told when the person presses Deny. It reaches the Bot, and the person reads it
/// on the Computer page and under the step in the conversation, so it names no "owner": the person
/// at this computer is the one reading it. The server knows this sentence (`DENIED_ON_DESKTOP` in
/// `server/src/host-access/tools.ts`) and records it as the person declining; change both together.
const DECLINED: &str = "Declined in OpenBot Desktop.";

pub struct NativeApproval<R: tauri::Runtime>(pub tauri::AppHandle<R>);

fn refused(message: impl Into<String>) -> HostAccessError {
    HostAccessError::Denied(message.into())
}

/// The approved folder as a person reads it. The grant keeps it canonical, `\\?\C:\...` on Windows,
/// for its containment checks; the dialog shows it plain.
fn folder(root: &Path) -> String {
    paths::plain(root.to_path_buf()).display().to_string()
}

// A native message dialog is deliberately small. Refuse content that cannot be reviewed here;
// truncating it would authorize bytes the person never saw.
fn reviewable(value: &str) -> HostAccessResult<()> {
    if value.chars().count() > 2_000 || value.lines().count() > 24 || value.contains('\0') {
        return Err(refused("This operation is too large for native approval. Ask the Bot for a smaller edit or command."));
    }
    Ok(())
}

fn bot_label(name: Option<&str>, id: &str) -> String {
    name.unwrap_or(id)
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(120)
        .collect()
}

/// The "Allow folder access?" dialog's text.
///
/// It names nobody as the requester. This app always runs the personal edition (`env.rs`), where the
/// one person at this computer is the only one who can ask, so the line only ever named them to
/// themselves, and by the server's internal id (`dev-local-user`) at that. Access is revoked on
/// Settings → Computer, the page's name in that edition.
fn folder_access_message(bot: &str, folder: &str) -> String {
    format!(
        "Bot: {bot}\n\nFolder: {folder}\n\nAllow this Bot to read this folder for this OpenBot session? Each edit and command asks separately. You can revoke access in Settings → Computer."
    )
}

/// The "Allow this command?" dialog's text.
///
/// Every path is one on this computer. The command runs in a sandbox whose own paths
/// (`/approved`, `/workspace`) mean nothing to the person, so none is shown: the approved folder,
/// and the folder inside it the command runs in when that is not the approved folder itself.
fn command_message(
    bot: &str,
    root: &Path,
    working_directory: Option<&Path>,
    command: &str,
    access: &str,
    setting: &str,
) -> String {
    let runs_in = working_directory
        .filter(|directory| *directory != root)
        .map(|directory| format!("\nRuns in: {}", folder(directory)))
        .unwrap_or_default();
    format!(
        "Bot: {bot}\nFolder: {}{runs_in}\n\nCommand:\n{command}\n\n{access}\nNetwork access is disabled.\n\n{setting}",
        folder(root)
    )
}

/// What the person pressed on the three-button command dialog. The plugin reports custom buttons by
/// their label; anything else, including a plain Yes or No, is a denial.
#[derive(Debug, PartialEq, Eq)]
enum CommandChoice {
    Once,
    Always,
    Deny,
}

fn command_choice(result: &MessageDialogResult) -> CommandChoice {
    match result {
        MessageDialogResult::Custom(label) if label == ALLOW_ONCE => CommandChoice::Once,
        MessageDialogResult::Custom(label) if label == ALWAYS_HERE => CommandChoice::Always,
        _ => CommandChoice::Deny,
    }
}

impl<R: tauri::Runtime> NativeApproval<R> {
    /// The desktop's own record of folders where the person stopped being asked about commands.
    fn allow_list(&self) -> HostAccessResult<LocalCommandAllowList> {
        let directory = self
            .0
            .path()
            .app_config_dir()
            .map_err(|error| refused(error.to_string()))?;
        Ok(LocalCommandAllowList::new(
            directory.join("host-command-approvals.json"),
        ))
    }

    fn window(&self) -> HostAccessResult<tauri::WebviewWindow<R>> {
        let window = self
            .0
            .get_webview_window("main")
            .ok_or_else(|| refused("The local OpenBot window is closed."))?;
        window.show().map_err(|error| refused(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| refused(error.to_string()))?;
        Ok(window)
    }

    fn confirm(&self, title: &str, message: String) -> HostAccessResult<()> {
        let window = self
            .0
            .get_webview_window("main")
            .ok_or_else(|| refused("The local OpenBot window is closed."))?;
        window.show().map_err(|error| refused(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| refused(error.to_string()))?;
        let allowed = self
            .0
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow once".into(),
                "Deny".into(),
            ))
            .parent(&window)
            .blocking_show();
        if allowed {
            Ok(())
        } else {
            Err(refused(DECLINED))
        }
    }
}

impl<R: tauri::Runtime> HostApprovalUi for NativeApproval<R> {
    fn choose_folder(&self, request: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
        let bot = bot_label(request.bot_name.as_deref(), &request.bot_id);
        let window = self
            .0
            .get_webview_window("main")
            .ok_or_else(|| refused("The local OpenBot window is closed."))?;
        window.show().map_err(|error| refused(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| refused(error.to_string()))?;
        let picked = self
            .0
            .dialog()
            .file()
            .set_title(format!("Choose a folder for {bot} to read"))
            .set_parent(&window)
            .blocking_pick_folder()
            .ok_or_else(|| refused("No folder was approved."))?;
        let root = picked
            .into_path()
            .map_err(|error| refused(error.to_string()))?;
        self.confirm(
            "Allow folder access?",
            folder_access_message(&bot, &folder(&root)),
        )?;
        Ok(ApprovedFolder { root })
    }

    fn confirm_write(&self, request: &WritePrompt) -> HostAccessResult<()> {
        reviewable(&request.content)?;
        let bot = bot_label(request.bot_name.as_deref(), &request.bot_id);
        self.confirm("Allow this file change?", format!(
            "Bot: {bot}\nFolder: {}\nFile: {}\n\nNew content:\n{}\n\nAllow this exact change once? OpenBot keeps the previous contents when replacing a file.",
            folder(&request.root), request.relative_path, request.content
        ))
    }

    fn confirm_command(&self, request: &CommandPrompt) -> HostAccessResult<()> {
        reviewable(&request.command)?;
        let list = self.allow_list()?;
        let allowed_here = list.allows(&request.bot_id, &request.root);
        let offer_always =
            match command_approval(request.command_policy, allowed_here, request.writable) {
                CommandApproval::Refuse => {
                    return Err(refused("Commands on this computer are set to never run."))
                }
                CommandApproval::Proceed => return Ok(()),
                CommandApproval::Ask { offer_always } => offer_always,
            };
        let bot = bot_label(request.bot_name.as_deref(), &request.bot_id);
        let access = if request.writable {
            "This command may edit or delete files in the approved folder. Commands cannot be undone automatically."
        } else {
            "The approved folder stays read-only. The command can write only to its temporary workspace."
        };
        let setting = if offer_always {
            format!(
                "Your OpenBot setting: {}. Choose \"{ALWAYS_HERE}\" to stop asking about {bot}'s read-only commands in this folder on this computer.",
                request.command_policy.label()
            )
        } else if request.writable && request.command_policy == CommandPolicy::Allow {
            format!(
                "Your OpenBot setting: {}. Commands that can edit files still ask every time.",
                request.command_policy.label()
            )
        } else {
            format!(
                "Your OpenBot setting: {}. Change it in Settings → Approvals.",
                request.command_policy.label()
            )
        };
        let message = command_message(
            &bot,
            &request.root,
            request.working_directory.as_deref(),
            &request.command,
            access,
            &setting,
        );
        if !offer_always {
            return self.confirm("Allow this command?", message);
        }
        let window = self.window()?;
        let result = self
            .0
            .dialog()
            .message(message)
            .title("Allow this command?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                ALLOW_ONCE.into(),
                ALWAYS_HERE.into(),
                DENY.into(),
            ))
            .parent(&window)
            .blocking_show_with_result();
        match command_choice(&result) {
            CommandChoice::Once => Ok(()),
            CommandChoice::Always => list.remember(&request.bot_id, &request.root),
            CommandChoice::Deny => Err(refused(DECLINED)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_named_button_allows_a_command() {
        assert_eq!(
            command_choice(&MessageDialogResult::Custom(ALLOW_ONCE.into())),
            CommandChoice::Once
        );
        assert_eq!(
            command_choice(&MessageDialogResult::Custom(ALWAYS_HERE.into())),
            CommandChoice::Always
        );
        assert_eq!(
            command_choice(&MessageDialogResult::Custom(DENY.into())),
            CommandChoice::Deny
        );
        assert_eq!(
            command_choice(&MessageDialogResult::Cancel),
            CommandChoice::Deny
        );
        assert_eq!(
            command_choice(&MessageDialogResult::Custom("something else".into())),
            CommandChoice::Deny
        );
    }

    /// A grant's folder is canonical, which Windows answers as `\\?\C:\Users\...`. The approval
    /// dialogs name it as a person reads it.
    #[test]
    fn approval_names_the_folder_without_the_windows_extended_length_prefix() {
        let root =
            std::env::temp_dir().join(format!("openbot-approval-folder-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let granted = std::fs::canonicalize(&root).unwrap();
        let shown = folder(&granted);
        assert!(!shown.starts_with(r"\\?\"), "{shown}");
        assert_eq!(std::fs::canonicalize(&shown).unwrap(), granted);
        #[cfg(windows)]
        assert_eq!(
            folder(Path::new(r"\\?\C:\Users\Administrator\Projects")),
            r"C:\Users\Administrator\Projects"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Found on Windows: the dialog read "Requested by: dev-local-user", the server's internal id for
    /// the one person, and sent them to "Computers", a page the personal edition calls Computer.
    #[test]
    fn folder_access_names_no_internal_requester_and_the_page_as_it_is_called() {
        assert_eq!(
            folder_access_message("Personal Assistant", r"C:\acc\share"),
            "Bot: Personal Assistant\n\nFolder: C:\\acc\\share\n\nAllow this Bot to read this folder for this OpenBot session? Each edit and command asks separately. You can revoke access in Settings → Computer."
        );
    }

    /// Found on Windows: "Folder: C:\acc\share" above "Working folder: /workspace", a path inside the
    /// Bot's sandbox, and not even the one the command ran in (that is the approved folder).
    #[test]
    fn command_approval_shows_only_folders_on_this_computer() {
        let root =
            std::env::temp_dir().join(format!("openbot-command-folder-{}", std::process::id()));
        let inner = root.join("reports");
        std::fs::create_dir_all(&inner).unwrap();
        let access = "The approved folder stays read-only. The command can write only to its temporary workspace.";
        let setting = "Your OpenBot setting: ask every time. Change it in Settings → Approvals.";

        assert_eq!(
            command_message("Personal Assistant", &root, None, "dir", access, setting),
            format!(
                "Bot: Personal Assistant\nFolder: {}\n\nCommand:\ndir\n\n{access}\nNetwork access is disabled.\n\n{setting}",
                folder(&root)
            )
        );
        // Asked to run in the approved folder itself, which is where it runs anyway.
        assert_eq!(
            command_message(
                "Personal Assistant",
                &root,
                Some(&root),
                "dir",
                access,
                setting
            ),
            command_message("Personal Assistant", &root, None, "dir", access, setting)
        );
        let in_reports = command_message(
            "Personal Assistant",
            &root,
            Some(&inner),
            "dir",
            access,
            setting,
        );
        assert!(
            in_reports.starts_with(&format!(
                "Bot: Personal Assistant\nFolder: {}\nRuns in: {}\n\nCommand:\ndir\n\n",
                folder(&root),
                folder(&inner)
            )),
            "{in_reports}"
        );
        for message in [
            command_message("Personal Assistant", &root, None, "dir", access, setting),
            in_reports,
        ] {
            assert!(!message.contains("/workspace"), "{message}");
            assert!(!message.contains("/approved"), "{message}");
            assert!(!message.contains("Working folder"), "{message}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Pressing Deny answered "The local owner denied this operation.", which the person read on the
    /// Computer page and under the step: about themselves, as somebody else.
    #[test]
    fn a_denial_says_where_it_was_declined_and_names_no_owner() {
        assert_eq!(DECLINED, "Declined in OpenBot Desktop.");
        assert!(!DECLINED.to_lowercase().contains("owner"));
    }

    #[test]
    fn approval_never_silently_truncates_requested_changes() {
        assert!(reviewable("hello\nworld").is_ok());
        assert!(reviewable(&"x".repeat(2_001)).is_err());
        assert!(reviewable(&"x\n".repeat(25)).is_err());
        assert!(reviewable("hello\0hidden").is_err());
    }
}
