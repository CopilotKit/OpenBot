; OpenBot Desktop's NSIS installer hooks: bundle.windows.nsis.installerHooks in tauri.conf.json.
; https://v2.tauri.app/distribute/windows-installer/

; The header image (bundle.windows.nsis.headerImage) goes on the right of each page's header, where NSIS puts its icon
; when there is none. Modern UI puts it on the left by default, ahead of the page's title. Tauri includes this file
; before it inserts the pages, which is when Modern UI reads the define.
!define MUI_HEADERIMAGE_RIGHT

; Uninstalling takes away what the Recorder host install wrote for this person (src/recorder_install.rs): each
; browser's native messaging host key and the one manifest they all point at, which sits beside the app in
; %LOCALAPPDATA%\OpenBot. Not on an update, which runs the old uninstaller with /UPDATE; the new version writes them
; again when it starts.
;
; And the data of the browser earlier versions ran on the person's desktop: its whole data root,
; %LOCALAPPDATA%\OpenBot\local-computer, which holds the profile they signed in to by hand. Desktop no longer runs that
; browser (the person's browser is shown in the OpenBot window), but an installation that did keeps it until it is
; uninstalled. Each of Desktop's folders goes with everything in it (RMDir /r);
; %LOCALAPPDATA%\OpenBot itself only once nothing else is left in it, since the app may be installed there.
;
; And what registered the Recorder from its stores with Chrome and Edge (src/recorder_external.rs): each store id's
; HKCU Extensions key, with which the browser takes the Recorder it installed back out, and Desktop's note of them.
; There is one DeleteRegKey per store id set in shared/recorder-extension.json, and a test holds the two in step;
; none while the ids are empty.
; The bundled Intelligence CLI starts a background sign-in service with the bundled node.exe, detached, so it outlives
; the app. While it runs Windows will not let an install or an uninstall replace or delete
; $INSTDIR\cli-bundle\runtime\node.exe, and the uninstaller failed on exactly that. Before either, stop every
; process running from this installation's own cli-bundle, and nothing else: another node.exe is never touched.
; Intelligence brings the service back the next time it starts.
; The installer is a 32-bit program, so the powershell.exe it starts is the 32-bit one (WOW64 redirects System32 to
; SysWOW64), while node.exe is 64-bit. A 32-bit PowerShell's Get-Process has no Path for a 64-bit process, and the
; stop used to match nothing; WMI's Win32_Process has the ExecutablePath at either bitness, so the processes are found
; there. Stop-Process returns before a process has exited, and node.exe stays locked until it has, so the hook waits
; for each one it stopped (30 seconds at most) before the installer goes on to replace the file.
; The folder reaches PowerShell as data, in OPENBOT_CLI_BUNDLE, never inside the script: a profile folder like
; C:\Users\O'Brien would end a quoted string there, and [ and ] are wildcards to -like.
!macro OPENBOT_STOP_BUNDLED_CLI
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("OPENBOT_CLI_BUNDLE", "$INSTDIR\cli-bundle")'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$bundle = $$env:OPENBOT_CLI_BUNDLE.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$bundle, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue } | Stop-Process -Force -PassThru -ErrorAction SilentlyContinue | ForEach-Object { $$null = $$_.WaitForExit(30000) }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OPENBOT_STOP_BUNDLED_CLI
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OPENBOT_STOP_BUNDLED_CLI
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\ai.copilotkit.openbot.recorder"
    SetShellVarContext current
    Delete "$LOCALAPPDATA\OpenBot\recorder\ai.copilotkit.openbot.recorder.json"
    Delete "$LOCALAPPDATA\OpenBot\recorder\recorder-store-extensions.json"
    RMDir /r "$LOCALAPPDATA\OpenBot\recorder"
    RMDir /r "$LOCALAPPDATA\OpenBot\local-computer"
    RMDir "$LOCALAPPDATA\OpenBot"
  ${EndIf}
!macroend
