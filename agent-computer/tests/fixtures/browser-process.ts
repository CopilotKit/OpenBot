/**
 * The browser's own process on one profile, read from a `ps -axo pid=,ppid=,command=` listing.
 *
 * A process on the profile with no `--type` is a browser: its renderers, GPU and utility processes
 * all carry one. One that the browser itself started is not a second browser, though. Google Chrome
 * on Linux checks whether a newer version was installed under it by running its own binary with its
 * own command line and `--product-version` added (`upgrade_detector/get_installed_version_linux.cc`),
 * a child that prints the version and exits without opening the profile. The person-browser test
 * once caught one of those alive and failed with "found 2". So the browsers are the processes on
 * the profile whose parent is not one of them: two of those would be two browsers on one profile,
 * which Chrome refuses and these tests must not miss.
 */
export function browsersOnProfile(
  listing: string,
  profile: string,
): { pid: number; line: string }[] {
  const onProfile = listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid = "", ppid = "", ...command] = line.split(/\s+/);
      return {
        pid: Number.parseInt(pid, 10),
        ppid: Number.parseInt(ppid, 10),
        command,
        line,
      };
    })
    .filter(
      ({ command }) =>
        command.includes(`--user-data-dir=${profile}`) &&
        !command.some((arg) => arg.startsWith("--type=")),
    );
  const pids = new Set(onProfile.map(({ pid }) => pid));
  return onProfile
    .filter(({ ppid }) => !pids.has(ppid))
    .map(({ pid, line }) => ({ pid, line }));
}
