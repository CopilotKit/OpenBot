//! A Podman machine too small for local setup, made bigger for the person on a Mac once they say so.
//!
//! **What the CLI asks of it.** Its resource check at `local setup` wants 4 CPUs in all (the
//! engine's `NCPU`, whatever runs in it) and 4 GiB of memory free for new containers, measured inside
//! the machine (`measureLocalResources` in the CLI's `local-resources.ts`). A machine short of either
//! is raised to at least 6 CPUs, or to enough memory for what runs in it plus the 4 GiB free.
//!
//! **What Podman allows, in Podman 6.1.** `podman machine set --cpus N --memory MiB NAME` changes
//! a machine's size, and only while it is stopped: applehv and libkrun answer "unable to change
//! settings unless vm is stopped" otherwise (`apple.SetProviderAttrs`). Both keep the new size in
//! the machine's own configuration and use it from the next `podman machine start`. Neither may
//! exceed this computer: "requested number of CPUs (N) greater than number of host CPUs (M)",
//! and the same for memory (`checkMaxCPUs`, `checkMaxMemory` in `cmd/podman/machine/init.go`).
//! Nothing about root changes: the machine OpenBot uses is already rootful (a rootless one is passed
//! over, see `own_machine`). On Windows a machine is a WSL distribution and refuses both ("changing
//! CPUs not supported for WSL machines"), so there is nothing to offer there, nor a command to give.
//!
//! **What happens to the person's machine.** Only its CPUs and memory change, and only upwards.
//! Stopping it stops the containers in it; the ones that were running, in either of its engines,
//! are started again with it, as after a Podman update (`acquire::start_machine_named`). A size
//! Podman refuses still ends with the machine started again, as it was.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acquire::{self, Containers, MACHINE};

/// What the CLI needs: CPUs in all, and memory available to new containers.
const NEEDED_CPUS: u64 = 4;
const FREE_MEMORY_MIB: f64 = 4.0 * 1024.0;
/// The least a too-small machine is raised to, as the manual step always said.
pub const CPUS: u64 = 6;
pub const MEMORY_MIB: u64 = 8 * 1024;
/// Memory left to the Mac itself when the machine's is raised.
const LEFT_FOR_THE_MAC_MIB: u64 = 4 * 1024;

/// What the CLI found short, as the window has it (`local_eval::Shortfall`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Short {
    #[serde(default)]
    pub cpu: bool,
    #[serde(default)]
    pub memory: bool,
    #[serde(default)]
    pub disk: bool,
    /// The GiB of memory it measured free, as the window says it: "2.9".
    pub memory_gb: Option<String>,
    #[serde(default)]
    pub wsl: bool,
}

/// A machine's size: CPUs, and memory in MiB as Podman counts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub cpus: u64,
    pub memory_mib: u64,
}

/// How the machine OpenBot runs on would be made big enough, and whether OpenBot can do it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub machine: String,
    /// What it has now.
    pub cpus: u64,
    pub memory_mib: u64,
    /// What it would have. Never less than now.
    pub to_cpus: u64,
    pub to_memory_mib: u64,
    /// OpenBot can make the change itself. Otherwise the window gives the person the commands.
    pub for_them: bool,
}

