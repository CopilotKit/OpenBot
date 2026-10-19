; OpenBot Desktop's NSIS installer hooks: bundle.windows.nsis.installerHooks in tauri.conf.json.
; https://v2.tauri.app/distribute/windows-installer/

; Uninstalling takes away what the Recorder host install wrote for this person (src/recorder_install.rs): each
; browser's native messaging host key and the one manifest they all point at, which sits beside the app in
; %LOCALAPPDATA%\OpenBot. Not on an update, which runs the old uninstaller with /UPDATE; the new version writes them
; again when it starts.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    SetShellVarContext current
    Delete "$LOCALAPPDATA\OpenBot\recorder\ai.copilotkit.openbot.recorder.json"
    RMDir "$LOCALAPPDATA\OpenBot\recorder"
    RMDir "$LOCALAPPDATA\OpenBot"
  ${EndIf}
!macroend
