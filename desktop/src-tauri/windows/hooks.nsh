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
; Only when this installation has a cli-bundle folder: nothing can run from a folder that isn't there, and Windows
; keeps a running program's file, so its folder, until it exits. On a fresh computer the folder isn't there yet, and
; starting PowerShell and WMI there to find nothing held the Installing page still on "Output folder" for about two
; minutes. An update or a reinstall over a bundled CLI has the folder, and stops it as before.
; IfFileExists with \*.* is how NSIS asks whether a folder exists (https://nsis.sourceforge.io/Docs/Chapter4.html).
!macro OPENBOT_STOP_BUNDLED_CLI
  ${If} ${FileExists} "$INSTDIR\cli-bundle\*.*"
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("OPENBOT_CLI_BUNDLE", "$INSTDIR\cli-bundle")'
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$bundle = $$env:OPENBOT_CLI_BUNDLE.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$bundle, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue } | Stop-Process -Force -PassThru -ErrorAction SilentlyContinue | ForEach-Object { $$null = $$_.WaitForExit(30000) }"`
    Pop $0
  ${EndIf}
!macroend

; Installing over an installed OpenBot with "Uninstall before installing" uninstalls the old version
; first. Tauri's page ran the old uninstaller itself, with the installer's window hidden, and run
; silently that left nothing on screen: on a live update from 1.0.1, OpenBot had closed and no window
; showed for two and a half minutes. So the page only notes the choice ($OpenBotUninstallFirst, in
; windows/installer.nsi), and the old version is uninstalled on the Installing page, with a line in
; plain words and the page's progress bar moving (OPENBOT_UNINSTALL_OLD_VERSION).
Var OpenBotUninstallFirst
Var OpenBotOldUninstaller
Var OpenBotOldFolder
Var OpenBotProgress

; Leaving the page with a running OpenBot asks first, with the words a running OpenBot gets
; everywhere else (appRunningOkKill in installer-english.nsh), and OK closes it there and then, as the
; words say, as Tauri's own check does. Cancel stays on the page, where the person can close OpenBot
; themselves or choose "Do not uninstall". A passive install asks nothing, as Tauri's own check
; doesn't, and the old uninstaller closes it.
Var OpenBotRunning
!macro OPENBOT_BEFORE_OLD_UNINSTALLER
  ${If} $PassiveMode <> 1
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    !else
      nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
    !endif
    Pop $OpenBotRunning
    ${If} $OpenBotRunning = 0
      nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
      Pop $OpenBotRunning
      ${If} ${Cmd} `MessageBox MB_OKCANCEL "$OpenBotRunning" IDCANCEL`
        Abort
      ${EndIf}
      !if "${INSTALLMODE}" == "currentUser"
        nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
      !else
        nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
      !endif
      Pop $OpenBotRunning
      Sleep 500
      ${If} $OpenBotRunning <> 0
      ${AndIf} $OpenBotRunning <> 2
        nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "${PRODUCTNAME}"
        Pop $OpenBotRunning
        MessageBox MB_OK|MB_ICONEXCLAMATION "$OpenBotRunning"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; The Installing page's progress bar moving on its own (a marquee) while the installer waits on
; something that says nothing of how far it has got, then back to the bar NSIS fills. The bar is
; control 1004 of the page, as MUI2's InstallFiles.nsh reads it, and the installer's Common Controls
; 6 manifest is what lets it move. The wait runs in the Install section, on its own thread, so the
; window keeps drawing. A silent install has no page.
!define /ifndef PBS_MARQUEE 0x08
!macro OPENBOT_PROGRESS_MOVING on
  ${IfNot} ${Silent}
    FindWindow $OpenBotProgress "#32770" "" $HWNDPARENT
    GetDlgItem $OpenBotProgress $OpenBotProgress 1004
    !if "${on}" == "1"
      ${NSD_AddStyle} $OpenBotProgress ${PBS_MARQUEE}
      SendMessage $OpenBotProgress ${PBM_SETMARQUEE} 1 50
    !else
      SendMessage $OpenBotProgress ${PBM_SETMARQUEE} 0 0
      ${NSD_RemoveStyle} $OpenBotProgress ${PBS_MARQUEE}
    !endif
  ${EndIf}
!macroend