/// The machine `name`'s size and whether it runs, from `podman machine inspect`.
pub fn inspected(listing: &str, name: &str) -> Result<(Size, bool), String> {
    let machines: Vec<Value> = serde_json::from_str(listing)
        .map_err(|error| format!("could not read podman machine inspect JSON: {error}"))?;
    let found = machines
        .iter()
        .find(|entry| entry.get("Name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| format!("podman machine inspect did not return {name}"))?;
    let number = |key: &str| {
        found
            .pointer(&format!("/Resources/{key}"))
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("podman machine inspect gave {name} no Resources.{key}"))
    };
    let running = found
        .get("State")
        .and_then(Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("running"));
    Ok((
        Size {
            cpus: number("CPUs")?,
            memory_mib: number("Memory")?,
        },
        running,
    ))
}

/**
How big `machine` would have to be for what the CLI found short, on a computer of size `host`.

CPUs: `CPUS`, as the CLI counts every CPU the machine has. Memory: what runs in it now (its size
less what the CLI found free) plus the 4 GiB the CLI wants free, in whole GiB with 2 to spare for
what the machine keeps for itself, never under `MEMORY_MIB`, and never so much that the Mac keeps
less than `LEFT_FOR_THE_MAC_MIB`. Neither goes past this computer, nor below what the machine has.

`None` when making it bigger is no answer: nothing it could be given is short, a WSL machine, or
this computer has no more to give.
*/
pub fn plan(machine: &str, size: Size, host: Size, short: &Short, mac: bool) -> Option<Plan> {
    if !(short.cpu || short.memory) || short.wsl {
        return None;
    }
    let measured =
        |said: &Option<String>| said.as_deref().and_then(|said| said.parse::<f64>().ok());
    let to_cpus = if short.cpu {
        CPUS.min(host.cpus).max(size.cpus)
    } else {
        size.cpus
    };
    let to_memory_mib = if short.memory {
        let free = measured(&short.memory_gb).map_or(0.0, |gib| gib * 1024.0);
        let used = (size.memory_mib as f64 - free).max(0.0);
        let wanted = (((used + FREE_MEMORY_MIB) / 1024.0).ceil() as u64 + 2) * 1024;
        wanted
            .max(MEMORY_MIB)
            .min(host.memory_mib.saturating_sub(LEFT_FOR_THE_MAC_MIB))
            .max(size.memory_mib)
    } else {
        size.memory_mib
    };
    let raised = (!short.cpu || to_cpus >= NEEDED_CPUS.max(size.cpus + 1))
        && (!short.memory || to_memory_mib > size.memory_mib);
    raised.then(|| Plan {
        machine: machine.to_string(),
        cpus: size.cpus,
        memory_mib: size.memory_mib,
        to_cpus,
        to_memory_mib,
        // A short disk is the person's to free or raise, so the whole fix stays theirs to run.
        for_them: mac && !short.disk,
    })
}

/**
Make `machine` `to` in size: stop it, set its CPUs and memory, start it again with the containers
that were running in it. Only what is larger than now is set.

`run` is `podman`. `start_own` starts OpenBot's own machine, which `acquire::start_machine` brings up
with its networking; anybody else's is started here.
*/
pub fn resize_with(
    machine: &str,
    to: Size,
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    start_own: impl FnOnce(&Containers) -> Result<(), String>,
) -> Result<(), String> {
    let (size, running) = inspected(&run(&["machine", "inspect", machine])?, machine)?;
    let cpus = (to.cpus > size.cpus).then(|| to.cpus.to_string());
    let memory = (to.memory_mib > size.memory_mib).then(|| to.memory_mib.to_string());
    if cpus.is_none() && memory.is_none() {
        return Ok(());
    }
    let containers = if running {
        acquire::running_containers_with(run, machine)
    } else {
        Vec::new()
    };
    if running {
        run(&["machine", "stop", machine])?;
    }
    let mut args = vec!["machine", "set"];
    if let Some(cpus) = &cpus {
        args.extend(["--cpus", cpus]);
    }
    if let Some(memory) = &memory {
        args.extend(["--memory", memory]);
    }
    args.push(machine);
    let set = run(&args).map(|_| ());
    // Started again whether the size took or not: the machine is never left stopped.
    let started = if machine == MACHINE {
        start_own(&containers)
    } else {
        start_with(run, machine, &containers)
    };
    set?;
    started
}

fn start_with(
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    machine: &str,
    containers: &Containers,
) -> Result<(), String> {
    match run(&["machine", "start", machine]) {
        Ok(_) => {}
        Err(error) if error.contains("already running") => {}
        Err(error) => return Err(error),
    }
    acquire::start_containers_with(run, containers);
    Ok(())
}

/// This computer's CPUs and memory, as Podman checks a machine's size against them. A Mac only.
#[cfg(target_os = "macos")]
fn host() -> Option<Size> {
    let cpus = std::thread::available_parallelism().ok()?.get() as u64;
    let mut bytes: u64 = 0;
    let mut length = std::mem::size_of::<u64>();
    // SAFETY: `hw.memsize` is a 64-bit integer, written into `bytes`, whose size is `length`.
    let answered = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (answered == 0 && bytes > 0).then_some(Size {
        cpus,
        memory_mib: bytes / (1024 * 1024),
    })
}

#[cfg(not(target_os = "macos"))]
fn host() -> Option<Size> {
    None
}

/// The plan for the machine the CLI runs on, for what it found short. `None` off a Mac, off Podman,
/// or when the machine can't be asked.
pub fn plan_here(short: &Short) -> Option<Plan> {
    let machine = crate::local_eval::engine_machine()?;
    let host = host()?;
    let listing = acquire::podman(&["machine", "inspect", &machine])
        .inspect_err(|error| log::warn!("[machine-size] could not inspect {machine}: {error}"))
        .ok()?;
    let (size, _) = inspected(&listing, &machine).ok()?;
    let plan = plan(&machine, size, host, short, cfg!(target_os = "macos"));
    log::info!(
        "[machine-size] {machine} has {} CPUs and {} MiB; this Mac {} CPUs and {} MiB; short {:?}; plan {:?}",
        size.cpus,
        size.memory_mib,
        host.cpus,
        host.memory_mib,
        short,
        plan
    );
    plan
}

/// The person said yes: make the machine the CLI runs on `to` in size. The machine is the one the
/// CLI runs on, never one the window names.
pub fn resize_here(to: Size) -> Result<(), String> {
    let machine = crate::local_eval::engine_machine()
        .ok_or_else(|| "OpenBot isn't running on a Podman machine".to_string())?;
    if !cfg!(target_os = "macos") {
        return Err("Podman can change a machine's size only on a Mac".to_string());
    }
    log::info!(
        "[machine-size] resizing {machine} to {} CPUs and {} MiB",
        to.cpus,
        to.memory_mib
    );
    let resized = resize_with(&machine, to, &mut acquire::podman, |containers| {
        acquire::start_machine_named(MACHINE, containers)
    });
    match &resized {
        Ok(()) => log::info!("[machine-size] {machine} resized and started again"),
        Err(error) => log::warn!("[machine-size] could not resize {machine}: {error}"),
    }
    resized
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `podman machine inspect` for a person's own rootful machine, as Podman 6.1.1 on a Mac
    /// prints it, at `cpus` CPUs and `memory` MiB, `state` "running" or "stopped".
    fn inspect(name: &str, cpus: u64, memory: u64, state: &str) -> String {
        format!(
            r#"[
     {{
          "ConfigDir": {{
               "Path": "/Users/you/.config/containers/podman/machine/applehv"
          }},
          "ConnectionInfo": {{
               "PodmanSocket": {{
                    "Path": "/var/folders/15/cbm93f0549jbtwnp4vn063r00000gn/T/podman/{name}-api.sock"
               }},
               "PodmanPipe": null
          }},
          "Created": "2026-09-04T12:27:09.759354-07:00",
          "LastUp": "2026-11-10T13:16:48.278763-08:00",
          "Name": "{name}",
          "Resources": {{
               "CPUs": {cpus},
               "DiskSize": 100,
               "Memory": {memory},
               "USBs": []
          }},
          "SSHConfig": {{
               "IdentityPath": "/Users/you/.local/share/containers/podman/machine/machine",
               "Port": 59316,
               "RemoteUsername": "core"
          }},
          "State": "{state}",
          "UserModeNetworking": true,
          "Rootful": true,
          "Rosetta": false
     }}
]"#
        )
    }

    /// The report's shortfall for the rc.12 CLI's "2 CPUs (requires 4), 5.2 GiB RAM available
    /// (requires 4), 51 GiB free storage (requires 40)", as `local_eval::shortfall_of` reads it.
    /// The CLI counts every CPU the machine has.
    fn cpu_short() -> Short {
        Short {
            cpu: true,
            memory_gb: Some("5.2".to_string()),
            ..Short::default()
        }
    }

    const MAC: Size = Size {
        cpus: 10,
        memory_mib: 16 * 1024,
    };

    const TWO: Size = Size {
        cpus: 2,
        memory_mib: 6144,
    };

    /// A 2-CPU machine, short of the CLI's 4, is raised to 6 and nothing else about it changes.
    #[test]
    fn a_two_cpu_machine_is_raised_to_6() {
        let plan = plan("podman-machine-default", TWO, MAC, &cpu_short(), true)
            .expect("a bigger machine fixes it");
        assert_eq!(
            plan,
            Plan {
                machine: "podman-machine-default".to_string(),
                cpus: 2,
                memory_mib: 6144,
                to_cpus: 6,
                to_memory_mib: 6144,
                for_them: true,
            }
        );
        assert!(plan.to_cpus >= NEEDED_CPUS);
    }

    /// Never past this computer: a 4-CPU Mac gives 4, which is enough. A Mac with fewer than 4 CPUs
    /// can never give the machine 4, so nothing is offered and the row's sentence stands alone.
    #[test]
    fn cpus_never_go_past_this_mac_and_too_few_offers_nothing() {
        let four_mac = Size { cpus: 4, ..MAC };
        assert_eq!(
            plan("m", TWO, four_mac, &cpu_short(), true)
                .unwrap()
                .to_cpus,
            4
        );
        let three_mac = Size { cpus: 3, ..MAC };
        assert_eq!(plan("m", TWO, three_mac, &cpu_short(), true), None);
    }

    /// "Docker memory: 7.6 GiB total, 2.9 GiB available to new containers (requires 4 GiB
    /// available)": memory raised so 4 GiB is free, with room the machine keeps, never under 8 GiB
    /// and leaving the Mac 4 GiB.
    #[test]
    fn memory_is_raised_to_leave_4_gib_free_and_the_mac_its_own() {
        let short = Short {
            memory: true,
            memory_gb: Some("2.9".to_string()),
            ..Short::default()
        };
        let small = Size {
            cpus: 4,
            memory_mib: 4096,
        };
        assert_eq!(
            plan("m", small, MAC, &short, true).unwrap().to_memory_mib,
            8192
        );
        let big = Size {
            cpus: 4,
            memory_mib: 12 * 1024,
        };
        // 12 GiB with 2.9 free: 9.1 used + 4 = 13.1, so 14, and 2 to spare: 16, less the Mac's 4.
        assert_eq!(plan("m", big, MAC, &short, true), None);
        let roomy_mac = Size {
            cpus: 10,
            memory_mib: 32 * 1024,
        };
        assert_eq!(
            plan("m", big, roomy_mac, &short, true)
                .unwrap()
                .to_memory_mib,
            16 * 1024
        );
    }

    /// A short disk is the person's to free; WSL can't be resized at all; nothing short, nothing.
    #[test]
    fn what_is_not_offered() {
        let four = Size {
            cpus: 4,
            memory_mib: 6144,
        };
        let with_disk = Short {
            disk: true,
            ..cpu_short()
        };
        assert!(!plan("m", TWO, MAC, &with_disk, true).unwrap().for_them);
        assert!(!plan("m", TWO, MAC, &cpu_short(), false).unwrap().for_them);
        let wsl = Short {
            wsl: true,
            ..cpu_short()
        };
        assert_eq!(plan("m", TWO, MAC, &wsl, true), None);
        assert_eq!(plan("m", four, MAC, &Short::default(), true), None);
    }

    /// Podman as the commands reach it, answering as Podman 6.1.1 does on a Mac, and refusing a
    /// change to a running machine as applehv does.
    struct FakePodman {
        name: String,
        size: Size,
        running: bool,
        rootless: Vec<String>,
        rootful: Vec<String>,
        ran: Vec<String>,
    }

    impl FakePodman {
        fn new(name: &str, cpus: u64, memory_mib: u64) -> Self {
            FakePodman {
                name: name.to_string(),
                size: Size { cpus, memory_mib },
                running: true,
                rootless: vec![],
                rootful: vec!["3f1c2b9a7d4e".to_string(), "9b8e4c1d2a3f".to_string()],
                ran: vec![],
            }
        }

        fn run(&mut self, args: &[&str]) -> Result<String, String> {
            self.ran.push(args.join(" "));
            let name = self.name.clone();
            let root = format!("{name}-root");
            match args {
                ["machine", "inspect", machine] if *machine == name => Ok(inspect(
                    &name,
                    self.size.cpus,
                    self.size.memory_mib,
                    if self.running { "running" } else { "stopped" },
                )),
                ["--connection", connection, "ps", "--quiet"] => {
                    if !self.running {
                        return Err(format!("podman --connection {connection} ps --quiet exited with exit status: 125; stderr: Cannot connect to Podman."));
                    }
                    Ok(if *connection == root {
                        self.rootful.join("\n")
                    } else {
                        self.rootless.join("\n")
                    })
                }
                ["machine", "stop", machine] if *machine == name => {
                    self.running = false;
                    Ok(format!("Machine \"{name}\" stopped successfully"))
                }
                ["machine", "set", rest @ ..] if rest.last() == Some(&name.as_str()) => {
                    if self.running {
                        return Err(format!("podman {} exited with exit status: 125; stderr: Error: unable to change settings unless vm is stopped", args.join(" ")));
                    }
                    let mut flags = rest[..rest.len() - 1].chunks(2);
                    while let Some([flag, value]) = flags.next() {
                        let value: u64 = value.parse().unwrap();
                        match *flag {
                            "--cpus" if value > MAC.cpus => {
                                return Err(format!("Error: requested number of CPUs ({value}) greater than number of host CPUs ({})", MAC.cpus));
                            }
                            "--cpus" => self.size.cpus = value,
                            "--memory" => self.size.memory_mib = value,
                            other => panic!("unexpected flag {other}"),
                        }
                    }
                    Ok(String::new())
                }
                ["machine", "start", machine] if *machine == name => {
                    self.running = true;
                    Ok(format!("Starting machine \"{name}\"\n\nThis machine is currently configured in rootful mode.\n\nMachine \"{name}\" started successfully"))
                }
                ["--connection", _, "start", ids @ ..] => Ok(ids.join("\n")),
                other => panic!("unexpected podman {other:?}"),
            }
        }
    }

    /// The button's whole path on the person's own machine: stopped, raised, started, and their
    /// containers running again, with nothing else of theirs touched.
    #[test]
    fn resizing_the_persons_machine_brings_it_and_its_containers_back_bigger() {
        let mut podman = FakePodman::new("podman-machine-default", 2, 6144);
        resize_with(
            "podman-machine-default",
            Size {
                cpus: 6,
                memory_mib: 6144,
            },
            &mut |args: &[&str]| podman.run(args),
            |_| panic!("not OpenBot's own machine"),
        )
        .expect("resized");
        assert_eq!(
            podman.size,
            Size {
                cpus: 6,
                memory_mib: 6144
            }
        );
        assert!(podman.running);
        assert_eq!(
            podman.ran,
            [
                "machine inspect podman-machine-default",
                "--connection podman-machine-default ps --quiet",
                "--connection podman-machine-default-root ps --quiet",
                "machine stop podman-machine-default",
                // Memory is not short, so it is not touched.
                "machine set --cpus 6 podman-machine-default",
                "machine start podman-machine-default",
                "--connection podman-machine-default-root start 3f1c2b9a7d4e 9b8e4c1d2a3f",
            ]
        );
    }

    /// Podman refused the size: the machine is started again as it was, with its containers, and
    /// the refusal is the answer.
    #[test]
    fn a_refused_size_still_starts_the_machine_again() {
        let mut podman = FakePodman::new("mine", 2, 6144);
        let refused = resize_with(
            "mine",
            Size {
                cpus: 12,
                memory_mib: 6144,
            },
            &mut |args: &[&str]| podman.run(args),
            |_| panic!("not OpenBot's own machine"),
        )
        .expect_err("more CPUs than the Mac has");
        assert!(
            refused.contains("greater than number of host CPUs"),
            "{refused}"
        );
        assert_eq!(
            podman.size,
            Size {
                cpus: 2,
                memory_mib: 6144
            }
        );
        assert!(podman.running);
        assert!(podman
            .ran
            .last()
            .unwrap()
            .starts_with("--connection mine-root start"));
    }

    /// OpenBot's own machine is started as OpenBot starts it, with its networking, and nothing is
    /// set when it is already big enough.
    #[test]
    fn openbots_own_machine_starts_its_own_way_and_a_big_one_is_left_alone() {
        let mut podman = FakePodman::new(MACHINE, 4, 6144);
        let mut started = None;
        resize_with(
            MACHINE,
            Size {
                cpus: 6,
                memory_mib: 8192,
            },
            &mut |args: &[&str]| podman.run(args),
            |containers| {
                started = Some(containers.clone());
                Ok(())
            },
        )
        .expect("resized");
        assert_eq!(
            podman.size,
            Size {
                cpus: 6,
                memory_mib: 8192
            }
        );
        assert_eq!(
            started.unwrap(),
            vec![(
                "openbot-root".to_string(),
                vec!["3f1c2b9a7d4e".to_string(), "9b8e4c1d2a3f".to_string()]
            )]
        );

        let mut big = FakePodman::new("mine", 8, 16384);
        resize_with(
            "mine",
            Size {
                cpus: 6,
                memory_mib: 8192,
            },
            &mut |args: &[&str]| big.run(args),
            |_| panic!("not OpenBot's own machine"),
        )
        .expect("nothing to do");
        assert_eq!(big.ran, ["machine inspect mine"]);
    }

    /// The window's shortfall, as `local_eval::Shortfall` serializes it, reads here.
    #[test]
    fn the_windows_shortfall_reads() {
        let short: Short = serde_json::from_str(
            r#"{"podman":true,"cpu":true,"memory":false,"disk":false,"cpus":"2","memoryGb":"5.2","diskGb":"51"}"#,
        )
        .unwrap();
        assert!(short.cpu && !short.memory && !short.disk && !short.wsl);
        assert_eq!(short.memory_gb.as_deref(), Some("5.2"));
    }

    /// A machine that stays running when its size is set (its stop did nothing, say) is refused as
    /// applehv refuses it, and is left running, its size as it was.
    #[test]
    fn a_machine_still_running_at_set_is_refused_and_left_running() {
        let mut podman = FakePodman::new("mine", 2, 6144);
        let refused = resize_with(
            "mine",
            Size {
                cpus: 6,
                memory_mib: 6144,
            },
            &mut |args: &[&str]| match args {
                ["machine", "stop", _] => Ok(String::new()),
                ["machine", "start", machine] if podman.running => Err(format!(
                    "Error: unable to start \"{machine}\": already running"
                )),
                _ => podman.run(args),
            },
            |_| panic!("not OpenBot's own machine"),
        )
        .expect_err("set on a running machine");
        assert!(refused.contains("unless vm is stopped"), "{refused}");
        assert_eq!(
            podman.size,
            Size {
                cpus: 2,
                memory_mib: 6144
            }
        );
        assert!(podman.running);
    }

    #[test]
    fn a_real_inspect_reads() {
        let (size, running) =
            inspected(&inspect("openbot-s1", 4, 6144, "stopped"), "openbot-s1").unwrap();
        assert_eq!(
            size,
            Size {
                cpus: 4,
                memory_mib: 6144
            }
        );
        assert!(!running);
    }
}

