//! Owner approval is collected by native dialogs, never by an app/tool-provided answer.
use openbot_desktop_lib::host_access::{
    command_approval, ApprovedFolder, ChooseFolderPrompt, CommandApproval, CommandPrompt,
    HostAccessError, HostAccessResult, HostApprovalUi, LocalCommandAllowList, WritePrompt,
};
use tauri::Manager;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const ALLOW_ONCE: &str = "Allow once";
const ALWAYS_HERE: &str = "Always allow in this folder";
const DENY: &str = "Deny";

pub struct NativeApproval<R: tauri::Runtime>(pub tauri::AppHandle<R>);

fn refused(message: impl Into<String>) -> HostAccessError {
    HostAccessError::Denied(message.into())
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
            Err(refused("The local owner denied this operation."))
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
        self.confirm("Allow folder access?", format!(
            "Bot: {bot}\nRequested by: {}\n\nFolder: {}\n\nAllow this Bot to read this folder for this OpenBot session? Each edit and command asks separately. You can revoke access in Computers.",
            request.actor_id, root.display()
        ))?;
        Ok(ApprovedFolder { root })
    }

    fn confirm_write(&self, request: &WritePrompt) -> HostAccessResult<()> {
        reviewable(&request.content)?;
        let bot = bot_label(request.bot_name.as_deref(), &request.bot_id);
        self.confirm("Allow this file change?", format!(
            "Bot: {bot}\nFolder: {}\nFile: {}\n\nNew content:\n{}\n\nAllow this exact change once? OpenBot keeps the previous contents when replacing a file.",
            request.root.display(), request.relative_path, request.content
        ))
    }

    fn confirm_command(&self, request: &CommandPrompt) -> HostAccessResult<()> {
        reviewable(&request.command)?;
        let list = self.allow_list()?;
        let allowed_here = list.allows(&request.bot_id, &request.root);
        let offer_always = match command_approval(request.command_policy, allowed_here) {
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
                "Your OpenBot setting: {}. Choose \"{ALWAYS_HERE}\" to stop asking about {bot}'s commands in this folder on this computer.",
                request.command_policy.label()
            )
        } else {
            format!(
                "Your OpenBot setting: {}. Change it in Approvals.",
                request.command_policy.label()
            )
        };
        let message = format!(
            "Bot: {bot}\nFolder: {}\nWorking folder: {}\n\nCommand:\n{}\n\n{access}\nNetwork access is disabled.\n\n{setting}",
            request.root.display(), request.working_directory.as_deref().unwrap_or("/workspace"), request.command
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
            CommandChoice::Deny => Err(refused("The local owner denied this operation.")),
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

    #[test]
    fn approval_never_silently_truncates_requested_changes() {
        assert!(reviewable("hello\nworld").is_ok());
        assert!(reviewable(&"x".repeat(2_001)).is_err());
        assert!(reviewable(&"x\n".repeat(25)).is_err());
        assert!(reviewable("hello\0hidden").is_err());
    }
}