; The old version uninstalled, on the Installing page: as an update (/UPDATE), which keeps the data
; and shows no "Delete the application data" box, and silently (/S), with no window of its own, in
; the folder the old version is in (`_?=`, last, as NSIS reads it, so the installer waits for it).
; Tauri's own check comes first, for an OpenBot opened again since the page: Cancel stops the install
; before anything is removed. An old uninstaller that fails leaves the new version installed over the
; old, as "Do not uninstall" would.
!macro OPENBOT_UNINSTALL_OLD_VERSION
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ReadRegStr $OpenBotOldFolder SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $OpenBotOldUninstaller SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $OpenBotOldUninstaller != ""
    DetailPrint "Removing the previous version of OpenBot. Your Bots and data stay."
    !insertmacro OPENBOT_PROGRESS_MOVING 1
    ClearErrors
    ; ExecWait says "Execute: <the command>" on the page's status line, over the plain line, for as
    ; long as it waits (box I). Said to the details list only, so the plain line stays on screen.
    SetDetailsPrint listonly
    ExecWait '$OpenBotOldUninstaller /UPDATE /S _?=$OpenBotOldFolder' $0
    SetDetailsPrint both
    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}
    !insertmacro OPENBOT_PROGRESS_MOVING 0
    ${If} $0 <> 0
      DetailPrint "Couldn't remove the previous version of OpenBot. Installing over it."
    ${ElseIf} $OpenBotOldFolder != $INSTDIR
      ; Run in place, the old uninstaller cannot delete itself or its folder.
      Delete "$OpenBotOldFolder\uninstall.exe"
      RMDir "$OpenBotOldFolder"
    ${EndIf}
  ${EndIf}
!macroend

; Uninstalling (not updating) stops what OpenBot runs before its files go: OpenBot's containers, the
; backend when OpenBot created it, and OpenBot's own Podman machine, "openbot". Before this, the
; uninstaller closed the app and left all of them running with no app to stop them. The app does it
; headless (src/uninstall.rs), so it stops exactly what Stop stops and never the person's own
; machines or containers. With "Delete the application data" ticked (--delete-data) it also removes
; the backend OpenBot created, OpenBot's machine and OpenBot's files in the installation folder, so
; a new installation starts from nothing. Otherwise all of them stay, stopped, for a reinstall to
; find. A running OpenBot is closed first (Tauri's own check, which asks), so it cannot start
; anything again meanwhile. The app's plain lines go to the uninstaller's details and the technical
; ones to OpenBot's log. It gives up after five minutes, and whatever it could not stop never keeps
; OpenBot from being uninstalled.
!macro OPENBOT_STOP_WHAT_OPENBOT_RUNS
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} $DeleteAppDataCheckboxState = 1
    nsExec::ExecToLog '"$INSTDIR\${MAINBINARYNAME}.exe" --stop-for-uninstall --delete-data'
  ${Else}
    nsExec::ExecToLog '"$INSTDIR\${MAINBINARYNAME}.exe" --stop-for-uninstall'
  ${EndIf}
  Pop $0
!macroend

; Every OpenBot the installer starts, after an in-app update (/R, in .onInstSuccess) and from its last
; page (RunMainBinary), is started here, so it can come to the front as its window first shows. On
; box H, after an in-app update, the new OpenBot opened behind the maximised Edge that Windows put in
; front as the old one closed, and Starting OpenBot ran there unseen for four minutes. Windows lets
; only some processes set the foreground window, and one that may can let every other process do it
; (AllowSetForegroundWindow with ASFW_ANY, -1) until the person next gives input. The updating OpenBot
; passes that on before its window goes (src/main.rs), and the person's click on Finish gives it to
; the installer, so the installer passes it on again, then starts OpenBot with
; --started-by-installer, which has it come forward once (`forward_at_first_show` in src/main.rs).
; Where Windows still says no, OpenBot flashes its taskbar button. An update hands the old version's
; own arguments on (/ARGS), which carry the flag from the last update, so it is added only when
; missing. RunAsUser is how Tauri starts the app, as the person rather than an elevated installer.
!define OPENBOT_STARTED_BY_INSTALLER "--started-by-installer"
Var OpenBotRunArgs
Var OpenBotFlagAt
!macro OPENBOT_RUN_AFTER_INSTALL args
  System::Call 'user32::AllowSetForegroundWindow(i -1)'
  StrCpy $OpenBotRunArgs "${args}"
  ${StrLoc} $OpenBotFlagAt "$OpenBotRunArgs" "${OPENBOT_STARTED_BY_INSTALLER}" ">"
  ${If} $OpenBotRunArgs == ""
    StrCpy $OpenBotRunArgs "${OPENBOT_STARTED_BY_INSTALLER}"
  ${ElseIf} $OpenBotFlagAt == ""
    StrCpy $OpenBotRunArgs "$OpenBotRunArgs ${OPENBOT_STARTED_BY_INSTALLER}"
  ${EndIf}
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$OpenBotRunArgs"
!macroend

