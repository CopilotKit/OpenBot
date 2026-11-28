; OpenBot's English text for the Windows installer: bundle.windows.nsis.customLanguageFiles in tauri.conf.json.
; https://v2.tauri.app/reference/config/#customlanguagefiles
;
; Tauri's own English.nsh from tauri-cli v2.11.4
; (crates/tauri-bundler/src/bundle/windows/nsis/languages/English.nsh), which this file replaces whole, with the
; three messages for a running OpenBot rewritten: appRunningOkKill, appRunning and failedToKillApp. The installer and
; the uninstaller both show them, in a box with OK and Cancel; OK closes OpenBot, Cancel stops. And the lines the
; Installing page shows while it brings Microsoft's WebView2 Runtime, which OpenBot's window is drawn with, on a
; computer that lacks it, in plain words: the webview2* strings and installingWebview2. Every other string is Tauri's,
; unchanged. desktop/scripts/installer-language.test.ts holds the list of strings to the Tauri CLI version.
LangString addOrReinstall ${LANG_ENGLISH} "Add/Reinstall components"
LangString alreadyInstalled ${LANG_ENGLISH} "Already Installed"
LangString alreadyInstalledLong ${LANG_ENGLISH} "${PRODUCTNAME} ${VERSION} is already installed. Select the operation you want to perform and click Next to continue."
LangString appRunning ${LANG_ENGLISH} "{{product_name}} is still open. Close it, then try again."
LangString appRunningOkKill ${LANG_ENGLISH} "{{product_name}} is open. Click OK to close it and continue."
LangString chooseMaintenanceOption ${LANG_ENGLISH} "Choose the maintenance option to perform."
LangString choowHowToInstall ${LANG_ENGLISH} "Choose how you want to install ${PRODUCTNAME}."
LangString createDesktop ${LANG_ENGLISH} "Create desktop shortcut"
LangString dontUninstall ${LANG_ENGLISH} "Do not uninstall"
LangString dontUninstallDowngrade ${LANG_ENGLISH} "Do not uninstall (Downgrading without uninstall is disabled for this installer)"
LangString failedToKillApp ${LANG_ENGLISH} "Couldn't close {{product_name}}. Close it yourself, then try again."
LangString installingWebview2 ${LANG_ENGLISH} "Installing a part of Windows that OpenBot's window needs. This takes a minute."
LangString newerVersionInstalled ${LANG_ENGLISH} "A newer version of ${PRODUCTNAME} is already installed! It is not recommended that you install an older version. If you really want to install this older version, it's better to uninstall the current version first. Select the operation you want to perform and click Next to continue."
LangString older ${LANG_ENGLISH} "older"
LangString olderOrUnknownVersionInstalled ${LANG_ENGLISH} "An $R4 version of ${PRODUCTNAME} is installed on your system. It's recommended that you uninstall the current version before installing. Select the operation you want to perform and click Next to continue."
LangString silentDowngrades ${LANG_ENGLISH} "Downgrades are disabled for this installer, can't proceed with the silent installer, please use the graphical interface installer instead.$\n"
LangString unableToUninstall ${LANG_ENGLISH} "Unable to uninstall!"
LangString uninstallApp ${LANG_ENGLISH} "Uninstall ${PRODUCTNAME}"
LangString uninstallBeforeInstalling ${LANG_ENGLISH} "Uninstall before installing"
LangString unknown ${LANG_ENGLISH} "unknown"
LangString webview2AbortError ${LANG_ENGLISH} "Couldn't install a part of Windows that OpenBot's window needs. Check your internet connection, then run the installer again."
LangString webview2DownloadError ${LANG_ENGLISH} "Couldn't download a part of Windows that OpenBot's window needs."
LangString webview2DownloadSuccess ${LANG_ENGLISH} "Downloaded a part of Windows that OpenBot's window needs."
LangString webview2Downloading ${LANG_ENGLISH} "Downloading a part of Windows that OpenBot's window needs."
LangString webview2InstallError ${LANG_ENGLISH} "Couldn't install a part of Windows that OpenBot's window needs (error $1)."
LangString webview2InstallSuccess ${LANG_ENGLISH} "Installed a part of Windows that OpenBot's window needs."
LangString deleteAppData ${LANG_ENGLISH} "Delete the application data"
