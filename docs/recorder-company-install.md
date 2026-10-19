# Company install of the OpenBot Recorder

The OpenBot Recorder is a Chrome and Edge extension that records a person doing a task in their own browser and sends it to your Intelligence as a trajectory. OpenBot only connects the browser and hands out each capture pass for the Bot the person picked; everything recorded goes straight from the browser to Intelligence. This guide is for the IT team that installs it for everyone and pins it to your OpenBot. It has no store listing, so your team hosts the package.

## Before you start: what your Intelligence needs

This comes first because the most common failure is here. Whoever runs your Intelligence checks each item before you roll the extension out.

- Your Intelligence licence includes the `trajectories` feature. It is off on every plan until your licence grants it.
- Trajectories are switched on in Intelligence: `FF_LEARNING_TRAJECTORIES=true`.
- OpenBot's `INTELLIGENCE_GATEWAY_WS_URL` is the public WSS address of your Intelligence realtime gateway, one every person's browser can reach. An address that only works inside your cluster does not work, because each recording is sent straight from the person's browser.
- The realtime gateway accepts the extension. If its allowed origins (`CHECK_ORIGIN`) are set, they must include `chrome-extension://icpcnhgjghecmklnjbccdgdicklblcgd`. The value is a comma-separated list with no spaces, because the gateway does not trim spaces. Many installs set this value to the address of the Intelligence app by default; if yours does, add the extension's origin beside it. If your way of installing Intelligence does not let you change it, ask whoever supports your Intelligence install.
- For the Recorder to confirm which Bots have a Learning space, Intelligence's Learning delivery is on: `LEARNING_RUNTIME_ENABLED`, your organization included in the Learning rollout, and the `self_learning` licence feature. Without it every Bot reads "Learning may not see this recording", because OpenBot can only check that a Learning space exists by asking Learning, and Intelligence answers only while Learning delivery is on.

## The extension's id

Every copy of the Recorder, in Chrome and in Edge, unpacked or installed by policy, has the id `icpcnhgjghecmklnjbccdgdicklblcgd`, because the build carries its public key. A fork, or a build signed with another key, has another id. OpenBot trusts it only when it is listed in `OPENBOT_RECORDER_EXTRA_EXTENSION_IDS`.

## Force-install it

There is no store listing, so your team hosts the package. Chrome installs an extension from outside the Chrome Web Store by policy only on managed computers:

- Windows computers joined to a Microsoft Active Directory domain. Google's help page says: "To automatically install an app or extension that's not in the Chrome Web Store, computers must be joined to a domain using Microsoft Active Directory." (Chrome's policy definition also lists Azure AD and Chrome Enterprise Core enrollment, but the help page does not, so plan on a domain-joined computer.) Edge force-installs an extension from outside the Microsoft Edge Add-ons website only on Windows joined to a Microsoft Active Directory domain, and on macOS managed through MDM or joined to a domain through MCX.
- macOS with the policy delivered as an MDM configuration profile.
- Linux with the policy file under `/etc/opt/chrome/policies/managed/`.

Steps:

1. Pack the release build into `openbot-recorder-<version>.crx` with Chrome's own packer: `chrome --pack-extension=<the unzipped release build> --pack-extension-key=<the Recorder's private key>`. Whoever holds that key runs this; the maintainers keep it outside every repository and never publish it. Chrome derives a packed extension's id from its signing key, so only a CRX signed with that key has the id `icpcnhgjghecmklnjbccdgdicklblcgd`. A company that packs with a key of its own gets another id, which it lists in `OPENBOT_RECORDER_EXTRA_EXTENSION_IDS` and in its policy instead. OpenBot builds and hosts nothing for this.
2. Host the CRX and an update manifest on an HTTPS server every managed browser can reach. The update manifest is the `gupdate` XML whose `appid` is the id and whose `codebase` is the CRX URL; its `version` matches the extension's manifest version.

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
     <app appid="icpcnhgjghecmklnjbccdgdicklblcgd">
       <updatecheck
         codebase="https://your-server.example.com/openbot-recorder/openbot-recorder-<version>.crx"
         version="<version>" />
     </app>
   </gupdate>
   ```

3. Set `ExtensionInstallForcelist` to `icpcnhgjghecmklnjbccdgdicklblcgd;https://your-server.example.com/openbot-recorder/update.xml` for Chrome, and the same list under Edge's policy of the same name. For Edge, Microsoft Learn names `ExtensionSettings` and its `override_update_url` setting for pinning the update address.
4. Confirm in `chrome://policy` and `chrome://extensions` (or `edge://policy` and `edge://extensions`) that the extension is installed and its id matches.

## Pin its address

Set `OpenBotUrl` (the HTTPS address of your OpenBot) and `AllowedIntelligenceUrls` (the WSS addresses of your Intelligence gateway; the Recorder refuses a capture pass that points anywhere else) in the extension's managed policy.

- Google Admin console: Apps and extensions, then the extension's policy JSON, for example `{"OpenBotUrl": {"Value": "https://openbot.example.com"}, "AllowedIntelligenceUrls": {"Value": ["wss://intelligence.example.com"]}}`.
- Windows registry: `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\icpcnhgjghecmklnjbccdgdicklblcgd\policy`, and for Edge `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\icpcnhgjghecmklnjbccdgdicklblcgd\policy`. List values are numbered subkeys.
- macOS configuration profiles: the preference domains `com.google.Chrome.extensions.icpcnhgjghecmklnjbccdgdicklblcgd` and `com.microsoft.Edge.extensions.icpcnhgjghecmklnjbccdgdicklblcgd`.
- Linux: the policy file under `/etc/opt/chrome/policies/managed/`, nested under `3rdparty`, `extensions`, then the id.