; Box H: after Finish on a clean computer, nothing was on screen for about ten seconds: this
; installer had closed, and OpenBot's window wasn't up yet. So from the last page the installer
; stays, saying OpenBot is opening, until OpenBot's window is on screen (the class and title Tauri
; gives it), for a minute at most. Nothing on the page can be pressed meanwhile, its close button
; included. It keeps answering Windows: every tenth of a second it hands on whatever messages are
; waiting for it, as its own loop would, so the page never shows as not responding.
!define OPENBOT_WINDOW_CLASS "Tauri Window"
!define OPENBOT_OPEN_WAIT_TENTHS 600
!define /ifndef SC_CLOSE 0xF060
!define /ifndef MF_GRAYED 0x0001
!define /ifndef PM_REMOVE 0x0001
Var OpenBotWaitMessage
Var OpenBotWaitTenths
Var OpenBotWaitWindow
Var OpenBotWaitAnswer
!macro OPENBOT_STAY_UNTIL_OPEN
  ${IfNot} ${Silent}
    GetDlgItem $OpenBotWaitWindow $HWNDPARENT 1
    EnableWindow $OpenBotWaitWindow 0
    GetDlgItem $OpenBotWaitWindow $HWNDPARENT 2
    EnableWindow $OpenBotWaitWindow 0
    GetDlgItem $OpenBotWaitWindow $HWNDPARENT 3
    EnableWindow $OpenBotWaitWindow 0
    EnableWindow $mui.FinishPage.Run 0
    EnableWindow $mui.FinishPage.ShowReadme 0
    System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0) p.s'
    Pop $OpenBotWaitWindow
    System::Call 'user32::EnableMenuItem(p $OpenBotWaitWindow, i ${SC_CLOSE}, i ${MF_GRAYED})'
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Opening OpenBot. This can take a minute."
    ; A MSG, with room to spare.
    System::Alloc 64
    Pop $OpenBotWaitMessage
    StrCpy $OpenBotWaitTenths 0
    ${Do}
      FindWindow $OpenBotWaitWindow "${OPENBOT_WINDOW_CLASS}" "${PRODUCTNAME}"
      ${If} $OpenBotWaitWindow <> 0
        System::Call 'user32::IsWindowVisible(p $OpenBotWaitWindow) i.s'
        Pop $OpenBotWaitAnswer
        ${If} $OpenBotWaitAnswer <> 0
          ${ExitDo}
        ${EndIf}
      ${EndIf}
      ${If} $OpenBotWaitTenths >= ${OPENBOT_OPEN_WAIT_TENTHS}
        ${ExitDo}
      ${EndIf}
      ${Do}
        System::Call 'user32::PeekMessageW(p $OpenBotWaitMessage, p 0, i 0, i 0, i ${PM_REMOVE}) i.s'
        Pop $OpenBotWaitAnswer
        ${If} $OpenBotWaitAnswer = 0
          ${ExitDo}
        ${EndIf}
        System::Call 'user32::TranslateMessage(p $OpenBotWaitMessage)'
        System::Call 'user32::DispatchMessageW(p $OpenBotWaitMessage)'
      ${Loop}
      Sleep 100
      IntOp $OpenBotWaitTenths $OpenBotWaitTenths + 1
    ${Loop}
    System::Free $OpenBotWaitMessage
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $OpenBotUninstallFirst = 1
    !insertmacro OPENBOT_UNINSTALL_OLD_VERSION
  ${EndIf}
  !insertmacro OPENBOT_STOP_BUNDLED_CLI
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro OPENBOT_STOP_WHAT_OPENBOT_RUNS
  ${EndIf}
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