/**
The button's whole path on a real Mac, against a throwaway rootful machine only (`OPENBOT_LIVE_RESIZE`,
running, 2 CPUs and 4 GiB, with a container running in each of its engines). OpenBot is pointed at it
through its `-root` connection as the app points the CLI at its engine; the default connection and
every other machine are left alone. Run by hand:

```text
podman machine init obot-resize-test --cpus 2 --memory 4096 --rootful --now
podman --connection obot-resize-test-root run -d docker.io/library/alpine:3.20 sleep infinity
podman --connection obot-resize-test run -d docker.io/library/alpine:3.20 sleep infinity
OPENBOT_LIVE_RESIZE=obot-resize-test \
  cargo test --lib machine_size::live -- --ignored --nocapture --test-threads=1
podman machine rm -f obot-resize-test
```
*/
#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;

    fn podman(args: &[&str]) -> String {
        acquire::podman(args).unwrap_or_else(|error| panic!("podman {args:?}: {error}"))
    }

    fn default_connection() -> String {
        podman(&[
            "system",
            "connection",
            "list",
            "--format",
            "{{if .Default}}{{.Name}}{{end}}",
        ])
    }

    /// The machine as `podman machine inspect` has it, less what a restart changes by itself.
    fn inspected_whole(name: &str) -> Value {
        let mut listing: Value =
            serde_json::from_str(&podman(&["machine", "inspect", name])).unwrap();
        let machine = listing.get_mut(0).unwrap().as_object_mut().unwrap();
        machine.remove("LastUp");
        machine.clone().into()
    }

    fn without_size(machine: &Value) -> Value {
        let mut machine = machine.clone();
        let resources = machine["Resources"].as_object_mut().unwrap();
        resources.remove("CPUs");
        resources.remove("Memory");
        machine
    }

    fn sorted(mut containers: Containers) -> Containers {
        for (_, ids) in &mut containers {
            ids.sort();
        }
        containers.sort();
        containers
    }

    #[test]
    #[ignore = "stops, resizes and starts the throwaway Podman machine named in OPENBOT_LIVE_RESIZE"]
    fn the_button_resizes_a_real_machine_and_a_refusal_leaves_it_as_it_was() {
        let name = std::env::var("OPENBOT_LIVE_RESIZE").expect("OPENBOT_LIVE_RESIZE");
        let default_before = default_connection();
        let before = inspected_whole(&name);
        println!("[live] before: {before}");
        assert_eq!(before["State"], "running", "start {name} first");
        assert_eq!(
            before["Rootful"], true,
            "{name} must be rootful, as OpenBot's machine is"
        );
        let containers = sorted(acquire::running_containers(&name));
        println!("[live] containers running in {name}: {containers:?}");
        assert!(!containers.is_empty(), "start a container in {name} first");

        // OpenBot points the CLI at the machine's rootful connection, as the app does.
        crate::local_eval::use_engine(&crate::engine::Address::new(
            crate::engine::Engine::Podman,
            Some(acquire::connection_for(&name, true)),
        ));
        assert_eq!(
            crate::local_eval::engine_machine().as_deref(),
            Some(name.as_str())
        );

        // What the CLI found: 2 CPUs of 4, and too little memory free in a 4 GiB machine.
        let short = Short {
            cpu: true,
            memory: true,
            memory_gb: Some("2.9".to_string()),
            ..Short::default()
        };
        let host = host().expect("this Mac's size");
        let plan = plan_here(&short).expect("a bigger machine is the answer");
        println!("[live] this Mac: {host:?}; plan: {plan:?}");
        assert_eq!(plan.machine, name);
        assert_eq!((plan.cpus, plan.memory_mib), (2, 4096));
        assert_eq!(plan.to_cpus, CPUS.min(host.cpus));
        assert!(plan.to_memory_mib >= MEMORY_MIB);
        assert!(plan.for_them);

        // Yes: stopped, set, started, its containers running again.
        let started = std::time::Instant::now();
        resize_here(Size {
            cpus: plan.to_cpus,
            memory_mib: plan.to_memory_mib,
        })
        .expect("resized");
        println!("[live] resized in {:?}", started.elapsed());
        let after = inspected_whole(&name);
        println!("[live] after: {after}");
        assert_eq!(after["State"], "running");
        assert_eq!(after["Resources"]["CPUs"], plan.to_cpus);
        assert_eq!(after["Resources"]["Memory"], plan.to_memory_mib);
        assert_eq!(
            without_size(&after),
            without_size(&before),
            "only CPUs and memory change"
        );
        assert_eq!(sorted(acquire::running_containers(&name)), containers);
        let root = acquire::connection_for(&name, true);
        let cpus_inside = podman(&["--connection", &root, "info", "--format", "{{.Host.CPUs}}"]);
        println!("[live] CPUs the engine sees now: {cpus_inside}");
        assert_eq!(cpus_inside, plan.to_cpus.to_string());

        // Refused by Podman: more CPUs than this Mac has. Started again as it was.
        let refused = resize_here(Size {
            cpus: host.cpus + 1,
            memory_mib: plan.to_memory_mib,
        })
        .expect_err("more CPUs than this Mac has");
        println!("[live] refused: {refused}");
        assert!(
            refused.contains("greater than number of host CPUs"),
            "{refused}"
        );
        assert_eq!(inspected_whole(&name), after, "a refusal changes nothing");
        assert_eq!(sorted(acquire::running_containers(&name)), containers);

        // Refused by Podman: still running when its size is set. Left running as it was.
        let refused = resize_with(
            &name,
            Size {
                cpus: plan.to_cpus + 1,
                memory_mib: plan.to_memory_mib,
            },
            &mut |args: &[&str]| match args {
                ["machine", "stop", _] => Ok(String::new()),
                _ => acquire::podman(args),
            },
            |_| panic!("not OpenBot's own machine"),
        )
        .expect_err("set on a running machine");
        println!("[live] refused while running: {refused}");
        assert!(refused.contains("unless vm is stopped"), "{refused}");
        assert_eq!(inspected_whole(&name), after, "a refusal changes nothing");
        assert_eq!(sorted(acquire::running_containers(&name)), containers);

        assert_eq!(
            default_connection(),
            default_before,
            "the default connection is left alone"
        );
    }
}
