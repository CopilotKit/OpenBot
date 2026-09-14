//! Owner approval is collected by native dialogs, never by an app/tool-provided answer.
use openbot_desktop_lib::host_access::{
    ApprovedFolder, ChooseFolderPrompt, CommandPrompt, HostAccessError, HostAccessResult,
    HostApprovalUi, WritePrompt,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

impl<R: tauri::Runtime> NativeApproval<R> {
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
        let bot = bot_label(request.bot_name.as_deref(), &request.bot_id);
        let access = if request.writable {
            "This command may edit or delete files in the approved folder. Commands cannot be undone automatically."
        } else {
            "The approved folder stays read-only. The command can write only to its temporary workspace."
        };
        self.confirm("Allow this command?", format!(
            "Bot: {bot}\nFolder: {}\nWorking folder: {}\n\nCommand:\n{}\n\n{access}\nNetwork access is disabled. Allow this command once?",
            request.root.display(), request.working_directory.as_deref().unwrap_or("/workspace"), request.command
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_never_silently_truncates_requested_changes() {
        assert!(reviewable("hello\nworld").is_ok());
        assert!(reviewable(&"x".repeat(2_001)).is_err());
        assert!(reviewable(&"x\n".repeat(25)).is_err());
        assert!(reviewable("hello\0hidden").is_err());
    }
}
