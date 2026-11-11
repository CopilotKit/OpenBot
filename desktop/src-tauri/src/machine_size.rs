//! A Podman machine too small for local setup, made bigger for the person on a Mac once they say so.
//!
//! **Why a 4-CPU machine fails "4 CPUs".** The CLI's resource check at `local setup` measures free
//! CPUs, not the machine's size: the engine's `NCPU` less what the containers running in it use
//! over a one-second sample (`measureLocalResources` in the CLI's `local-resources.ts`). A machine
//! with 4 CPUs and anything at all running in it, the person's own containers included, measures
//! 3.9 or so and is refused against a requirement of 4. Only a bigger machine passes, so that is
//! what is offered: enough CPUs that what is running now still leaves 4 free, with one to spare.
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

/// What the CLI needs free: CPUs, and GiB of memory available to new containers.
const FREE_CPUS: f64 = 4.0;
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
    /// What it measured free, as the window says it: "3.9".
    pub cpus: Option<String>,
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

CPUs: what runs now (its size less what the CLI found free) plus the 4 the CLI wants free, plus
one to spare, and never under `CPUS`. Memory likewise in whole GiB, with 2 GiB to spare for what
the machine keeps for itself, never under `MEMORY_MIB`, and never so much that the Mac keeps less
than `LEFT_FOR_THE_MAC_MIB`. Neither goes past this computer, nor below what the machine has.

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
        let free = measured(&short.cpus).unwrap_or(0.0);
        let used = (size.cpus as f64 - free).max(0.0);
        let wanted = (used + FREE_CPUS).ceil() as u64 + 1;
        wanted.max(CPUS).min(host.cpus).max(size.cpus)
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
    let raised =
        (!short.cpu || to_cpus > size.cpus) && (!short.memory || to_memory_mib > size.memory_mib);
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

    /// The report's shortfall for the CLI's "3.9 CPUs (requires 4), 5.2 GiB RAM available
    /// (requires 4), 51 GiB free storage (requires 40)", as `local_eval::shortfall_of` reads it.
    fn cpu_short(free: &str) -> Short {
        Short {
            cpu: true,
            cpus: Some(free.to_string()),
            memory_gb: Some("5.2".to_string()),
            ..Short::default()
        }
    }

    const MAC: Size = Size {
        cpus: 10,
        memory_mib: 16 * 1024,
    };

    /// The reported case: a 4-CPU machine with containers of the person's running in it measured
    /// 3.9 free against 4. Not a rounding slip: anything running leaves a 4-CPU machine short.
    /// Raised to 6, which leaves 5.9 free.
    #[test]
    fn a_four_cpu_machine_measured_at_3_9_free_is_raised_to_6() {
        let mine = Size {
            cpus: 4,
            memory_mib: 6144,
        };
        let plan = plan("podman-machine-default", mine, MAC, &cpu_short("3.9"), true)
            .expect("a bigger machine fixes it");
        assert_eq!(
            plan,
            Plan {
                machine: "podman-machine-default".to_string(),
                cpus: 4,
                memory_mib: 6144,
                to_cpus: 6,
                to_memory_mib: 6144,
                for_them: true,
            }
        );
        // What the CLI then measures with the same containers running: 6 less the same 0.1.
        assert!(plan.to_cpus as f64 - (4.0 - 3.9) >= FREE_CPUS);
    }

    /// The CLI's other numbers, from `local_eval`'s own fixtures: busier machines get what they need.
    #[test]
    fn a_busy_machine_gets_enough_for_what_runs_in_it() {
        let six = Size {
            cpus: 6,
            memory_mib: 8192,
        };
        // 6 CPUs, 2.5 used, 3.5 free: 2.5 + 4 = 6.5, so 7, and one to spare.
        assert_eq!(
            plan("m", six, MAC, &cpu_short("3.5"), true)
                .unwrap()
                .to_cpus,
            8
        );
        // Never past this computer: an 8-CPU Mac gives 8.
        let small_mac = Size { cpus: 8, ..MAC };
        assert_eq!(
            plan("m", six, small_mac, &cpu_short("1.2"), true)
                .unwrap()
                .to_cpus,
            8
        );
        // A 4-CPU Mac has no more to give: nothing to offer, the sentence alone.
        let four = Size {
            cpus: 4,
            memory_mib: 6144,
        };
        assert_eq!(
            plan("m", four, Size { cpus: 4, ..MAC }, &cpu_short("3.9"), true),
            None
        );
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
            ..cpu_short("3.9")
        };
        assert!(!plan("m", four, MAC, &with_disk, true).unwrap().for_them);
        assert!(
            !plan("m", four, MAC, &cpu_short("3.9"), false)
                .unwrap()
                .for_them
        );
        let wsl = Short {
            wsl: true,
            ..cpu_short("3.9")
        };
        assert_eq!(plan("m", four, MAC, &wsl, true), None);
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
        let mut podman = FakePodman::new("podman-machine-default", 4, 6144);
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
        let mut podman = FakePodman::new("mine", 4, 6144);
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
                cpus: 4,
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
            r#"{"podman":true,"cpu":true,"memory":false,"disk":false,"cpus":"3.9","memoryGb":"5.2","diskGb":"51"}"#,
        )
        .unwrap();
        assert!(short.cpu && !short.memory && !short.disk && !short.wsl);
        assert_eq!(short.cpus.as_deref(), Some("3.9"));
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