After a change, use "Reload policies" in `chrome://policy` (or `edge://policy`), then confirm both policies are listed under the Recorder's id with the status OK. A policy that is missing there has not reached the browser, and the Recorder behaves as if it were not set.

A value the Recorder cannot use is refused, never ignored:

- An `OpenBotUrl` that is not a plain HTTPS address such as `https://openbot.example.com`, or is not text at all, refuses every connect, and the popup tells the person to ask their IT team.
- An `AllowedIntelligenceUrls` that is not a list of WSS addresses, for example one address on its own, or on Windows a list not written as numbered subkeys, refuses every capture pass, so nothing can be recorded until it is fixed.

## Connecting through OpenBot Desktop

People can connect the Recorder from OpenBot in the browser, or from OpenBot Desktop on the same computer. The Desktop route uses a native messaging host named `ai.copilotkit.openbot.recorder`, which OpenBot Desktop registers for the person who runs it, in the Chrome, Edge and Chromium it finds. It is registered per person, not for the whole computer. Skip this section if nobody uses OpenBot Desktop.

Check two browser policies, in Chrome and in Edge alike:

- `NativeMessagingBlocklist`. If it is `*` (every host blocked), add `ai.copilotkit.openbot.recorder` to `NativeMessagingAllowlist`.
- `NativeMessagingUserLevelHosts`. If it is off, the browser ignores hosts registered per person, so the Desktop route does not work until you register the host for the whole computer, as below.

To register the host for the whole computer, deploy this file, with `path` set to the OpenBot Desktop program on that computer:

```json
{
  "name": "ai.copilotkit.openbot.recorder",
  "description": "OpenBot Desktop: lets the Recorder find this computer's OpenBot",
  "path": "<the full path of the OpenBot Desktop program>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://icpcnhgjghecmklnjbccdgdicklblcgd/"]
}
```

OpenBot Desktop writes the same file for each person when it starts (on Windows in `%LOCALAPPDATA%\OpenBot\recorder\`, on macOS and Linux in the browser's own `NativeMessagingHosts` folder), so the easiest way to get the exact `path` is to start Desktop once on a test computer and copy it from there. Put the file here:

- Windows: anywhere on the computer, with the default value of `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\ai.copilotkit.openbot.recorder` (Chrome) and `HKLM\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\ai.copilotkit.openbot.recorder` (Edge) set to its full path.
- macOS: `/Library/Google/Chrome/NativeMessagingHosts/ai.copilotkit.openbot.recorder.json` and `/Library/Microsoft/Edge/NativeMessagingHosts/ai.copilotkit.openbot.recorder.json`.
- Linux: `/etc/opt/chrome/native-messaging-hosts/ai.copilotkit.openbot.recorder.json` and `/etc/opt/edge/native-messaging-hosts/ai.copilotkit.openbot.recorder.json`.

When OpenBot Desktop is removed, the Windows uninstaller deletes the registrations it made for that person. On macOS and Linux nothing does: delete `ai.copilotkit.openbot.recorder.json` from each browser's `NativeMessagingHosts` folder in the person's profile. A file left behind does no harm; the Recorder just stops offering the Desktop route. Files you placed for the whole computer are yours to remove.

## What people see

- Force-installed copies do not show Chrome's "started debugging this browser" bar (Chromium `debugger_api.cc`).
- People still click "Connect this browser" in OpenBot once to sign in.
- The options page shows "Set by your organization".
- What the Recorder records: clicks, typing, the pages people open and the network calls behind them, masked in the browser before anything leaves it and sent only to your Intelligence. The browser keeps events only until Intelligence acknowledges them, or the person discards them.

## What has been tested and what has not

Tested here: the managed policy file on Linux (a test reads `OpenBotUrl` and pins the Recorder), and that a CRX packed with the Recorder's key keeps the fixed id `icpcnhgjghecmklnjbccdgdicklblcgd`.

Written from Google's and Microsoft's documentation and not run here: the force-install itself through `ExtensionInstallForcelist`, the hidden debugger bar, the Windows registry, macOS configuration profiles, the Google Admin console, and the native messaging policies and machine-level host registration for OpenBot Desktop. Check each on the first managed computer you roll out to.

## Sources

- [Configuring policy for extensions (Chromium)](https://www.chromium.org/administrators/configuring-policy-for-extensions/)
- [Set Chrome app and extension policies (Chrome Enterprise help)](https://support.google.com/chrome/a/answer/7532015)
- [ExtensionInstallForcelist policy definition (Chromium source)](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml)
- [Install extensions (developer.chrome.com)](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)
- [Host extensions on Linux (developer.chrome.com)](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
- [Use group policies to manage Microsoft Edge extensions (Microsoft Learn)](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-policies)
- [Microsoft Edge policy ExtensionInstallForcelist (Microsoft Learn)](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensioninstallforcelist)
- [Native messaging (developer.chrome.com)](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Native messaging (Microsoft Learn)](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [NativeMessagingAllowlist](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/NativeMessaging/NativeMessagingAllowlist.yaml), [NativeMessagingBlocklist](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/NativeMessaging/NativeMessagingBlocklist.yaml) and [NativeMessagingUserLevelHosts](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/NativeMessaging/NativeMessagingUserLevelHosts.yaml) policy definitions (Chromium source)
