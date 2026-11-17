/*
 * "The person chose this computer, and what Windows needs for it is not finished."
 *
 * What a computer needs before OpenBot can run on it (on Windows: WSL, a Windows feature, a
 * restart) is looked at once the person has chosen this computer, with Install, never before the
 * choice: somebody connecting to an OpenBot that runs elsewhere installs nothing here. The fix
 * Windows needs can end the app with a restart, before anything of OpenBot is installed, so
 * nothing the shell records yet says the person had chosen. This does: kept from the Install that
 * found something in the way until a launch finds Windows ready, so that launch goes back to what
 * Windows needs and then on with the install, not to the choice again.
 *
 * In the window's own storage, which outlives the app and a restart. Storage that is gone or
 * refused costs one click: the choice shows, and Install picks up where Windows is.
 */
const KEY = "openbot.setup.this-computer";

export function choseThisComputer(): boolean {
  try {
    return localStorage.getItem(KEY) === "chosen";
  } catch {
    return false;
  }
}

export function rememberThisComputer(chosen: boolean): void {
  try {
    if (chosen) localStorage.setItem(KEY, "chosen");
    else localStorage.removeItem(KEY);
  } catch {
    // Nothing to keep it in: see above.
  }
}
