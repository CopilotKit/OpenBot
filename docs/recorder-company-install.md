# Company install of the OpenBot Recorder

The OpenBot Recorder is a Chrome and Edge extension that records a person doing a task in their own browser and sends it to your Intelligence as a trajectory. OpenBot connects the browser and hands out each capture pass for the Bot the person picked; it keeps nothing the Recorder records. This guide is for the IT team that installs it for everyone and pins it to your OpenBot. It has no store listing, so your team hosts the package.

## Before you start: the Intelligence settings capture needs

This comes first because the most common failure is here. Check each item before you roll the extension out.

- The licence feature `trajectories`. It is off on every plan until your licence grants it.
- `FF_LEARNING_TRAJECTORIES=true` on Intelligence.
- `INTELLIGENCE_GATEWAY_WS_URL` on OpenBot set to the public WSS origin that browsers can reach. The runtime derives `/client` from it. An in-cluster address does not work, because the capture socket opens from the person's browser.
- `CHECK_ORIGIN` on the realtime gateway. If it is set, it must list the extension's origin, `chrome-extension://icpcnhgjghecmklnjbccdgdicklblcgd`. The value is a comma-separated list with no spaces, because the gateway splits it on commas and does not trim spaces.
- For the Recorder to confirm a Bot's Learning space, Intelligence's Learning delivery: `LEARNING_RUNTIME_ENABLED`, your organization in the Learning rollout, and the `self_learning` licence feature. Without it every Bot reads "Learning may not see this recording", because the only way OpenBot can ask whether a Learning space exists is the Learning skills read, and Intelligence answers it only with delivery on.

**Intelligence gap on ECS:** Intelligence's ECS template sets the realtime gateway's `CHECK_ORIGIN` from its required `PublicAppOrigin` parameter (`deploy/ecs/cloudformation/release.yaml`: the gateway task definition's `CHECK_ORIGIN: !Ref PublicAppOrigin`; `PublicAppOrigin` has no default, must match `^https://.+$`, and also feeds `APP_FRONTEND_ORIGIN`, `PUBLIC_APP_ORIGIN` and `ALLOWED_ORIGINS`), so on ECS the extension's origin cannot be added without changing the template. Docker Compose and Helm installs that leave `CHECK_ORIGIN` unset accept the extension; an install that sets it adds `chrome-extension://icpcnhgjghecmklnjbccdgdicklblcgd` to the list, comma-separated with no spaces (the gateway splits the value on commas and does not trim spaces, `apps/realtime-gateway/config/runtime.exs`, its `check_origin = case System.get_env("CHECK_ORIGIN")`).

Which installs set it today (Intelligence main `48b9528da`): the Helm chart's own default is `checkOrigin: 'false'`, which accepts every origin (`charts/copilot-intelligence/values.yaml`; `templates/realtime-gateway/deployment.yaml` sets `CHECK_ORIGIN` only when a value is given). But Intelligence's installer asks for `REALTIME_CHECK_ORIGIN` with the Intelligence UI origin as its default (`scripts/install.sh`), and the example values set it to that origin (`values-aws-example.yaml`, `values-onprem-example.yaml`, `values-self-hosted-eval.yaml.example`). Most Helm installs therefore do set it, and must add the extension's origin.

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

After a change, use "Reload policies" in `chrome://policy`. A policy that names an address the Recorder cannot use refuses every connect, and the popup tells the person to ask IT.

## What people see

- Force-installed copies do not show Chrome's "started debugging this browser" bar (Chromium `debugger_api.cc`).
- People still click "Connect this browser" in OpenBot once to sign in.
- The options page shows "Set by your organization".
- What the Recorder keeps: clicks, typing, the pages people open and the network calls behind them, masked in the browser before anything leaves it. It records no screen and no sound.

## What has been tested and what has not

Tested here: the managed policy file on Linux (a test reads `OpenBotUrl` and pins the Recorder), and that a CRX packed with the Recorder's key keeps the fixed id `icpcnhgjghecmklnjbccdgdicklblcgd`.

Written from Google's and Microsoft's documentation and not run here: the force-install itself through `ExtensionInstallForcelist`, the hidden debugger bar, the Windows registry, macOS configuration profiles and the Google Admin console. Check each on the first managed computer you roll out to.

## Intelligence gaps

For the Intelligence team:

- No per-user erasure of trajectories.
- No server-side redaction. The Recorder's masking in the browser is the only line of defence.
- No general file store. A network body that does not fit in one event is cut to fit, and the rest is not kept anywhere. The Recorder records no screen or audio.
- No transcription, so the Recorder does not capture voice.
- The ECS `CHECK_ORIGIN` gap described in the first section.

## Known issue under investigation

In testing against Intelligence main (48b9528da), a self-hosted Intelligence whose organization id is not a UUID refused every capture socket with `entitlement_unavailable`, and the same setup with a UUID organization id worked. We are confirming with the Intelligence team whether self-hosted bootstrap organizations (`org_<slug>` ids) are affected. If the Recorder's Learning capture row keeps showing `entitlement_unavailable`, check your organization id.

## Sources

- [Configuring policy for extensions (Chromium)](https://www.chromium.org/administrators/configuring-policy-for-extensions/)
- [Set Chrome app and extension policies (Chrome Enterprise help)](https://support.google.com/chrome/a/answer/7532015)
- [ExtensionInstallForcelist policy definition (Chromium source)](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml)
- [Install extensions (developer.chrome.com)](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)
- [Host extensions on Linux (developer.chrome.com)](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
- [Use group policies to manage Microsoft Edge extensions (Microsoft Learn)](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-policies)
- [Microsoft Edge policy ExtensionInstallForcelist (Microsoft Learn)](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensioninstallforcelist)
