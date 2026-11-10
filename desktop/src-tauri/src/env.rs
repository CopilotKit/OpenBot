//! The `.env` the shell writes, and the secrets it mints.
//!
//! `scripts/start.sh` writes the same file for a developer. This writes it for somebody who will
//! never open a terminal, which changes three things:
//!
//! - **No dev fallbacks.** `start.sh` falls back to fixed strings for `COMPUTER_TOKEN`,
//!   `SUPERVISOR_TOKEN` and `WORKER_SHARED_SECRET`, which are published in this repository. They are
//!   fine on a laptop somebody is debugging and they are not fine as the default a product ships.
//!   Every one of them is generated here.
//! - **A real `KEY_ENCRYPTION_KEY`.** `.env.example` carries a valid public key, and
//!   `server/src/config.ts` only throws on it under `NODE_ENV=production`. A desktop install is not
//!   production, so it would land in the warn branch and encrypt the credential vault with a key
//!   printed in a public repository, objected to by a `console.warn` nobody running a window reads.
//! - **The personal edition, always.** This app runs OpenBot for one person, so it writes
//!   `OPENBOT_EDITION=personal` and the settings that edition requires: its own package, one computer
//!   and no supervisor. Unset, the server runs the team edition.

use std::collections::BTreeMap;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;

use crate::engine::EngineStatus;

/**
Where a signed-in ChatGPT plan's token store lives, on this machine and inside the harness.

Two paths for one file, joined by a directory bind mount `docker-compose.yml` declares. It has to be
a file rather than a setting because the harness's provider WRITES to it: when the access token
expires it renews and saves, and the mount is what makes that renewal outlast the container.

The host file is always written, even when nobody signed in to a plan. That keeps the mounted
directory in the shape the provider expects and avoids leaving a stale plan token behind after
somebody switches away from the plan.
*/
pub const CHATGPT_STORE_FILE: &str = ".langchain/chatgpt-auth.json";
pub const CHATGPT_STORE_INSIDE: &str = "/root/.langchain/chatgpt-auth.json";

/// Host ports, persisted in this deployment's .env and reused while they remain available.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ports {
    pub app: u16,
    pub server: u16,
    pub postgres: u16,
    pub computer: u16,
    pub bot: u16,
    pub langgraph: u16,
    pub supervisor: u16,
    pub harness: Option<u16>,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            app: 3010,
            server: 3001,
            postgres: 5432,
            computer: 4100,
            bot: 4200,
            langgraph: 4201,
            supervisor: 4500,
            harness: None,
        }
    }
}

/// The `.env` keys a deployment's host ports are kept under.
const PORT_KEYS: [&str; 8] = [
    "APP_PORT",
    "SERVER_PORT",
    "POSTGRES_PORT",
    "COMPUTER_PORT",
    "BOT_PORT",
    "LANGGRAPH_PORT",
    "SUPERVISOR_PORT",
    "PICKED_HARNESS_HOST_PORT",
];

/**
How long Start waits for the ports its own last run left behind before it moves off them
([`Ports::for_start`]).

Thirty seconds because that is the longest a closed TCP connection keeps its port on macOS
(`TIME_WAIT`, twice `net.inet.tcp.msl`, which is 15 s), and a port is not bindable without
`SO_REUSEADDR` (see `bind_exclusive`) until it has passed. Paid only while one of those ports is
still held, so a normal Start waits for none of it.
*/
pub const OWN_PORTS_PATIENCE: std::time::Duration = std::time::Duration::from_secs(30);

impl Ports {
    /// The ports this deployment's `.env` records, which an earlier Start chose and its containers
    /// published. A fresh install records none.
    pub fn recorded(root: &Path) -> std::io::Result<std::collections::HashSet<u16>> {
        let values = read_already_set(&root.join(".env"), &PORT_KEYS)?;
        Ok(values
            .iter()
            .filter_map(|(key, value)| parse_port(key, value).ok())
            .collect())
    }

    /**
    The ports this Start runs on: [`Ports::available`], once the ports this deployment's own
    previous run left behind (`own`, from [`Ports::recorded`]) are free again, for at most
    `patience`.

    WHY. Quitting OpenBot takes its containers down, and the engine's port forwarder lets their
    host ports go a moment later, not at once. OpenBot opened again in that moment found its own
    app port held, took it for somebody else's, and moved the app off it: 3010 became 49381 on a
    plain quit and reopen, with nothing else on the machine using 3010 (Docker Desktop, macOS,
    2026-11-08). Everything that dials the app
    then had to learn a new address, and the app's origin, with what the browser keeps for it,
    changed. A port this deployment recorded and its running containers do not publish (`ours`)
    is most likely the last run's, still letting go, so Start waits for it to be bindable before
    deciding. A port somebody else holds is still moved, after the wait; it is recorded as the new
    one, so the wait is paid once. A port this deployment never recorded is not waited for.
    */
    pub fn for_start(
        self,
        own: &std::collections::HashSet<u16>,
        ours: &std::collections::HashSet<u16>,
        harness: Option<u16>,
        patience: std::time::Duration,
    ) -> std::io::Result<Self> {
        let mut waiting: Vec<u16> = self
            .settings()
            .values()
            .filter_map(|value| value.parse::<u16>().ok())
            .filter(|port| own.contains(port) && !ours.contains(port))
            .collect();
        waiting.sort_unstable();
        waiting.dedup();
        let deadline = std::time::Instant::now() + patience;
        loop {
            // A bind, as `available` decides, so a port in TIME_WAIT counts as held too.
            waiting.retain(|port| bind_loopbacks(*port).is_err());
            if waiting.is_empty() || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        self.available(ours, harness)
    }

    pub fn read(root: &Path) -> std::io::Result<Self> {
        let values = read_already_set(&root.join(".env"), &PORT_KEYS)?;
        let mut ports = Self::default();
        for (key, port) in [
            ("APP_PORT", &mut ports.app),
            ("SERVER_PORT", &mut ports.server),
            ("POSTGRES_PORT", &mut ports.postgres),
            ("COMPUTER_PORT", &mut ports.computer),
            ("BOT_PORT", &mut ports.bot),
            ("LANGGRAPH_PORT", &mut ports.langgraph),
            ("SUPERVISOR_PORT", &mut ports.supervisor),
        ] {
            if let Some(value) = values.get(key) {
                *port = parse_port(key, value)?;
            }
        }
        ports.harness = values
            .get("PICKED_HARNESS_HOST_PORT")
            .map(|value| parse_port("PICKED_HARNESS_HOST_PORT", value))
            .transpose()?;
        Ok(ports)
    }

    pub fn settings(&self) -> BTreeMap<String, String> {
        let mut settings: BTreeMap<_, _> = [
            ("APP_PORT", self.app),
            ("SERVER_PORT", self.server),
            ("POSTGRES_PORT", self.postgres),
            ("COMPUTER_PORT", self.computer),
            ("BOT_PORT", self.bot),
            ("LANGGRAPH_PORT", self.langgraph),
            ("SUPERVISOR_PORT", self.supervisor),
        ]
        .into_iter()
        .map(|(key, port)| (key.to_string(), port.to_string()))
        .collect();
        if let Some(port) = self.harness {
            settings.insert("PICKED_HARNESS_HOST_PORT".into(), port.to_string());
        }
        settings
    }

    /// A connect probe misses Windows excluded ports: only a bind proves a port is usable.
    /// Hold the probes until every port is chosen so allocations cannot collide with each other.
    /// Existing containers from this exact Compose project are reusable, never foreign listeners.
    /// The app and the API are among them: both are host ports of the one `server` container, so
    /// a running OpenBot keeps its own ports across a Start rather than being moved off them.
    pub fn available(
        self,
        ours: &std::collections::HashSet<u16>,
        harness: Option<u16>,
    ) -> std::io::Result<Self> {
        self.reserve(ours, harness).map(|(ports, _held)| ports)
    }

    /// [`Ports::available`], with the listeners that proved each port free still bound. Dropping
    /// them gives the ports back, which is what `available` does before Compose publishes them.
    fn reserve(
        self,
        ours: &std::collections::HashSet<u16>,
        harness: Option<u16>,
    ) -> std::io::Result<(Self, Vec<std::net::TcpListener>)> {
        let mut held = Vec::new();
        let mut chosen = std::collections::HashSet::new();
        let mut choose = |preferred| -> std::io::Result<u16> {
            if !chosen.contains(&preferred) {
                if ours.contains(&preferred) {
                    chosen.insert(preferred);
                    return Ok(preferred);
                }
                if let Ok(listeners) = bind_loopbacks(preferred) {
                    held.extend(listeners);
                    chosen.insert(preferred);
                    return Ok(preferred);
                }
            }
            let mut last = None;
            for _ in 0..32 {
                match bind_loopbacks(0) {
                    Ok(listeners) => {
                        let port = listeners[0].local_addr()?.port();
                        if chosen.insert(port) {
                            held.extend(listeners);
                            return Ok(port);
                        }
                    }
                    Err(error) => last = Some(error),
                }
            }
            Err(last.unwrap_or_else(|| {
                std::io::Error::other("could not allocate distinct local ports")
            }))
        };
        let ports = Self {
            app: choose(self.app)?,
            server: choose(self.server)?,
            postgres: choose(self.postgres)?,
            computer: choose(self.computer)?,
            bot: choose(self.bot)?,
            langgraph: choose(self.langgraph)?,
            supervisor: choose(self.supervisor)?,
            harness: harness
                .map(|default| choose(self.harness.unwrap_or(default)))
                .transpose()?,
        };
        Ok((ports, held))
    }
}

fn parse_port(key: &str, value: &str) -> std::io::Result<u16> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{key} must be a port from 1 to 65535"),
            )
        })
}

fn bind_loopbacks(port: u16) -> std::io::Result<Vec<std::net::TcpListener>> {
    // Windows lets a loopback bind succeed beside another program's wildcard listener even without
    // `SO_REUSEADDR`, so a port something already answers on is taken whatever the bind says. The
    // bind still decides the rest: it is what catches Windows' excluded port ranges.
    if port != 0 && something_listens(port) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            format!("something already listens on port {port}"),
        ));
    }
    let ipv4 = bind_exclusive((std::net::Ipv4Addr::LOCALHOST, port).into())?;
    let port = ipv4.local_addr()?.port();
    let mut held = vec![ipv4];
    match bind_exclusive((std::net::Ipv6Addr::LOCALHOST, port).into()) {
        Ok(ipv6) => held.push(ipv6),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
            ) => {}
        Err(error) => return Err(error),
    }
    Ok(held)
}

/// Whether anything accepts a connection on this port on either loopback right now.
fn something_listens(port: u16) -> bool {
    [
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
        std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
    ]
    .iter()
    .any(|address| {
        std::net::TcpStream::connect_timeout(address, std::time::Duration::from_millis(250)).is_ok()
    })
}

/**
Bind one address the way a port check must: without `SO_REUSEADDR`.

`std::net::TcpListener::bind` sets `SO_REUSEADDR` on Unix, and on macOS that lets a bind to
`127.0.0.1:3001` succeed while another program listens on `*:3001`. A developer's own server on the
wildcard address then looked free, OpenBot chose its port, and its server could not start.
*/
fn bind_exclusive(address: std::net::SocketAddr) -> std::io::Result<std::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.bind(&address.into())?;
    socket.listen(16)?;
    Ok(socket.into())
}

/**
A loopback address as a container on this machine reaches it, or empty if it is not loopback.

`localhost`, `*.localhost`, `127.x.y.z` and `[::1]` become `host.docker.internal`, keeping the
scheme, port and path. Anything else is already reachable from a container as written, and empty is
how `docker-compose.yml` is told to use it unchanged.
*/
pub fn container_address(address: &str) -> String {
    let address = address.trim();
    let Ok(mut url) = reqwest::Url::parse(address) else {
        return String::new();
    };
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback || url.set_host(Some(CONTAINER_HOST)).is_err() {
        return String::new();
    }
    written_as_given(&url, address)
}

/**
An address with a `localhost` host written as `127.0.0.1`, keeping the scheme, port and path.

`localhost` does not resolve the same way everywhere: Node takes `::1` first and bun `127.0.0.1`,
and the local Intelligence stack publishes its ports on `127.0.0.1` alone, so the name reaches a
listener or nothing depending on who dials it. The Recorder also opens a plain `ws://` gateway only
at `127.0.0.1` or `[::1]`. Only the bare name is rewritten: a `*.localhost` name is a host name a
service routes or keeps a session by, and `127.x.y.z`, `[::1]` and every other host are already
what they say.
*/
pub fn numeric_loopback(address: &str) -> String {
    let address = address.trim();
    let Ok(mut url) = reqwest::Url::parse(address) else {
        return address.to_string();
    };
    if url.host_str() != Some("localhost") || url.set_host(Some("127.0.0.1")).is_err() {
        return address.to_string();
    }
    written_as_given(&url, address)
}

/// The parser writes an empty path as `/`; given without one, it is returned without one.
fn written_as_given(url: &reqwest::Url, address: &str) -> String {
    let moved = url.to_string();
    match moved.strip_suffix('/') {
        Some(bare) if url.path() == "/" && !address.ends_with('/') => bare.to_string(),
        _ => moved,
    }
}

/**
What the one computer relays from its own loopback (`COMPUTER_LOOPBACK_RELAYS`, read by
agent-computer's `loopback-relay.ts`), as `<port>=<host>:<port>`, comma-separated.

The Recorder in a browser there reaches OpenBot only at https or at loopback, so it is handed the
address the person's window uses, `http://127.0.0.1:<app port>`, and a local Intelligence gateway at
`ws://127.0.0.1:<port>`. Inside the computer's container both are the container. The app's and the
server's ports go to the server's container on the Compose network, and a gateway on this machine's
loopback goes to `host.docker.internal`, as the server's container reaches it. A gateway elsewhere
is reached at its own address and is not relayed.
*/
fn loopback_relays(ports: &Ports, gateway_ws_url: &str) -> String {
    let mut relays = vec![
        format!("{}=server:3001", ports.app),
        format!("{}=server:3001", ports.server),
    ];
    let gateway = reqwest::Url::parse(&container_address(gateway_ws_url))
        .ok()
        .and_then(|url| url.port_or_known_default());
    if let Some(port) = gateway.filter(|port| *port != ports.app && *port != ports.server) {
        relays.push(format!("{port}=host.docker.internal:{port}"));
    }
    relays.dedup();
    relays.join(",")
}

#[cfg(test)]
mod port_tests {
    use super::*;
    use std::collections::HashSet;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn a_port_another_program_holds_on_every_address_is_not_chosen() {
        // A dev server on `*:PORT` (Bun, Node and Vite listen this way) must count as busy.
        let _ports = crate::test_support::hold_ports();
        for wildcard in ["0.0.0.0:0", "[::]:0"] {
            let Ok(foreign) = TcpListener::bind(wildcard) else {
                continue; // no IPv6 on this machine
            };
            let port = foreign.local_addr().unwrap().port();
            assert!(
                bind_loopbacks(port).is_err(),
                "{wildcard} port {port} looked free"
            );
            let preferred = Ports {
                app: port,
                server: port,
                postgres: port,
                computer: port,
                bot: port,
                langgraph: port,
                supervisor: port,
                harness: None,
            };
            let chosen = preferred.available(&HashSet::new(), None).unwrap();
            assert!(!chosen
                .settings()
                .values()
                .any(|value| value == &port.to_string()));
        }
    }

    #[test]
    fn occupied_ports_are_replaced_with_distinct_bindable_loopback_ports() {
        let _ports = crate::test_support::hold_ports();
        let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = foreign.local_addr().unwrap().port();
        let preferred = Ports {
            app: port,
            server: port,
            postgres: port,
            computer: port,
            bot: port,
            langgraph: port,
            supervisor: port,
            harness: Some(port),
        };
        let (chosen, held) = preferred.reserve(&HashSet::new(), Some(port)).unwrap();
        let values: HashSet<u16> = chosen
            .settings()
            .values()
            .map(|value| value.parse().unwrap())
            .collect();
        assert_eq!(values.len(), 8);
        assert!(!values.contains(&port));
        // Checked on the binds that chose them, still open. Given back and bound again here, a
        // port can still be taken: a process another test is starting holds a copy of every open
        // socket until it execs.
        let bound: HashSet<std::net::SocketAddr> = held
            .iter()
            .map(|listener| listener.local_addr().unwrap())
            .collect();
        let ipv6 = TcpListener::bind("[::1]:0").is_ok();
        for value in values {
            assert!(
                bound.contains(&(std::net::Ipv4Addr::LOCALHOST, value).into()),
                "port {value} is not bound on 127.0.0.1"
            );
            assert!(
                !ipv6 || bound.contains(&(std::net::Ipv6Addr::LOCALHOST, value).into()),
                "port {value} is not bound on [::1]"
            );
        }
        drop(held);
        assert!(
            TcpStream::connect(foreign.local_addr().unwrap()).is_ok(),
            "foreign listener must remain untouched"
        );
    }

    #[test]
    fn occupied_ipv6_port_is_not_treated_as_available_ipv4_port() {
        let _ports = crate::test_support::hold_ports();
        let foreign = TcpListener::bind("[::1]:0").unwrap();
        let port = foreign.local_addr().unwrap().port();
        let preferred = Ports {
            postgres: port,
            ..Ports::default()
        };
        let chosen = preferred.available(&HashSet::new(), None).unwrap();
        assert_ne!(chosen.postgres, port);
    }

    #[test]
    fn saved_ports_survive_reopen_and_only_a_new_conflict_moves() {
        // Ports given back and then bound again are the scenario, so it runs where no other test
        // can be starting a process that holds them for a moment. The lock is taken first, so this
        // process's own port tests wait while the child chooses the same default ports.
        let _ports = crate::test_support::hold_ports();
        if crate::test_support::isolated_process(
            "env::port_tests::saved_ports_survive_reopen_and_only_a_new_conflict_moves",
        ) {
            return;
        }
        let root = crate::test_support::temp_root("saved-local-ports");
        std::fs::create_dir_all(&root).unwrap();
        let chosen = Ports::default()
            .available(&HashSet::new(), Some(4206))
            .unwrap();
        std::fs::write(
            root.join(".env"),
            "CUSTOM=kept\nOPENAI_API_KEY=synthetic-kept\n",
        )
        .unwrap();
        write(&root.join(".env"), &chosen.settings(), &BTreeMap::new()).unwrap();
        let reopened = Ports::read(&root).unwrap();
        assert_eq!(reopened, chosen);
        assert_eq!(
            reopened.available(&HashSet::new(), Some(4206)).unwrap(),
            chosen
        );
        let foreign = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, chosen.server)).unwrap();
        let changed = reopened.available(&HashSet::new(), Some(4206)).unwrap();
        assert_ne!(changed.server, chosen.server);
        assert_eq!(
            Ports {
                server: chosen.server,
                ..changed
            },
            chosen
        );
        let settings = std::fs::read_to_string(root.join(".env")).unwrap();
        assert!(settings.contains("CUSTOM=kept"));
        assert!(settings.contains("OPENAI_API_KEY=synthetic-kept"));
        drop(foreign);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn own_published_container_ports_are_reused_but_do_not_authorize_host_port_reuse() {
        let _ports = crate::test_support::hold_ports();
        let owned = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = owned.local_addr().unwrap().port();
        let preferred = Ports {
            postgres: port,
            ..Ports::default()
        };
        let chosen = preferred.available(&HashSet::from([port]), None).unwrap();
        assert_eq!(chosen.postgres, port);
        assert_ne!(
            preferred.available(&HashSet::new(), None).unwrap().postgres,
            port
        );
    }

    #[test]
    fn the_app_and_api_ports_our_server_container_publishes_are_kept() {
        // The one `server` container publishes both, so both are held while it runs.
        let _ports = crate::test_support::hold_ports();
        let app = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let preferred = Ports {
            app: app.local_addr().unwrap().port(),
            server: server.local_addr().unwrap().port(),
            ..Ports::default()
        };
        let ours = HashSet::from([preferred.app, preferred.server]);
        let chosen = preferred.available(&ours, None).unwrap();
        assert_eq!(
            (chosen.app, chosen.server),
            (preferred.app, preferred.server)
        );
        // Held by somebody else, they are moved, as they always were.
        let moved = preferred.available(&HashSet::new(), None).unwrap();
        assert_ne!(moved.app, preferred.app);
        assert_ne!(moved.server, preferred.server);
    }

    /// What the engine's port forwarder does after a quit: holds the port a moment, then lets go.
    fn held_for(listener: TcpListener, ms: u64) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            drop(listener);
        })
    }

    #[test]
    fn a_quit_and_reopen_keeps_the_app_port_its_last_run_is_still_letting_go_of() {
        // 2026-11-08: OpenBot quit and opened again at once moved its app from 3010 to 49381,
        // because the last run's port was still held when Start chose.
        let _ports = crate::test_support::hold_ports();
        // One listener from choosing the port to letting it go: never given back in between.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let preferred = Ports {
            app: port,
            ..Ports::default()
        };
        let letting_go = held_for(listener, 800);
        let chosen = preferred
            .for_start(
                &HashSet::from([port]),
                &HashSet::new(),
                None,
                std::time::Duration::from_secs(10),
            )
            .unwrap();
        letting_go.join().unwrap();
        assert_eq!(chosen.app, port);
    }

    #[test]
    fn a_port_somebody_else_keeps_still_moves_once_the_wait_is_over() {
        let _ports = crate::test_support::hold_ports();
        let stranger = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = stranger.local_addr().unwrap().port();
        let preferred = Ports {
            app: port,
            ..Ports::default()
        };
        let started = std::time::Instant::now();
        let chosen = preferred
            .for_start(
                &HashSet::from([port]),
                &HashSet::new(),
                None,
                std::time::Duration::from_millis(600),
            )
            .unwrap();
        assert_ne!(chosen.app, port);
        assert!(started.elapsed() >= std::time::Duration::from_millis(600));
        assert!(TcpStream::connect(stranger.local_addr().unwrap()).is_ok());
    }

    #[test]
    fn a_port_this_deployment_never_recorded_is_not_waited_for() {
        let _ports = crate::test_support::hold_ports();
        let stranger = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = stranger.local_addr().unwrap().port();
        let preferred = Ports {
            app: port,
            ..Ports::default()
        };
        let started = std::time::Instant::now();
        let chosen = preferred
            .for_start(
                &HashSet::new(),
                &HashSet::new(),
                None,
                std::time::Duration::from_secs(10),
            )
            .unwrap();
        assert_ne!(chosen.app, port);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn recorded_ports_are_the_ones_the_env_names() {
        let root = crate::test_support::temp_root("recorded-local-ports");
        std::fs::create_dir_all(&root).unwrap();
        assert!(Ports::recorded(&root).unwrap().is_empty());
        std::fs::write(
            root.join(".env"),
            "APP_PORT=3010\nSERVER_PORT=61246\nCUSTOM=1\n",
        )
        .unwrap();
        assert_eq!(
            Ports::recorded(&root).unwrap(),
            HashSet::from([3010, 61246])
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_saved_ports_fail_instead_of_probing_an_unrelated_default() {
        let root = crate::test_support::temp_root("invalid-local-ports");
        std::fs::create_dir_all(&root).unwrap();
        for value in ["0", "65536", "unknown"] {
            std::fs::write(root.join(".env"), format!("SERVER_PORT={value}\n")).unwrap();
            assert_eq!(
                Ports::read(&root).unwrap_err().kind(),
                std::io::ErrorKind::InvalidData
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

/**
The secrets this shell mints rather than being given.

Named in one place because two things read the list: `compose` keeps whichever of them a previous
run already produced, and `vault` puts them in the credential store rather than the file.
*/
/// 32 random bytes, base64. The shape `KEY_ENCRYPTION_KEY` requires and a fine shape for the rest.
fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

/// The settings the shell owns, in the order a person reading the file would want them.
///
/// Addresses use `127.0.0.1` rather than `localhost` deliberately. Compose publishes on both
/// loopback addresses, so either would connect, but naming one removes a whole class of question
/// about which the resolver picked.
/// Blank is not a value. See the note in `compose`.
fn insert_if_given(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if !value.trim().is_empty() {
        env.insert(key.into(), value.trim().to_string());
    }
}

pub fn compose(
    intelligence: &Intelligence,
    model: &Model,
    engine: &EngineStatus,
    ports: &Ports,
    images: &[(String, String)],
    // Absent means no harness was picked, and the package's gated rows stay dropped.
    harness: Option<&PickedHarness>,
    // What a previous run of THIS deployment already minted, so it is not minted again. Empty on a
    // machine that has never run OpenBot, which is exactly when generating is right.
    kept: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    /*
     * Only the keys the choice actually implies, and never a blank one: written empty, Compose
     * passes an empty string and the Bot's refusal becomes a confusing one about a key that is set
     * and useless.
     *
     * THE CLAUDE PLAN DELIBERATELY WRITES NO `ANTHROPIC_API_KEY`. The SDK prefers the key over the
     * OAuth token, so a stale key from an earlier attempt would quietly bill a person who just
     * signed in to a plan. Since `write` below preserves lines it does not own, the key is written
     * as empty here rather than omitted: omitting it would leave an older one in place, which is
     * the same failure by a different route.
     */
    /*
     * Every model key, every time, and empty unless the choice implies it.
     *
     * Clearing only the one key a given arm conflicts with left the others stale, and `write` below
     * preserves lines it does not own, so switching from a key to a plan kept the old key in the
     * file and handed it to every harness. Measured: a run that signed in to a Claude plan still
     * carried the OPENAI_API_KEY from the run before it. Whichever key a harness reads first then
     * decides what the person is billed for, which is the failure the plan path exists to avoid.
     *
     * Written empty rather than omitted, for the same reason: omitting leaves the old line in place.
     */
    if model.credential != ModelCredential::None {
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_AUTH_FILE",
            "OPENBOT_MODEL_OAUTH_FILE",
            "BOT_PROVIDER",
            /*
             * Retired, and cleared for exactly that reason. An earlier version put the ChatGPT
             * plan's access token here; nothing reads it now, and `write` preserves what it does
             * not own, so without this line a machine that ran that version would keep somebody's
             * plan token in a file forever with nothing ever using it again.
             */
            "CHATGPT_OAUTH_TOKEN",
        ] {
            env.insert(key.into(), String::new());
        }
        /*
         * AND THE MODEL NAME, WHICH ONLY ONE ROW IMPLIES.
         *
         * Measured: answering the compatible row sets `BOT_MODEL` to whatever the person's own
         * endpoint calls its model, and switching back to an OpenAI key left it there. The Bot then
         * asked OpenAI for `local-model` and the last screen said "That account cannot use the
         * model that was chosen" — about a model this run never chose. Exactly the failure the
         * clearing above exists for, with one key missed.
         *
         * Removed rather than emptied, so `docker-compose.yml`'s own default applies. Blank would
         * be passed through as a model named "", which is a worse question to ask a provider.
         */
        if !matches!(
            model.credential,
            ModelCredential::Compatible { .. } | ModelCredential::ProviderOAuth { .. }
        ) {
            for key in ["BOT_MODEL", "AGENT_BOT_MODEL"] {
                env.remove(key);
            }
        }
    }
    match &model.credential {
        /*
         * Nothing chosen touches nothing, deliberately.
         *
         * The clearing above is for the case where the model screen HAS answered: whichever keys
         * that answer does not imply are emptied, so switching from a key to a plan cannot leave
         * the old key behind for a harness to prefer. With no answer there is nothing to be
         * consistent with, and a key somebody set by hand is theirs to keep — see `write`, which
         * preserves lines this does not own.
         */
        ModelCredential::None => {}
        ModelCredential::OpenAi { api_key } => {
            insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
        }
        ModelCredential::Anthropic { api_key } => {
            insert_if_given(&mut env, "ANTHROPIC_API_KEY", api_key);
            env.insert("BOT_PROVIDER".into(), "anthropic".into());
            /*
             * NO MODEL. The setup screen asks for a key, not a model, so a model written here would
             * be a stand-in that reads as the person's choice and pins every Bot to it. Unset, the
             * server takes the middle of Anthropic's current line from Anthropic's own listing.
             */
        }
        ModelCredential::ClaudePlan { token } => {
            insert_if_given(&mut env, "CLAUDE_CODE_OAUTH_TOKEN", token);
        }
        /*
         * A path, not the credential. The store itself goes to a file beside this one, because the
         * harness's provider does not merely read it: it writes the renewed tokens back. Through a
         * bind mount that renewal lands on this machine and survives the container; carried as an
         * environment variable it would be lost on every restart, and the refresh token it replaced
         * would already have been spent.
         */
        ModelCredential::ChatGptPlan { store } => {
            if !store.trim().is_empty() {
                env.insert("CHATGPT_AUTH_FILE".into(), CHATGPT_STORE_INSIDE.into());
            }
        }
        ModelCredential::ProviderOAuth {
            path,
            proxy_token,
            model,
            ..
        } => {
            env.insert("OPENBOT_MODEL_OAUTH_FILE".into(), path.clone());
            env.insert("OPENAI_API_KEY".into(), proxy_token.clone());
            env.insert(
                "OPENAI_BASE_URL".into(),
                format!("http://127.0.0.1:{}/api/model-provider/v1", ports.server),
            );
            env.insert(
                "OPENAI_CONTAINER_BASE_URL".into(),
                format!(
                    "http://host.docker.internal:{}/api/model-provider/v1",
                    ports.server
                ),
            );
            env.insert("BOT_PROVIDER".into(), "openai".into());
            env.insert("BOT_MODEL".into(), model.clone());
            env.insert("AGENT_BOT_MODEL".into(), model.clone());
        }
        ModelCredential::Compatible {
            base_url,
            container_base_url,
            api_key,
            model: name,
        } => {
            /*
             * A placeholder when the endpoint needs no key, rather than nothing.
             *
             * Ollama, vLLM, LM Studio and llama.cpp ignore the value, but the OpenAI SDK every Bot
             * is built on refuses to construct a client without a string, so a blank key produced a
             * Bot that exited on startup asking for a key the person's own server does not have.
             * The Bots no longer demand one when a base URL names an endpoint, and this is the half
             * that makes the same choice work against a Bot image published before they learned:
             * the value is sent to an endpoint that does not read it.
             *
             * Not a secret and never treated as one, which is why it is written here in plain sight
             * rather than put in the credential store.
             */
            if api_key.trim().is_empty() {
                env.insert("OPENAI_API_KEY".into(), NO_KEY_NEEDED.into());
            } else {
                insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
            }
            insert_if_given(&mut env, "OPENAI_BASE_URL", base_url);
            if let Some(container_base_url) = container_base_url {
                insert_if_given(&mut env, "OPENAI_CONTAINER_BASE_URL", container_base_url);
            }
            insert_if_given(&mut env, "BOT_MODEL", name);
            /*
             * The bundled Bot's own model variable, set to the same name.
             *
             * It has one because it hand-writes `/v1/chat/completions`, where `gpt-5.6-*` rejects
             * function tools, so `docker-compose.yml` pins it to `gpt-5.5` rather than letting the
             * framework Bot's choice take its tools away. That reasoning is about OpenAI's own
             * models and does not survive a custom endpoint: `gpt-5.5` is not in the catalogue of
             * an Ollama or a vLLM, so the pin asked somebody's own server for a model it has never
             * heard of. The person named exactly one model on that screen and meant it for
             * whichever Bot answers.
             */
            insert_if_given(&mut env, "AGENT_BOT_MODEL", name);
        }
    }

    /*
     * Why Learning has no model, for Settings to say, or empty when it has one. Written with the
     * model's own keys, and left alone when nothing was chosen, for the same reasons. See
     * `learning_model`.
     */
    if let Some(why) = crate::learning_model::unavailable_setting(&model.credential) {
        env.insert(crate::learning_model::UNAVAILABLE.into(), why.into());
    }

    // Trimmed, the way the model key beside it already is. All four values come from the same
    // setup screen, which enables its button on `value.trim() !== ""` and then sends the untrimmed
    // string, so a key copied from a provider's dashboard with the trailing space the selection
    // picked up arrives here intact. Compose keeps it, the provider rejects the key, and the Bot
    // reports that it cannot answer without ever naming the space.
    //
    // And at `127.0.0.1` where they say `localhost`, as the local Intelligence CLI reports its
    // stack. The server and the person's browser both dial these (`docker-compose.yml` hands the
    // gateway to the browser as `INTELLIGENCE_BROWSER_GATEWAY_WS_URL`), the stack publishes on
    // `127.0.0.1` alone, and the Recorder opens a plain `ws://` gateway at no other name.
    env.insert(
        "INTELLIGENCE_API_URL".into(),
        numeric_loopback(&intelligence.api_url),
    );
    env.insert(
        "INTELLIGENCE_GATEWAY_WS_URL".into(),
        numeric_loopback(&intelligence.gateway_ws_url),
    );
    /*
     * The same two addresses as the server's container reaches them.
     *
     * Local Intelligence answers on this machine's loopback, which inside a container is the
     * container. `host.docker.internal` is the machine. Only the server is moved: the browser opens
     * the gateway too, from the address in `/info`, and the browser is on the host, so
     * `docker-compose.yml` hands it the address above unchanged. Empty for an Intelligence somewhere
     * else, which the container reaches at the address it was given.
     */
    env.insert(
        "INTELLIGENCE_CONTAINER_API_URL".into(),
        container_address(&intelligence.api_url),
    );
    env.insert(
        "INTELLIGENCE_CONTAINER_GATEWAY_WS_URL".into(),
        container_address(&intelligence.gateway_ws_url),
    );
    /*
     * And the same name for addresses a person types into the app.
     *
     * A person who runs their own agent at `http://127.0.0.1:8765/ag-ui` and registers it as a Bot
     * means this machine, and the server dials from its container. Told this name, the server dials
     * a loopback address through it, as `container_address` does for the addresses above.
     */
    env.insert(
        THIS_MACHINE_CONTAINER_HOST_ENV.into(),
        CONTAINER_HOST.into(),
    );
    // Explicit desktop selection must override a CLI key left in the checkout's .env.
    // Supply both names for consumers that still read the legacy variable directly.
    for key in ["CPK_INTELLIGENCE_API_KEY", "INTELLIGENCE_API_KEY"] {
        env.insert(key.into(), intelligence.api_key.trim().to_string());
    }
    /*
     * No Learning container named: the server assigns this Intelligence's own (auto-assign, in
     * server/src/learning/auto-assign.ts), after checking it is there.
     *
     * Written empty rather than left out, so it is ours and `write` takes out a line somebody else
     * left. A CLI set up against hosted Intelligence writes `"openbot"` into this same file; against
     * the local Intelligence Start points at, that container does not exist, every new thread was
     * refused ("Failed to initialize thread"), and naming one also turned auto-assign off.
     */
    env.insert(
        "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID".into(),
        String::new(),
    );

    /*
     * MINTED ONCE PER DEPLOYMENT, NOT ONCE PER START.
     *
     * `KEY_ENCRYPTION_KEY` is the one that makes this data loss rather than churn: every secret the
     * server keeps goes through it, and `encrypt-sso-config.ts` names the symptom itself, that a
     * changed key leaves stored configuration unreadable and sign-in broken until it is registered
     * again. A new one on every Start quietly orphaned everything the last run had encrypted.
     *
     * The rest are kept for a smaller reason that points the same way: a Bot's computer is a
     * container that outlives a restart and was created holding the old `COMPUTER_TOKEN`, so
     * rotating buys nothing and can only strand it.
     *
     * Two installs still do not share a key. A machine with nothing stored generates, which is what
     * a first run is.
     */
    for key in MINTED {
        let value = kept
            .get(key)
            .map(|value| value.trim().to_string())
            // `usable` and not merely "not empty": an example key copied out of `.env.example` is
            // present, is published, and must still be replaced. It also holds
            // `KEY_ENCRYPTION_KEY` to the 32 bytes it has to decode to.
            .filter(|value| usable(key, value))
            .unwrap_or_else(secret);
        env.insert(key.into(), value);
    }

    env.insert(
        "DATABASE_URL".into(),
        format!(
            "postgres://openbot:openbot@127.0.0.1:{}/openbot",
            ports.postgres
        ),
    );
    // Every address the app is actually reachable at, because it is reachable at more than one.
    //
    // The app's dev server binds `[::1]` and not `127.0.0.1`, so a browser sent to one of those
    // arrives with an origin the other would not match, and the deployment refuses a request it
    // should have accepted. Naming all three costs nothing: they are the same machine, and the
    // question this setting answers is which origins are this deployment's own.
    //
    // 127.0.0.1 first, because the server also takes the first as the app's own address and sends
    // the person's browser there after they approve an app; `localhost` may resolve to the address
    // the engine did not publish.
    env.insert(
        "TRUSTED_ORIGINS".into(),
        format!(
            "http://127.0.0.1:{app},http://localhost:{app},http://[::1]:{app}",
            app = ports.app
        ),
    );
    /*
     * Where a vendor sends the person back after they approve an app connected over its own OAuth
     * (`redirectUriFor` in server/src/plugins/oauth.ts). Unset, the server refuses every such
     * connection and tells the person to ask an admin for this setting, which on their own computer
     * is nobody.
     *
     * The app's own address on this machine, because the consent finishes in the person's default
     * browser, which is on this machine too. 127.0.0.1 rather than either other name: `localhost`
     * may resolve to the address the engine did not publish, and `[::1]` is the one the computer's
     * container may not have, while the Recorder there is handed this same address. Replaced on
     * every Start, so a Start that moved the app to another port moves this with it.
     */
    env.insert(
        "OPENBOT_PUBLIC_URL".into(),
        format!("http://127.0.0.1:{}", ports.app),
    );
    env.insert(
        "AGENT_COMPUTER_URL".into(),
        format!("http://127.0.0.1:{}", ports.computer),
    );
    // No bundled Bot: the personal edition's Personal Assistant runs inside the server. Written empty
    // rather than left out, because `write` keeps a line it does not own, and an earlier Start
    // advertised the bundled Bot here.
    env.insert("MANAGED_AGENT_AG_UI_URL".into(), String::new());

    /*
     * The picked harness, if there is one.
     *
     * Addressed on loopback rather than by a compose service name, because the server is a host
     * process here and not a container: it reaches `agent-bot` and `agent-langgraph` the same way,
     * over the port those services publish.
     *
     * One address and one kind. The package's single row drops itself while the address is blank,
     * so a deployment that picked nothing registers nothing.
     */
    // KIND describes the wire protocol, not who runs the endpoint. Always replace this
    // nonsecret provenance, including when nothing is picked: `write` preserves omitted keys.
    env.insert(
        "PICKED_HARNESS_SOURCE".into(),
        match harness {
            Some(PickedHarness::Installed { .. }) => "installed",
            Some(PickedHarness::RemoteAgUi { .. }) => "byo",
            None => "",
        }
        .into(),
    );
    // Empty unless a harness runs here, so the address a remote Bot was given is the one used and a
    // harness picked on an earlier start does not leave its container address behind.
    env.insert("PICKED_HARNESS_CONTAINER_URL".into(), String::new());
    if let Some(picked) = harness {
        match picked {
            PickedHarness::Installed {
                image,
                port,
                name,
                mastra,
                run_path,
                remote_agent_id,
            } => {
                let host_port = ports.harness.unwrap_or(*port);
                env.insert("PICKED_HARNESS_IMAGE".into(), image.clone());
                env.insert("PICKED_HARNESS_PORT".into(), port.to_string());
                env.insert("PICKED_HARNESS_NAME".into(), name.clone());
                let run_path = run_path.trim();
                let run_path = if run_path.is_empty() || run_path.starts_with('/') {
                    run_path.to_string()
                } else {
                    format!("/{run_path}")
                };
                env.insert(
                    "PICKED_HARNESS_URL".into(),
                    format!("http://127.0.0.1:{host_port}{run_path}"),
                );
                // The server is a container on the harness's network, so it dials the service by
                // name on the image's own port, not the host port published for everything else.
                env.insert(
                    "PICKED_HARNESS_CONTAINER_URL".into(),
                    format!("http://agent-harness:{port}{run_path}"),
                );
                /*
                 * The kind, as the package spells it.
                 *
                 * Interpolated rather than written as a literal row per kind, because the loader
                 * refuses an unknown `agent.type` by refusing the whole file: a package carrying a
                 * literal `remote-mastra` row stops any server predating that kind from starting at
                 * all, picked or not. Measured, not guessed — it is what a v0.0.8 deployment did.
                 */
                env.insert(
                    "PICKED_HARNESS_KIND".into(),
                    if *mastra {
                        "remote-mastra".to_string()
                    } else {
                        "remote-ag-ui".to_string()
                    },
                );
                insert_if_given(&mut env, "PICKED_HARNESS_AGENT_ID", remote_agent_id);
            }
            PickedHarness::RemoteAgUi {
                url,
                name,
                remote_agent_id,
            } => {
                env.insert("PICKED_HARNESS_NAME".into(), name.clone());
                env.insert("PICKED_HARNESS_URL".into(), url.trim().to_string());
                env.insert("PICKED_HARNESS_KIND".into(), "remote-ag-ui".into());
                insert_if_given(&mut env, "PICKED_HARNESS_AGENT_ID", remote_agent_id);
            }
        }
    }

    /*
     * One computer, and every Bot on it is this person's.
     *
     * The personal edition refuses a supervisor (`personalEditionRequirements` in
     * server/src/config.ts), so both addresses are written empty: the host's, and the one
     * `docker-compose.yml` gives the server's container, which defaults to the supervisor only while
     * it is unset. Empty rather than left out, because `write` keeps a line it does not own and an
     * earlier Start wrote the supervisor's address here.
     *
     * The computer is started as the person's (`COMPUTER_PERSON_ID`, as `scripts/start.sh` does for
     * the personal edition), which is what lets them record in a Bot's browser.
     *
     * The person's own browser runs there too, shown in the OpenBot window as hosted OpenBot shows
     * it, so no `OPENBOT_BROWSER_URL` is written: that would send the server to a browser on this
     * machine's desktop, a separate Chrome window, which Desktop no longer runs. Start takes out
     * the one an earlier Desktop wrote ([`REMOVED_WHEN_UNSET`]).
     */
    env.insert("COMPUTER_SUPERVISOR_URL".into(), String::new());
    env.insert("COMPUTER_SUPERVISOR_CONTAINER_URL".into(), String::new());
    env.insert("COMPUTER_PERSON_ID".into(), "personal".into());
    env.insert(
        "COMPUTER_LOOPBACK_RELAYS".into(),
        loopback_relays(ports, &intelligence.gateway_ws_url),
    );

    // The worker refuses to start without this, by design: it is a fact about where this process
    // runs, and it would rather stop than guess. `start.sh` sets it at run time, so a `.env` copied
    // from a developer's machine does not carry it either.
    env.insert(
        "SERVER_INTERNAL_URL".into(),
        format!("http://127.0.0.1:{}", ports.server),
    );

    env.extend(ports.settings());
    // The server is a container on the Bots' network now, so they reach it by name and on its own
    // port, whichever host port this start published it on.
    env.insert(
        "OPENBOT_TOOL_URL".into(),
        "http://server:3001/api/agent-tools/call".into(),
    );

    // The whole deployment is on this machine, so the server must be allowed to talk to it.
    //
    // The private-address floor stops a hosted deployment reaching into its own network, which is
    // right there and wrong here: the computer, the person's browser on it and the Bots are all on
    // loopback by design. Without this the server refuses to call its own computer and the failure
    // arrives as an Unauthorized wrapped in a 500, which names neither the address nor the rule.
    env.insert("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS".into(), "true".into());

    // The personal edition: one person on their own machine, which is who this app installs OpenBot
    // for. Unset, the server runs the team edition, with its admin screens, its fintech Bots and a
    // computer per Bot. See docs/personal-edition.md.
    env.insert("OPENBOT_EDITION".into(), "personal".into());

    // Which package the deployment runs. Without it the server falls back rather than using the one
    // that came with the deployment, and the Bots somebody was given are not the Bots they get.
    env.insert("TENANT_PACKAGE_DIR".into(), "../examples/personal".into());

    // The one person, named. `OPENBOT_SINGLE_USER` says there is nobody else; this says who that
    // somebody is, so the routes that ask what an actor may do have an actor to answer about.
    env.insert("INITIAL_ADMIN_EMAILS".into(), "dev@openbot.local".into());

    // One machine, one person, no sign-in.
    //
    // The server refuses to start with no identity provider rather than serve a deployment where
    // every visitor is an administrator, which is the right refusal on a server and the wrong
    // question on a laptop: there is nobody else here. Saying so explicitly is how that refusal is
    // answered, and it is the same switch `ci.yml` uses for the same reason.
    env.insert("OPENBOT_SINGLE_USER".into(), "true".into());

    // Pull the published images rather than build them. A desktop install has no toolchain and no
    // reason to compile Chromium.
    env.insert("IMAGE_PULL_POLICY".into(), "missing".into());

    // Which images, by digest, from the release's own manifest. Compose's defaults are local build
    // names, so leaving these unset does not fall back to something workable: it asks a registry
    // for `openbot-supervisor:latest`, which nobody publishes, and the denial that comes back
    // reads as a login problem.
    for (variable, reference) in images {
        env.insert(variable.clone(), reference.clone());
    }

    // Only rootless Podman on Linux needs this; see engine.rs.
    if let Some(socket) = &engine.engine_socket {
        env.insert("ENGINE_SOCKET".into(), socket.clone());
        // And only there is `host-gateway` not this machine's loopback, which is where a local
        // Intelligence listens. See `engine::ROOTLESS_HOST_LOOPBACK`.
        env.insert(
            HOST_GATEWAY_ENV.into(),
            crate::engine::ROOTLESS_HOST_LOOPBACK.into(),
        );
    }

    env
}

#[derive(Clone, Debug)]
pub struct Intelligence {
    pub api_url: String,
    pub gateway_ws_url: String,
    pub api_key: String,
}

/**
The harness somebody picked, as the deployment has to describe it.

Registration is not an API call in this product: Bots come from the tenant package, whose
`agents.yaml` interpolates `${...}` and drops any Bot whose endpoint comes out blank. So a picked
harness becomes these settings, the package's own gated row materialises, and seeding registers it.
Nothing new had to be built to make a Bot appear.

`None` is a deployment that has not picked one, which writes nothing and leaves those rows dropped.
*/
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickedHarness {
    Installed {
        /// The published image, e.g. `openbot-agent-crewai`. Named by the release, not derived.
        image: String,
        /// The port that image listens on, fixed by its own Dockerfile.
        port: u16,
        /// What the Bot is called on screen.
        name: String,
        /// How it is dialled. A Mastra server has no AG-UI route of its own.
        mastra: bool,
        /// The run route on that harness. Empty means the server root.
        run_path: String,
        /// Which agent on that server, for a Mastra roster. Empty means the only one there.
        remote_agent_id: String,
    },
    RemoteAgUi {
        /// The AG-UI endpoint the person already runs.
        url: String,
        /// What the Bot is called on screen.
        name: String,
        /// Reserved for a future remote roster field. Empty means the only one there.
        remote_agent_id: String,
    },
}

impl PickedHarness {
    pub fn installed_port(&self) -> Option<u16> {
        match self {
            Self::Installed { port, .. } => Some(*port),
            Self::RemoteAgUi { .. } => None,
        }
    }
}

/// The model credential, which belongs to the provider and not to the harness.
///
/// Both Bots the deployment ships refuse to start without one, saying so plainly: "This Bot cannot
/// answer without a model." Which provider is the person's own screen, and no harness constrains
/// it: see `provider::catalogue`.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub credential: ModelCredential,
}

/// How this deployment reaches a model.
///
/// One type rather than a bag of optional strings, because the combinations that must never be
/// written are the whole point. `ANTHROPIC_API_KEY` takes precedence over the plan's OAuth token in
/// the Claude Agent SDK, so writing both silently bills a person who signed in to a plan they
/// already pay for. Two fields cannot express "never both"; a choice can.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ModelCredential {
    /// Nothing chosen. Written as nothing at all rather than as empty strings: an empty key set is
    /// a key that is present and useless, and the Bot's refusal then names a key it can see.
    #[default]
    None,
    /// A key typed for OpenAI.
    OpenAi { api_key: String },
    /// A key typed for Anthropic.
    Anthropic { api_key: String },
    /// A Claude plan, signed in to. The token is minted by `claude setup-token` and never typed.
    ClaudePlan { token: String },
    /**
    A ChatGPT plan, signed in to.

    NOT the compatible shape below, and that distinction is load-bearing. A plan token is a bearer
    for `https://chatgpt.com/backend-api/codex`, and `langchain-openai` PINS that address and
    refuses a caller-supplied one, deliberately, so a token cannot be aimed at somebody else's
    server and handed over. Writing this as `OPENAI_BASE_URL` plus a key would be us hand-rolling
    the thing the library exists to prevent, and the Codex path also shapes its requests
    differently, so it would not have worked anyway.

    THE WHOLE STORE, NOT THE ACCESS TOKEN. The token in it lasts under an hour and nothing can
    renew it; the refresh token beside it is what keeps the Bot answering tomorrow. Carrying one
    field would produce a Bot that works this morning and fails this afternoon with an auth error,
    which is the hardest kind of fault for somebody to report.

    The harness picks its model class from the presence of this store. See the harness note in the
    build doc.
    */
    ChatGptPlan { store: String },
    /// A native-held OAuth session; the local proxy owns access-token refresh.
    ProviderOAuth {
        provider: String,
        path: String,
        proxy_token: String,
        model: String,
    },
    /// Anything that speaks the OpenAI wire format, at an address the person gave.
    ///
    /// Also where a signed-in ChatGPT plan lands, because that login yields a token and the address
    /// to send it to, which is this shape and not a special case.
    Compatible {
        base_url: String,
        container_base_url: Option<String>,
        api_key: String,
        model: String,
    },
}

/// What is sent as the key when the endpoint named needs none.
///
/// A placeholder, not a credential: see the compatible branch of `compose`.
pub const NO_KEY_NEEDED: &str = "no-key-needed";

/// Write the file, replacing only what this owns.
/// The line that separates what the shell owns from what it found.
///
/// Named rather than written inline, because `write` has to recognise its own from a previous start
/// as well as put one down.
const BANNER: &str = "# Written by OpenBot Desktop. Anything else in this file is left alone.";

/// The secrets this deployment mints for itself, once.
pub const MINTED: [&str; 7] = [
    "AGENT_TOOL_TOKEN",
    "COMPUTER_TOKEN",
    "KEY_ENCRYPTION_KEY",
    // What local Intelligence's Learning agent proves itself to the server with when it thinks on
    // the person's plan. See `learning_model`.
    crate::learning_model::TOKEN,
    "MANAGED_AGENT_TOKEN",
    "SUPERVISOR_TOKEN",
    "WORKER_SHARED_SECRET",
];

/// Settings `compose` writes only when this run's answer implies them, and Start takes out of the
/// file when it does not. `write` keeps every line it does not own, so without this a value an
/// earlier run wrote outlives the answer that implied it: `BOT_MODEL` once asked OpenAI for a model
/// an earlier endpoint had named, and `OPENBOT_BROWSER_URL` would send the person to a browser that
/// no longer runs.
pub const REMOVED_WHEN_UNSET: [&str; 9] = [
    "BOT_PROVIDER",
    "BOT_MODEL",
    "AGENT_BOT_MODEL",
    // What earlier Desktops wrote for the host-side Chrome they ran beside the server: its port, its
    // address (the host's and the server container's), and why there was none. Desktop runs no such
    // browser now, and a server still pointed at one shows the person a separate window, or a port
    // nothing answers on, rather than their browser in the OpenBot window.
    "BROWSER_PORT",
    "OPENBOT_BROWSER_URL",
    "OPENBOT_BROWSER_CONTAINER_URL",
    "OPENBOT_BROWSER_ABSENT",
    // A machine that moves from rootless Podman to Docker must go back to `host-gateway`.
    HOST_GATEWAY_ENV,
    // Written by earlier apps that could sign in through an organization's OpenBot. This app runs
    // OpenBot for one person, so a Start takes it out rather than leave the server expecting it.
    "OPENBOT_ORGANIZATION_AUTH_URL",
];

/// What `docker-compose.yml` maps `host.docker.internal` to, in place of `host-gateway`.
pub const HOST_GATEWAY_ENV: &str = "OPENBOT_HOST_GATEWAY";

/// The name OpenBot's containers reach this machine by. Every engine gets there through it: Docker
/// Desktop and the Podman machines forward it, and under rootless Podman `docker-compose.yml` maps it
/// to [`crate::engine::ROOTLESS_HOST_LOOPBACK`] through [`HOST_GATEWAY_ENV`].
pub const CONTAINER_HOST: &str = "host.docker.internal";

/// Where the server's container is told that name (`OPENBOT_THIS_MACHINE_HOST` inside it, in
/// `docker-compose.yml`), so an agent a person registers on their own loopback is dialled here.
pub const THIS_MACHINE_CONTAINER_HOST_ENV: &str = "OPENBOT_THIS_MACHINE_CONTAINER_HOST";

const PUBLISHED: [&str; 4] = [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "openbot-dev-supervisor-token",
    "openbot-dev-computer-token",
    "openbot-dev-worker-secret",
];

/// Whether an original installation key can be reused without replacement.
/// Start checks this before composition so an existing installation cannot silently rotate its key.
pub fn usable_encryption_key(value: &str) -> bool {
    !PUBLISHED.contains(&value) && matches!(BASE64.decode(value), Ok(bytes) if bytes.len() == 32)
}

fn usable(key: &str, value: &str) -> bool {
    if key == "KEY_ENCRYPTION_KEY" {
        return usable_encryption_key(value);
    }
    !value.is_empty() && !PUBLISHED.contains(&value)
}

fn carried(existing: &str) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in existing.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if MINTED.contains(&key) && usable(key, value) {
            found.insert(key.to_string(), value.to_string());
        }
    }
    found
}

/// Write the file, replacing only what this owns and keeping the secrets it has already minted.
///
/// Lines the shell did not write are kept: somebody who added `OPENAI_API_KEY` by hand, or a
/// setting a later version of this app does not know about, should not lose it because the stack
/// was restarted.
/**
What a previous run already put in the `.env`.

So the wizard never asks twice. A person who has set this up before, or whose IT department laid the
file down for them, should not be made to find a key again — and "find it again" in practice means
opening a dotfile in a text editor, which is the exact thing this product exists not to require.

Only the settings the wizard asks about are read back. Everything else in that file is somebody
else's, and this has no business handing it to a window.
*/
fn already_set_in(text: &str, keys: &[&str]) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        // Blank is not a value: the writer clears keys a choice does not imply, and offering those
        // back as though somebody had set them would undo that.
        if keys.contains(&key) && !value.is_empty() {
            found.insert(key.to_string(), value.to_string());
        }
    }
    found
}

pub fn read_already_set(path: &Path, keys: &[&str]) -> std::io::Result<BTreeMap<String, String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    Ok(already_set_in(&text, keys))
}

pub fn already_set(path: &Path, keys: &[&str]) -> BTreeMap<String, String> {
    read_already_set(path, keys).unwrap_or_default()
}

/**
Lay down the token store a signed-in ChatGPT plan reads from, beside the `.env`.

Always written, and see `CHATGPT_STORE_FILE` for why: a directory bind mount needs the file already
present inside it before the harness starts. Answering the model screen with anything else clears
it, on the same reasoning as the keys the writer empties. A plan that was signed out of should not
leave a credential on disk for a later run to pick up.

Not called when the screen was not answered at all, which is the one case that must not disturb what
is already there.
*/
pub fn write_plan_store(dir: &Path, credential: &ModelCredential) -> std::io::Result<()> {
    let store = match credential {
        ModelCredential::ChatGptPlan { store } if !store.trim().is_empty() => store.trim(),
        _ => "{}",
    };
    let path = dir.join(CHATGPT_STORE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private_file(&path, format!("{store}\n").as_bytes())
}

/// Replace a credential or its intent record only after an owner-only temporary file is durable.
/// A failed write leaves the previous copy available for an explicit retry.
pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("missing parent directory"))?;
    let temporary = parent.join(format!(".openbot-write-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub fn saved_chatgpt_plan_store(dir: &Path) -> bool {
    read_plan_store(dir)
        .ok()
        .flatten()
        .is_some_and(|store| store.trim() != "{}")
}

pub fn read_plan_store(dir: &Path) -> std::io::Result<Option<String>> {
    let path = dir.join(CHATGPT_STORE_FILE);
    let store = match std::fs::read_to_string(path) {
        Ok(store) => store,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let trimmed = store.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub fn write(
    path: &Path,
    owned: &BTreeMap<String, String>,
    // Keys to take out and not put back. This is how a credential leaves the file on a machine that
    // ran a version which wrote it there: the settings move to the store, and without this the old
    // copy would sit in the file forever, since `write` otherwise keeps every line it does not own.
    purge: &BTreeMap<String, String>,
) -> std::io::Result<()> {
    // Each unquoted row is one setting. A line break in a model name must not become another
    // setting, and a refused update must leave the previous file untouched.
    if owned
        .iter()
        .any(|(key, value)| key.contains(['\r', '\n']) || value.contains(['\r', '\n']))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "OpenBot setting names and values must not contain line breaks.",
        ));
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(std::io::Error::new(
                error.kind(),
                format!("{}: {error}", path.display()),
            ))
        }
    };
    let carried = carried(&existing);
    let mut out = String::new();

    for line in existing.lines() {
        // The shell's own banner is not one of the lines it did not write. Keeping it and then
        // writing another one added a banner and a blank line to the file on every start, so a
        // deployment restarted fifty times had fifty of them above its settings.
        if line.trim() == BANNER {
            continue;
        }
        let key = line.split('=').next().unwrap_or("").trim();
        // `export NAME=value` sets NAME for Compose and the server alike, so it is NAME's line.
        let key = key.strip_prefix("export ").map_or(key, str::trim);
        let ours = owned.contains_key(key) || purge.contains_key(key);
        if key.is_empty() || line.trim_start().starts_with('#') || !ours {
            out.push_str(line);
            out.push('\n');
        }
    }

    // The blank lines the removed banners left behind go with them, so the separator below is one
    // blank line rather than one more on every start.
    let kept = out.trim_end_matches('\n');
    let mut out = if kept.is_empty() {
        String::new()
    } else {
        format!("{kept}\n")
    };
    out.push_str(&format!("\n{BANNER}\n"));
    for (key, value) in owned {
        let value = carried.get(key).unwrap_or(value);
        out.push_str(&format!("{key}={value}\n"));
    }

    // Publish only after the replacement is private and durable. Tightening permissions after
    // writing exposes new bytes through the old mode (and through any links to the old inode).
    write_private_file(path, out.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn intelligence() -> Intelligence {
        Intelligence {
            api_url: "https://api.example".into(),
            gateway_ws_url: "wss://realtime.example".into(),
            api_key: "key".into(),
        }
    }

    /// A pinned image per Compose variable, as a release manifest supplies.
    fn pinned() -> Vec<(String, String)> {
        crate::deployment::IMAGE_VARIABLES
            .iter()
            .map(|(published, variable)| {
                (
                    (*variable).to_string(),
                    format!("ghcr.io/copilotkit/openbot-{published}@sha256:abc"),
                )
            })
            .collect()
    }

    fn engine_status(socket: Option<&str>) -> EngineStatus {
        EngineStatus {
            engine: None,
            address: None,
            responding: true,
            engine_socket: socket.map(str::to_string),
            detail: String::new(),
        }
    }

    #[test]
    fn multiline_compatible_models_cannot_create_or_replace_a_settings_file() {
        let dir = temp_root("env-multiline-model");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        for separator in ["\n", "\r", "\r\n"] {
            let settings = compose(
                &intelligence(),
                &Model {
                    credential: ModelCredential::Compatible {
                        base_url: "http://127.0.0.1:11434/v1".into(),
                        container_base_url: None,
                        api_key: "synthetic-key".into(),
                        model: format!("model{separator}UNREQUESTED=public-marker"),
                    },
                },
                &engine_status(None),
                &Ports::default(),
                &pinned(),
                None,
                &BTreeMap::new(),
            );
            let (owned, secrets) = crate::vault::split(settings);
            assert!(!owned.contains_key("OPENAI_API_KEY"));
            assert!(secrets.contains_key("OPENAI_API_KEY"));
            for existing in [false, true] {
                if existing {
                    std::fs::write(&path, "PUBLIC_SETTING=previous\n").unwrap();
                }
                let error = write(&path, &owned, &secrets).unwrap_err();
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
                assert!(!error.to_string().contains("public-marker"));
                if existing {
                    assert_eq!(std::fs::read(&path).unwrap(), b"PUBLIC_SETTING=previous\n");
                    std::fs::remove_file(&path).unwrap();
                } else {
                    assert!(!path.exists());
                }
                assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_setting_name_cannot_introduce_another_row_or_leak_into_an_error() {
        let dir = temp_root("env-multiline-name");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        for separator in ["\r", "\n"] {
            let owned = BTreeMap::from([(
                format!("MODEL=public-marker{separator}UNREQUESTED"),
                "value".into(),
            )]);
            let error = write(&path, &owned, &BTreeMap::new()).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
            assert!(!error.to_string().contains("public-marker"));
            assert!(!path.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restarting_does_not_add_a_banner_to_the_file_every_time() {
        // The banner is a comment, and the preserve pass keeps comments, so the file grew by one
        // banner and one blank line on every start: fifty restarts, fifty banners.
        let dir = temp_root("env-banner");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        let mut owned = BTreeMap::new();
        owned.insert("SERVER_PORT".to_string(), "3000".to_string());
        owned.insert("KEY_ENCRYPTION_KEY".to_string(), "abc=".to_string());

        for _ in 0..5 {
            write(&path, &owned, &BTreeMap::new()).unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(text.matches(BANNER).count(), 1);
        // And the file is the same size on the fifth start as on the first.
        assert_eq!(text.lines().count(), 4);
    }

    #[test]
    fn a_comment_somebody_else_wrote_is_still_kept() {
        // Only the shell's own banner is dropped; the rule about leaving other lines alone stands.
        let dir = temp_root("env-keep");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# our proxy needs this
HTTPS_PROXY=http://proxy:8080
",
        )
        .unwrap();

        let mut owned = BTreeMap::new();
        owned.insert("SERVER_PORT".to_string(), "3000".to_string());
        write(&path, &owned, &BTreeMap::new()).unwrap();
        write(&path, &owned, &BTreeMap::new()).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(text.contains("# our proxy needs this"));
        assert!(text.contains("HTTPS_PROXY=http://proxy:8080"));
        assert_eq!(text.matches("# our proxy needs this").count(), 1);
        assert_eq!(text.matches(BANNER).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn env_replacement_does_not_publish_new_bytes_through_an_old_inode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_root("env-private-replacement");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "PUBLIC_SETTING=previous\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let previous = dir.join("previous-public-copy");
        std::fs::hard_link(&path, &previous).unwrap();
        let owned = BTreeMap::from([("SYNTHETIC_TOKEN".into(), "new-private-value".into())]);

        let result = write(&path, &owned, &BTreeMap::new());
        let previous_bytes = std::fs::read_to_string(&previous).unwrap();
        let current_bytes = std::fs::read_to_string(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(dir).unwrap();

        result.unwrap();
        assert_eq!(previous_bytes, "PUBLIC_SETTING=previous\n");
        assert!(current_bytes.contains("SYNTHETIC_TOKEN=new-private-value"));
        assert!(current_bytes.contains("PUBLIC_SETTING=previous"));
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn the_written_file_is_readable_only_by_its_owner() {
        // It holds KEY_ENCRYPTION_KEY and every minted token, so another local user must not be able
        // to read it off a shared machine.
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_root("env-perms");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        let mut owned = BTreeMap::new();
        owned.insert("KEY_ENCRYPTION_KEY".to_string(), "abc=".to_string());
        write(&path, &owned, &BTreeMap::new()).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_pasted_value_is_trimmed_the_way_the_model_key_beside_it_is() {
        // The setup screen enables its button on `value.trim() !== ""` and sends the untrimmed
        // string. The model key was rescued here; the three values entered on the same screen were
        // not, so a copied credential kept whatever whitespace the selection picked up.
        let env = compose(
            &Intelligence {
                api_url: "  https://api.example  ".into(),
                gateway_ws_url: "	wss://realtime.example
"
                .into(),
                api_key: " key-with-a-trailing-space ".into(),
            },
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: " sk-model ".into(),
                },
            },
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );

        assert_eq!(env["INTELLIGENCE_API_URL"], "https://api.example");
        assert_eq!(env["INTELLIGENCE_GATEWAY_WS_URL"], "wss://realtime.example");
        assert_eq!(env["INTELLIGENCE_API_KEY"], "key-with-a-trailing-space");
        // Unchanged, and the reason the other three now match it.
        assert_eq!(env["OPENAI_API_KEY"], "sk-model");
    }

    #[test]
    fn desktop_project_selection_replaces_and_purges_a_previous_cli_key() {
        let dir = temp_root("env-cli-project-selection");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "CPK_INTELLIGENCE_API_KEY=cpk-old-cli-project\nINTELLIGENCE_API_KEY=cpk-old-legacy\nCUSTOM=keep-me\n",
        )
        .unwrap();
        let selected = Intelligence {
            api_url: "https://selected.example".into(),
            gateway_ws_url: "wss://selected.example".into(),
            api_key: " cpk-desktop-project ".into(),
        };
        let (settings, secrets) = crate::vault::split(compose(
            &selected,
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        ));
        for key in ["CPK_INTELLIGENCE_API_KEY", "INTELLIGENCE_API_KEY"] {
            assert_eq!(secrets[key], "cpk-desktop-project");
            assert!(!settings.contains_key(key));
        }
        write(&path, &settings, &secrets).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("INTELLIGENCE_API_KEY="));
        assert!(saved.contains("CUSTOM=keep-me"));
        assert!(saved.contains("INTELLIGENCE_API_URL=https://selected.example"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A hosted CLI setup left `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID="openbot"` in the folder
    /// Desktop now runs from. Kept, it named a container the local Intelligence does not have, every
    /// message failed with "Failed to initialize thread", and auto-assign was off. After a Start the
    /// only value in the file is Desktop's empty one, which the server reads as "assign one".
    #[test]
    fn a_learning_container_an_earlier_setup_named_gives_way_to_auto_assign() {
        let dir = temp_root("env-stale-learning-container");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=\"openbot\"\nexport CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=openbot\nCUSTOM=keep-me\n",
        )
        .unwrap();
        let (settings, secrets) = crate::vault::split(compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        ));
        write(&path, &settings, &secrets).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        let named: Vec<&str> = saved
            .lines()
            .filter(|line| line.contains("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID"))
            .collect();
        assert_eq!(named, ["CPK_INTELLIGENCE_LEARNING_CONTAINER_ID="]);
        assert!(saved.contains("CUSTOM=keep-me"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_value_with_nothing_around_it_is_untouched() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-model".into(),
                },
            },
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(env["INTELLIGENCE_API_URL"], "https://api.example");
        assert_eq!(env["INTELLIGENCE_API_KEY"], "key");
    }

    #[test]
    fn every_shared_secret_is_generated_rather_than_the_published_dev_default() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        for key in [
            "COMPUTER_TOKEN",
            "SUPERVISOR_TOKEN",
            "WORKER_SHARED_SECRET",
            "KEY_ENCRYPTION_KEY",
        ] {
            let value = env.get(key).expect(key);
            assert!(!value.contains("openbot-dev"), "{key} kept a dev default");
            assert!(
                value.len() > 20,
                "{key} is too short to be a generated secret"
            );
        }
    }

    /**
    A SECOND START OF THE SAME DEPLOYMENT KEEPS THE KEY. This is the data-loss one.

    Every secret the server stores goes through `KEY_ENCRYPTION_KEY`, and `encrypt-sso-config.ts`
    names the symptom itself: a changed key leaves stored configuration unreadable and sign-in
    broken until it is registered again. The shell used to mint a new one on every Start, so
    everything the previous run had encrypted was orphaned by pressing a button labelled Start.
    */
    #[test]
    fn starting_again_keeps_what_the_first_start_minted() {
        let first = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        let kept: BTreeMap<String, String> = MINTED
            .iter()
            .map(|key| ((*key).to_string(), first[*key].clone()))
            .collect();
        let second = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &kept,
        );
        for key in MINTED {
            assert_eq!(first.get(key), second.get(key), "{key} was minted again");
        }
    }

    /// A blank one is not a value to keep. An empty line is what clearing looks like, not a secret.
    #[test]
    fn a_blank_kept_secret_is_minted_rather_than_carried() {
        let kept = BTreeMap::from([("KEY_ENCRYPTION_KEY".to_string(), "   ".to_string())]);
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &kept,
        );
        assert!(env["KEY_ENCRYPTION_KEY"].trim().len() > 20);
    }

    #[test]
    fn two_installs_do_not_share_a_key() {
        let a = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        let b = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_ne!(a.get("KEY_ENCRYPTION_KEY"), b.get("KEY_ENCRYPTION_KEY"));
    }

    #[test]
    fn the_server_may_reach_its_own_computer_on_loopback() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS")
                .map(String::as_str),
            Some("true"),
            "everything a desktop install talks to is on this machine"
        );
    }

    #[test]
    fn the_deployment_runs_the_personal_edition_and_its_package() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENBOT_EDITION").map(String::as_str),
            Some("personal")
        );
        assert_eq!(
            env.get("TENANT_PACKAGE_DIR").map(String::as_str),
            Some("../examples/personal")
        );
    }

    #[test]
    fn a_desktop_install_is_single_user_or_the_server_refuses_to_start() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENBOT_SINGLE_USER").map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn the_worker_is_told_where_the_server_is_or_it_refuses_to_start() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("SERVER_INTERNAL_URL").map(String::as_str),
            Some("http://127.0.0.1:3001")
        );
    }

    #[test]
    fn one_computer_and_no_supervisor_or_the_personal_edition_refuses_to_start() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("AGENT_COMPUTER_URL").map(String::as_str),
            Some("http://127.0.0.1:4100")
        );
        // Both written empty: the host's, and the one docker-compose.yml gives the server's
        // container, which is the supervisor unless this says otherwise.
        for key in [
            "COMPUTER_SUPERVISOR_URL",
            "COMPUTER_SUPERVISOR_CONTAINER_URL",
        ] {
            assert_eq!(env.get(key).map(String::as_str), Some(""), "{key}");
        }
        assert_eq!(
            env.get("COMPUTER_PERSON_ID").map(String::as_str),
            Some("personal")
        );
    }

    /// The Recorder in a browser on the one computer is handed this machine's loopback addresses
    /// for OpenBot and a local gateway, which in the computer's container are the container. Before
    /// these relays Record there connected and reached nothing; the computer now relays each port
    /// to where its container reaches it.
    #[test]
    fn the_one_computer_relays_openbot_and_a_local_gateway_from_its_loopback() {
        let compose_with = |gateway_ws_url: &str| {
            compose(
                &Intelligence {
                    api_url: "http://localhost:14400".into(),
                    gateway_ws_url: gateway_ws_url.into(),
                    api_key: "key".into(),
                },
                &Model::default(),
                &engine_status(None),
                &Ports {
                    app: 3011,
                    server: 3002,
                    ..Ports::default()
                },
                &pinned(),
                None,
                &BTreeMap::new(),
            )
        };
        assert_eq!(
            compose_with("ws://localhost:14401")
                .get("COMPUTER_LOOPBACK_RELAYS")
                .map(String::as_str),
            Some("3011=server:3001,3002=server:3001,14401=host.docker.internal:14401")
        );
        // A gateway elsewhere is reached at its own address: only OpenBot is relayed.
        assert_eq!(
            compose_with("wss://realtime.example")
                .get("COMPUTER_LOOPBACK_RELAYS")
                .map(String::as_str),
            Some("3011=server:3001,3002=server:3001")
        );
    }

    /// An installation from before this app ran the personal edition is moved to it by its next
    /// Start: the team settings it wrote are replaced, once each, and the person's own lines stay.
    #[test]
    fn an_earlier_team_installation_becomes_the_personal_edition_on_start() {
        let dir = temp_root("env-team-to-personal");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "TENANT_PACKAGE_DIR=../examples/fintech\n\
             COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4500\n\
             MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4201/ag-ui\n\
             MY_OWN=kept\n",
        )
        .unwrap();
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-test".into(),
                },
            },
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &env, &BTreeMap::new()).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        // Every value each key is given, in order, blank included.
        let lines = |key: &str| -> Vec<&str> {
            written
                .lines()
                .filter_map(|line| line.strip_prefix(key)?.strip_prefix('='))
                .collect()
        };
        assert_eq!(lines("OPENBOT_EDITION"), ["personal"]);
        assert_eq!(lines("TENANT_PACKAGE_DIR"), ["../examples/personal"]);
        assert_eq!(lines("MY_OWN"), ["kept"]);
        for key in [
            "COMPUTER_SUPERVISOR_URL",
            "COMPUTER_SUPERVISOR_CONTAINER_URL",
            "MANAGED_AGENT_AG_UI_URL",
        ] {
            assert_eq!(lines(key), [""], "{key}:\n{written}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An earlier app that could sign in through an organization wrote its address here. A Start
    /// takes it out, so the server runs for this one person; the person's own lines stay.
    #[test]
    fn an_earlier_organization_address_is_taken_out_by_a_start() {
        let dir = temp_root("env-organization-gone");
        std::fs::create_dir_all(&dir).unwrap();
        let path = env_at(&dir);
        std::fs::write(
            &path,
            "OPENBOT_ORGANIZATION_AUTH_URL=https://openbot.company.example\nMY_OWN=kept\n",
        )
        .unwrap();
        let settings = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert!(!settings.contains_key("OPENBOT_ORGANIZATION_AUTH_URL"));
        let purge: BTreeMap<String, String> = REMOVED_WHEN_UNSET
            .iter()
            .filter(|key| !settings.contains_key(**key))
            .map(|key| (key.to_string(), String::new()))
            .collect();
        write(&path, &settings, &purge).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("OPENBOT_ORGANIZATION_AUTH_URL"), "{text}");
        assert!(text.contains("MY_OWN=kept"), "{text}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The person's browser is shown in the OpenBot window, on the one computer, as hosted OpenBot
    /// shows it: Desktop runs no Chrome of its own beside the server. A Start over a file an earlier
    /// Desktop wrote, which ran one, points the server at no host-side browser (it would show the
    /// person a separate Chrome window for Teach a Bot) and leaves none of that browser's settings.
    #[test]
    fn a_start_points_the_server_at_no_host_side_browser_and_takes_out_an_earlier_ones() {
        let dir = temp_root("env-no-host-browser");
        std::fs::create_dir_all(&dir).unwrap();
        let path = env_at(&dir);
        std::fs::write(
            &path,
            "BROWSER_PORT=4107\n\
             OPENBOT_BROWSER_URL=http://127.0.0.1:4107\n\
             OPENBOT_BROWSER_CONTAINER_URL=http://host.docker.internal:4107\n\
             OPENBOT_BROWSER_ABSENT=no-chrome-or-edge\n\
             MY_OWN=kept\n",
        )
        .unwrap();
        // As a Start reads the ports an earlier Start chose, and composes this one's settings.
        let ports = Ports::read(&dir).unwrap();
        let settings = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &ports,
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        let purge: BTreeMap<String, String> = REMOVED_WHEN_UNSET
            .iter()
            .filter(|key| !settings.contains_key(**key))
            .map(|key| (key.to_string(), String::new()))
            .collect();
        write(&path, &settings, &purge).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        for key in [
            "OPENBOT_BROWSER_URL",
            "OPENBOT_BROWSER_CONTAINER_URL",
            "BROWSER_PORT",
            "OPENBOT_BROWSER_ABSENT",
        ] {
            assert!(!settings.contains_key(key), "{key} composed");
            assert!(!text.contains(key), "{key} left in the file:\n{text}");
        }
        assert!(text.contains("MY_OWN=kept"), "{text}");
        assert_eq!(value_of(&text, "OPENBOT_EDITION"), "personal");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_engine_socket_is_written_only_when_the_default_is_wrong() {
        let without = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert!(!without.contains_key("ENGINE_SOCKET"));

        let with = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(Some("/run/user/501/podman/podman.sock")),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            with.get("ENGINE_SOCKET").map(String::as_str),
            Some("/run/user/501/podman/podman.sock")
        );
    }

    /// Rootless Podman alone sends `host.docker.internal` to the address its namespace maps to this
    /// machine's loopback. Everywhere else `host-gateway` already gets there, and a value left from
    /// rootless Podman would send Docker's containers to an address nothing answers on.
    #[test]
    fn host_docker_internal_is_moved_only_under_rootless_podman() {
        let compose_with = |socket: Option<&str>| {
            compose(
                &intelligence(),
                &Model::default(),
                &engine_status(socket),
                &Ports::default(),
                &pinned(),
                None,
                &BTreeMap::new(),
            )
        };
        assert!(!compose_with(None).contains_key(HOST_GATEWAY_ENV));
        assert_eq!(
            compose_with(Some("/run/user/501/podman/podman.sock"))
                .get(HOST_GATEWAY_ENV)
                .map(String::as_str),
            Some(crate::engine::ROOTLESS_HOST_LOOPBACK)
        );
        assert!(REMOVED_WHEN_UNSET.contains(&HOST_GATEWAY_ENV));
    }

    /// The server's container is told how it reaches this machine, under every engine, so an agent
    /// a person registers at `http://127.0.0.1:<port>` is dialled here and not at the container.
    /// Under rootless Podman the name is the same and Compose maps it (test above).
    #[test]
    fn the_server_is_told_the_name_it_reaches_this_machine_by() {
        for socket in [None, Some("/run/user/501/podman/podman.sock")] {
            let env = compose(
                &intelligence(),
                &Model::default(),
                &engine_status(socket),
                &Ports::default(),
                &pinned(),
                None,
                &BTreeMap::new(),
            );
            assert_eq!(
                env.get(THIS_MACHINE_CONTAINER_HOST_ENV).map(String::as_str),
                Some("host.docker.internal"),
                "engine socket {socket:?}"
            );
        }
        // The same name the Desktop moves its own loopback addresses to.
        assert_eq!(
            container_address("http://127.0.0.1:8765/ag-ui"),
            format!("http://{CONTAINER_HOST}:8765/ag-ui")
        );
    }

    #[test]
    fn no_model_choice_advertises_a_bundled_bot() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(env["MANAGED_AGENT_AG_UI_URL"], "");
    }

    #[test]
    fn addresses_name_an_address_rather_than_localhost() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        for key in [
            "DATABASE_URL",
            "AGENT_COMPUTER_URL",
            "COMPUTER_SUPERVISOR_URL",
            "MANAGED_AGENT_AG_UI_URL",
        ] {
            assert!(!env[key].contains("localhost"), "{key} says localhost");
        }
    }

    #[test]
    fn writing_keeps_settings_the_shell_does_not_own() {
        let dir = temp_root("env");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "OPENAI_API_KEY=sk-somebodys-own\n# a comment\n").unwrap();

        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &env, &BTreeMap::new()).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("OPENAI_API_KEY=sk-somebodys-own"),
            "dropped a setting it does not own"
        );
        assert!(written.contains("# a comment"));
        assert!(written.contains("COMPUTER_SUPERVISOR_URL="));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rewriting_replaces_its_own_settings_rather_than_appending_them_twice() {
        let dir = temp_root("env-twice");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        let first = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &first, &BTreeMap::new()).unwrap();
        let second = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &second, &BTreeMap::new()).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            written.matches("KEY_ENCRYPTION_KEY=").count(),
            1,
            "the key was written twice"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn env_at(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        dir.join(".env")
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        temp_root(&format!("env-{name}"))
    }

    fn fresh() -> BTreeMap<String, String> {
        compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        )
    }

    fn value_of(text: &str, key: &str) -> String {
        text.lines()
            .find(|line| line.starts_with(&format!("{key}=")))
            .map(|line| line.split_once('=').unwrap().1.to_string())
            .unwrap_or_else(|| panic!("{key} is not in the file"))
    }

    #[test]
    fn restarting_keeps_every_secret_the_first_start_minted() {
        let dir = tmp("restart");
        let path = env_at(&dir);

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let after_install = std::fs::read_to_string(&path).unwrap();
        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let after_restart = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        for key in MINTED {
            assert_eq!(
                value_of(&after_install, key),
                value_of(&after_restart, key),
                "{key} was re-minted by a restart"
            );
        }
    }

    #[test]
    fn a_restart_that_re_mints_the_key_would_leave_the_vault_unreadable() {
        let dir = tmp("vault");
        let path = env_at(&dir);

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let installed = value_of(
            &std::fs::read_to_string(&path).unwrap(),
            "KEY_ENCRYPTION_KEY",
        );
        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let restarted = value_of(
            &std::fs::read_to_string(&path).unwrap(),
            "KEY_ENCRYPTION_KEY",
        );
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            installed, restarted,
            "every credential encrypted under the first key can no longer be decrypted"
        );
    }

    #[test]
    fn a_first_install_mints_rather_than_finding_nothing_to_carry() {
        let dir = tmp("first");
        let path = env_at(&dir);
        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        for key in MINTED {
            let value = value_of(&written, key);
            assert!(!value.is_empty(), "{key} was written empty");
            assert!(
                !PUBLISHED.contains(&value.as_str()),
                "{key} kept a published value"
            );
        }
    }

    #[test]
    fn a_published_value_is_replaced_rather_than_carried_forward() {
        let dir = tmp("published");
        let path = env_at(&dir);
        std::fs::write(
            &path,
            "KEY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\
             SUPERVISOR_TOKEN=openbot-dev-supervisor-token\n\
             COMPUTER_TOKEN=openbot-dev-computer-token\n\
             WORKER_SHARED_SECRET=openbot-dev-worker-secret\n",
        )
        .unwrap();

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        for published in PUBLISHED {
            assert!(
                !written.contains(published),
                "a .env copied from a developer kept {published}"
            );
        }
    }

    #[test]
    fn a_key_the_server_would_refuse_is_replaced_rather_than_carried_forward() {
        for refused in ["", "not base64 at all", "c2hvcnQ="] {
            let dir = tmp("refused");
            let path = env_at(&dir);
            std::fs::write(&path, format!("KEY_ENCRYPTION_KEY={refused}\n")).unwrap();

            write(&path, &fresh(), &BTreeMap::new()).unwrap();
            let written = std::fs::read_to_string(&path).unwrap();
            std::fs::remove_dir_all(&dir).ok();

            let value = value_of(&written, "KEY_ENCRYPTION_KEY");
            assert_ne!(
                value, refused,
                "carried a key the server refuses to start on"
            );
            assert_eq!(
                BASE64.decode(&value).map(|bytes| bytes.len()).unwrap_or(0),
                32,
                "wrote a key that is not 32 bytes"
            );
        }
    }

    #[test]
    fn a_commented_out_secret_is_not_read_as_one() {
        let dir = tmp("commented");
        let path = env_at(&dir);
        std::fs::write(&path, "# KEY_ENCRYPTION_KEY=commented-out-and-not-a-key\n").unwrap();

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_ne!(
            value_of(&written, "KEY_ENCRYPTION_KEY"),
            "commented-out-and-not-a-key"
        );
    }

    #[test]
    fn a_secret_somebody_set_by_hand_is_the_one_that_is_kept() {
        let dir = tmp("byhand");
        let path = env_at(&dir);
        let theirs = BASE64.encode([7u8; 32]);
        std::fs::write(&path, format!("KEY_ENCRYPTION_KEY={theirs}\n")).unwrap();

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(value_of(&written, "KEY_ENCRYPTION_KEY"), theirs);
    }

    #[test]
    fn everything_that_is_not_a_secret_still_takes_this_run_s_value() {
        let dir = tmp("notsecret");
        let path = env_at(&dir);
        write(&path, &fresh(), &BTreeMap::new()).unwrap();

        let moved = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports {
                server: 3999,
                ..Ports::default()
            },
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &moved, &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(value_of(&written, "SERVER_PORT"), "3999");
        assert_eq!(
            value_of(&written, "SERVER_INTERNAL_URL"),
            "http://127.0.0.1:3999",
            "a setting that is not a secret was carried forward and is now stale"
        );
        assert_eq!(
            value_of(&written, "OPENBOT_TOOL_URL"),
            "http://server:3001/api/agent-tools/call",
            "Bots call the server container by name, on its own port, whatever the host port"
        );
    }

    /// Connecting an app over its own OAuth (Notion, and every other first-party one) refused with
    /// "Ask an admin to set OPENBOT_PUBLIC_URL", because nothing wrote it: the vendor sends the
    /// person's browser back to that address, and without one there is nowhere to come back to.
    /// An installation that ran before this was written gets it on its next Start, and a Start that
    /// moved the app to another port moves it too, rather than keeping the address of the last one.
    #[test]
    fn the_public_url_is_the_app_s_own_loopback_address_and_follows_its_port() {
        let dir = tmp("public-url");
        let path = env_at(&dir);
        // What an earlier Desktop left behind: no public URL, and a line the person added.
        std::fs::write(&path, "OPENBOT_EDITION=personal\nAPP_PORT=3010\n").unwrap();

        write(&path, &fresh(), &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            value_of(&written, "OPENBOT_PUBLIC_URL"),
            "http://127.0.0.1:3010"
        );

        let moved = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports {
                app: 3011,
                ..Ports::default()
            },
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        write(&path, &moved, &BTreeMap::new()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            value_of(&written, "OPENBOT_PUBLIC_URL"),
            "http://127.0.0.1:3011",
            "the public URL kept the port of an earlier Start"
        );
        assert_eq!(
            written
                .lines()
                .filter(|line| line.starts_with("OPENBOT_PUBLIC_URL="))
                .count(),
            1
        );
    }

    /// After the person approves an app in their browser, Composio sends them back to the app's
    /// own address, which the server takes from the first of `TRUSTED_ORIGINS` (`appUrl` in
    /// server/src/config.ts). That was `http://localhost:3010`: `localhost` may resolve to the
    /// address the engine did not publish, and OpenBot names this machine by number everywhere
    /// else. The first is 127.0.0.1, and the other two names are still trusted.
    #[test]
    fn the_app_s_own_address_is_127_0_0_1_and_never_localhost() {
        let env = fresh();
        let origins: Vec<&str> = env["TRUSTED_ORIGINS"].split(',').collect();
        assert_eq!(origins.first(), Some(&"http://127.0.0.1:3010"));
        assert!(origins.contains(&"http://localhost:3010"));
        assert!(origins.contains(&"http://[::1]:3010"));
    }

    #[test]
    fn selected_harness_uses_dynamic_host_port_without_changing_image_port() {
        let ports = Ports {
            harness: Some(52106),
            ..Ports::default()
        };
        let settings = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &ports,
            &pinned(),
            Some(&PickedHarness::Installed {
                image: "synthetic:local".into(),
                port: 4206,
                name: "Synthetic".into(),
                mastra: false,
                run_path: "/ag-ui".into(),
                remote_agent_id: String::new(),
            }),
            &BTreeMap::new(),
        );
        assert_eq!(settings["PICKED_HARNESS_PORT"], "4206");
        assert_eq!(settings["PICKED_HARNESS_HOST_PORT"], "52106");
        assert_eq!(
            settings["PICKED_HARNESS_URL"],
            "http://127.0.0.1:52106/ag-ui"
        );
        // The server container dials the service by name, on the image's port.
        assert_eq!(
            settings["PICKED_HARNESS_CONTAINER_URL"],
            "http://agent-harness:4206/ag-ui"
        );
    }

    #[test]
    fn a_remote_harness_and_no_harness_leave_no_container_address() {
        let remote = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            Some(&PickedHarness::RemoteAgUi {
                url: "https://agents.example/run".into(),
                name: "Remote".into(),
                remote_agent_id: String::new(),
            }),
            &BTreeMap::new(),
        );
        assert_eq!(remote["PICKED_HARNESS_URL"], "https://agents.example/run");
        assert_eq!(remote["PICKED_HARNESS_CONTAINER_URL"], "");

        let none = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(none["PICKED_HARNESS_CONTAINER_URL"], "");
    }

    /// Local Intelligence answers on loopback; the server's container reaches it through the host.
    #[test]
    fn local_intelligence_gets_a_container_address_and_hosted_does_not() {
        for (given, expected) in [
            (
                "http://localhost:18082",
                "http://host.docker.internal:18082",
            ),
            ("ws://localhost:14401", "ws://host.docker.internal:14401"),
            ("ws://localhost:14401/", "ws://host.docker.internal:14401/"),
            (
                "http://127.0.0.1:8082/api",
                "http://host.docker.internal:8082/api",
            ),
            ("http://[::1]:8082", "http://host.docker.internal:8082"),
            (
                "http://cpk.localhost:8080",
                "http://host.docker.internal:8080",
            ),
            (
                " http://localhost:18082 ",
                "http://host.docker.internal:18082",
            ),
            ("https://api.intelligence.copilotkit.ai", ""),
            ("wss://realtime.intelligence.copilotkit.ai", ""),
            ("http://localhost.evil.test:8082", ""),
            ("not a url", ""),
            ("", ""),
        ] {
            assert_eq!(container_address(given), expected, "{given}");
        }

        let env = compose(
            &Intelligence {
                api_url: "http://localhost:18082".into(),
                gateway_ws_url: "ws://localhost:14401".into(),
                api_key: "synthetic".into(),
            },
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        // The host's own addresses, which the browser reads the gateway's from, at 127.0.0.1.
        assert_eq!(env["INTELLIGENCE_API_URL"], "http://127.0.0.1:18082");
        assert_eq!(env["INTELLIGENCE_GATEWAY_WS_URL"], "ws://127.0.0.1:14401");
        assert_eq!(
            env["INTELLIGENCE_CONTAINER_API_URL"],
            "http://host.docker.internal:18082"
        );
        assert_eq!(
            env["INTELLIGENCE_CONTAINER_GATEWAY_WS_URL"],
            "ws://host.docker.internal:14401"
        );
    }

    /// The local Intelligence CLI reports its stack at `localhost`, and `docker-compose.yml` hands
    /// the gateway address to the browser as `INTELLIGENCE_BROWSER_GATEWAY_WS_URL`. The stack
    /// publishes on `127.0.0.1` alone, and the Recorder opens a plain `ws://` gateway only at
    /// `127.0.0.1` or `[::1]`, so `ws://localhost:51798` in the file left every recording unsaved.
    #[test]
    fn a_local_intelligence_is_written_at_127_0_0_1_and_nothing_written_dials_localhost() {
        let env = compose(
            &Intelligence {
                api_url: "http://localhost:51796".into(),
                gateway_ws_url: "ws://localhost:51798".into(),
                api_key: "synthetic".into(),
            },
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(env["INTELLIGENCE_API_URL"], "http://127.0.0.1:51796");
        assert_eq!(env["INTELLIGENCE_GATEWAY_WS_URL"], "ws://127.0.0.1:51798");
        assert_eq!(
            env["COMPUTER_LOOPBACK_RELAYS"],
            format!(
                "{app}=server:3001,{server}=server:3001,51798=host.docker.internal:51798",
                app = Ports::default().app,
                server = Ports::default().server
            )
        );
        for (key, value) in &env {
            // An allowlist of origins a browser may send, compared rather than dialled.
            if key == "TRUSTED_ORIGINS" {
                continue;
            }
            assert!(!value.contains("//localhost"), "{key}={value}");
        }

        for (given, expected) in [
            ("ws://localhost:51798", "ws://127.0.0.1:51798"),
            ("ws://localhost:51798/", "ws://127.0.0.1:51798/"),
            (" http://LOCALHOST:8082/api ", "http://127.0.0.1:8082/api"),
            ("http://127.0.0.1:8082", "http://127.0.0.1:8082"),
            ("http://[::1]:8082", "http://[::1]:8082"),
            // A host name a service routes or keeps a session by, not a spelling of loopback.
            ("http://cpk.localhost:8080", "http://cpk.localhost:8080"),
            (
                "http://localhost.evil.test:8082",
                "http://localhost.evil.test:8082",
            ),
            (
                "wss://realtime.intelligence.copilotkit.ai",
                "wss://realtime.intelligence.copilotkit.ai",
            ),
            ("not a url", "not a url"),
            ("", ""),
        ] {
            assert_eq!(numeric_loopback(given), expected, "{given}");
        }
    }
}

#[cfg(test)]
mod model_tests {
    use super::*;
    use crate::test_support::temp_root;

    fn intelligence() -> Intelligence {
        Intelligence {
            api_url: "https://api.example".into(),
            gateway_ws_url: "wss://realtime.example".into(),
            api_key: "key".into(),
        }
    }

    fn pinned() -> Vec<(String, String)> {
        crate::deployment::IMAGE_VARIABLES
            .iter()
            .map(|(published, variable)| {
                (
                    (*variable).to_string(),
                    format!("ghcr.io/copilotkit/openbot-{published}@sha256:abc"),
                )
            })
            .collect()
    }

    fn engine() -> EngineStatus {
        EngineStatus {
            engine: None,
            address: None,
            responding: true,
            engine_socket: None,
            detail: String::new(),
        }
    }

    #[test]
    fn every_image_is_named_by_digest_so_compose_never_reaches_for_a_local_build() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        for (_, variable) in crate::deployment::IMAGE_VARIABLES {
            let reference = env
                .get(variable)
                .unwrap_or_else(|| panic!("{variable} is not set, so Compose would build instead"));
            assert!(reference.contains("@sha256:"), "{variable}={reference}");
        }
    }

    #[test]
    fn the_model_key_is_written_when_one_is_given() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-a-real-one".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-a-real-one")
        );
    }

    #[test]
    fn a_blank_model_key_is_left_out_rather_than_written_empty() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "   ".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
    }

    /// The must-not case, and the reason `ModelCredential` is a choice rather than two fields.
    ///
    /// `ANTHROPIC_API_KEY` wins over the plan's OAuth token in the Claude Agent SDK, so a stack
    /// carrying both bills a person who signed in to a plan they already pay for. The key is
    /// written EMPTY rather than left out, because `write` preserves lines it does not own and an
    /// older key would otherwise survive.
    #[test]
    fn a_claude_plan_never_leaves_an_anthropic_key_in_place() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ClaudePlan {
                    token: "oauth-token".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(&"oauth-token".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
    }

    /// The kind is written the way the package spells it, and the address is the image's own port
    /// on loopback because the server is a host process rather than a container.
    ///
    /// The kind matters beyond correctness: a package carrying a literal `remote-mastra` row stops
    /// any server predating that kind from starting at all, since the loader refuses an unknown
    /// `agent.type` by refusing the whole file.
    #[test]
    fn a_picked_harness_is_addressed_once_and_named_as_a_kind() {
        for (mastra, expected, port, run_path, url) in [
            (false, "remote-ag-ui", 4202, "", "http://127.0.0.1:4202"),
            (
                false,
                "remote-ag-ui",
                4203,
                "/agui",
                "http://127.0.0.1:4203/agui",
            ),
            (
                false,
                "remote-ag-ui",
                4204,
                "/run",
                "http://127.0.0.1:4204/run",
            ),
            (true, "remote-mastra", 4202, "", "http://127.0.0.1:4202"),
        ] {
            let env = compose(
                &intelligence(),
                &Model::default(),
                &engine(),
                &Ports::default(),
                &pinned(),
                Some(&PickedHarness::Installed {
                    image: "openbot-agent-crewai".into(),
                    port,
                    name: "CrewAI".into(),
                    mastra,
                    remote_agent_id: String::new(),
                    run_path: run_path.into(),
                }),
                &BTreeMap::new(),
            );
            assert_eq!(
                env.get("PICKED_HARNESS_KIND").map(String::as_str),
                Some(expected)
            );
            assert_eq!(env.get("PICKED_HARNESS_URL").map(String::as_str), Some(url));
        }
    }

    #[test]
    fn a_byo_harness_writes_only_the_remote_ag_ui_address_and_kind() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            Some(&PickedHarness::RemoteAgUi {
                url: "https://agent.example/ag-ui".into(),
                name: "An agent you already run".into(),
                remote_agent_id: String::new(),
            }),
            &BTreeMap::new(),
        );

        assert_eq!(
            env.get("PICKED_HARNESS_URL").map(String::as_str),
            Some("https://agent.example/ag-ui")
        );
        assert_eq!(
            env.get("PICKED_HARNESS_KIND").map(String::as_str),
            Some("remote-ag-ui")
        );
        assert_eq!(
            env.get("PICKED_HARNESS_NAME").map(String::as_str),
            Some("An agent you already run")
        );
        assert!(!env.contains_key("PICKED_HARNESS_IMAGE"));
        assert!(!env.contains_key("PICKED_HARNESS_PORT"));
        assert!(!env.contains_key("PICKED_HARNESS_AGENT_ID"));
    }

    #[test]
    fn harness_provenance_is_replaced_and_cleared_in_saved_settings() {
        let dir = temp_root("harness-provenance");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".env");
        let installed = PickedHarness::Installed {
            image: "synthetic-harness".into(),
            port: 4206,
            name: "Installed".into(),
            mastra: false,
            run_path: "/ag-ui".into(),
            remote_agent_id: String::new(),
        };
        let byo = PickedHarness::RemoteAgUi {
            url: "https://agent.example/ag-ui".into(),
            name: "BYO".into(),
            remote_agent_id: String::new(),
        };
        for (selection, expected) in [
            (Some(&installed), "installed"),
            (Some(&byo), "byo"),
            (None, ""),
            (Some(&installed), "installed"),
        ] {
            let values = compose(
                &intelligence(),
                &Model::default(),
                &engine(),
                &Ports::default(),
                &pinned(),
                selection,
                &BTreeMap::new(),
            );
            write(&file, &values, &BTreeMap::new()).unwrap();
            let saved = std::fs::read_to_string(&file).unwrap();
            assert_eq!(
                saved
                    .lines()
                    .filter(|line| line.starts_with("PICKED_HARNESS_SOURCE="))
                    .collect::<Vec<_>>(),
                [format!("PICKED_HARNESS_SOURCE={expected}")]
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Nothing picked writes none of it, so the package's gated rows stay dropped.
    #[test]
    fn no_harness_picked_writes_no_harness_settings() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        for key in [
            "PICKED_HARNESS_IMAGE",
            "PICKED_HARNESS_PORT",
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_KIND",
        ] {
            assert!(
                !env.contains_key(key),
                "{key} was written with nothing picked"
            );
        }
    }

    /// The must-not case for the other plan. A ChatGPT plan token is not an OpenAI key and is not
    /// aimed with a base URL: the library pins the Codex address precisely so a token cannot be
    /// pointed at somebody else's server, and a leftover key would outrank the plan.
    #[test]
    fn a_chatgpt_plan_writes_no_key_and_aims_at_nothing() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ChatGptPlan {
                    store: "{\"access_token\":\"a\",\"refresh_token\":\"r\"}".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("CHATGPT_AUTH_FILE"),
            Some(&CHATGPT_STORE_INSIDE.to_string())
        );
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
        assert_eq!(env.get("OPENAI_BASE_URL"), Some(&String::new()));
    }

    /// The server is told why Learning has no model, empty when it has one, and a Start that chose
    /// nothing leaves the setting as it was. Learning's secret is minted like the other tokens.
    #[test]
    fn the_server_hears_whether_learning_has_a_model_and_gets_its_secret() {
        let written = |credential: ModelCredential| {
            compose(
                &intelligence(),
                &Model { credential },
                &engine(),
                &Ports::default(),
                &pinned(),
                None,
                &BTreeMap::new(),
            )
        };
        let plan = written(ModelCredential::ClaudePlan { token: "t".into() });
        assert_eq!(
            plan.get(crate::learning_model::UNAVAILABLE),
            Some(&String::new())
        );
        assert!(plan
            .get(crate::learning_model::TOKEN)
            .is_some_and(|secret| secret.len() >= 32));
        assert_eq!(
            written(ModelCredential::ProviderOAuth {
                provider: "google".into(),
                path: "/x".into(),
                proxy_token: "p".into(),
                model: "m".into(),
            })
            .get(crate::learning_model::UNAVAILABLE),
            Some(&"unsupported".to_string())
        );
        assert_eq!(
            written(ModelCredential::None).get(crate::learning_model::UNAVAILABLE),
            None
        );
        assert!(crate::vault::is_secret(crate::learning_model::TOKEN));
    }

    #[test]
    fn the_chatgpt_store_host_path_stays_inside_the_mounted_langchain_directory() {
        let path = Path::new(CHATGPT_STORE_FILE);
        assert_eq!(path.parent(), Some(Path::new(".langchain")));
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("chatgpt-auth.json")
        );
        assert_eq!(CHATGPT_STORE_INSIDE, "/root/.langchain/chatgpt-auth.json");
    }

    /// THE CREDENTIAL ITSELF NEVER REACHES THE `.env`, only the path of the file holding it.
    ///
    /// Worth asserting rather than assuming: the `.env` is the file a person is most likely to open
    /// or paste, and a refresh token in it is a standing grant on somebody's ChatGPT subscription.
    #[test]
    fn the_plan_store_is_not_written_into_the_env() {
        let secret = "refresh-token-that-must-not-appear";
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ChatGptPlan {
                    store: format!("{{\"refresh_token\":\"{secret}\"}}"),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert!(
            !env.values().any(|value| value.contains(secret)),
            "the plan's store reached the .env"
        );
    }

    /// A key this app has stopped using is emptied, not left holding a credential forever.
    #[test]
    fn the_retired_plan_token_is_cleared() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-x".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(env.get("CHATGPT_OAUTH_TOKEN"), Some(&String::new()));
    }

    /// The file is laid down even with no plan, because a missing mount source becomes a directory.
    #[test]
    fn the_store_file_is_written_whatever_the_choice() {
        let dir = temp_root("store");
        std::fs::create_dir_all(&dir).unwrap();

        write_plan_store(
            &dir,
            &ModelCredential::OpenAi {
                api_key: "sk-x".into(),
            },
        )
        .unwrap();
        let path = dir.join(CHATGPT_STORE_FILE);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "{}");

        write_plan_store(
            &dir,
            &ModelCredential::ChatGptPlan {
                store: "{\"refresh_token\":\"r\"}".into(),
            },
        )
        .unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"r\""));

        // And signing out of the plan clears it, on the same reasoning as the keys that get emptied.
        write_plan_store(&dir, &ModelCredential::None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "{}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the store was readable by others");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /**
    Switching away from the compatible row does not leave its model name behind.

    Measured on a real pass: the compatible row set `BOT_MODEL=local-model`, and answering with an
    OpenAI key afterwards kept it, so the Bot asked OpenAI for a model only that person's own
    endpoint has. The last screen said "That account cannot use the model that was chosen" about a
    model this run never chose.
    */
    #[test]
    fn a_model_name_does_not_survive_a_provider_that_does_not_name_one() {
        let compatible = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "http://127.0.0.1:4310/v1".into(),
                    container_base_url: None,
                    api_key: "x".into(),
                    model: "local-model".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            compatible.get("BOT_MODEL"),
            Some(&"local-model".to_string())
        );
        /*
         * And the bundled Bot's own variable, which is the one that was missed.
         *
         * `docker-compose.yml` reads `AGENT_BOT_MODEL` for `agent-bot` rather than `BOT_MODEL`, so
         * that a model chosen for the framework Bot cannot take its tools away. On a custom
         * endpoint that pin asked somebody's own server for `gpt-5.5`, which an Ollama or a vLLM
         * has never heard of.
         */
        assert_eq!(
            compatible.get("AGENT_BOT_MODEL"),
            Some(&"local-model".to_string())
        );

        let with_a_key = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-x".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        for key in ["BOT_MODEL", "AGENT_BOT_MODEL"] {
            assert!(
                !with_a_key.contains_key(key),
                "a key path carried a model name it never chose: {key}"
            );
        }
    }

    /**
    An endpoint that needs no key still gets a client that can be constructed.

    The failure this pins is the whole keyless half of the compatible row: the person fills in an
    address for their Ollama, leaves the key blank because it has none, and every Bot exits on
    startup because the OpenAI SDK will not build a client without a string. A placeholder is sent
    to an endpoint that does not read it.
    */
    #[test]
    fn a_keyless_endpoint_is_given_a_placeholder_rather_than_nothing() {
        let keyless = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "http://127.0.0.1:11434/v1".into(),
                    container_base_url: None,
                    api_key: "   ".into(),
                    model: "qwen2.5:1.5b".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            keyless.get("OPENAI_API_KEY"),
            Some(&NO_KEY_NEEDED.to_string())
        );
        assert_eq!(
            keyless.get("OPENAI_BASE_URL"),
            Some(&"http://127.0.0.1:11434/v1".to_string())
        );

        // And a real key is never replaced by it.
        let keyed = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "https://api.example.test/v1".into(),
                    container_base_url: None,
                    api_key: "sk-theirs".into(),
                    model: "some-model".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(keyed.get("OPENAI_API_KEY"), Some(&"sk-theirs".to_string()));
    }

    /// Switching provider does not leave the last one's key behind.
    ///
    /// Measured, not imagined: a run that signed in to a Claude plan still carried the
    /// OPENAI_API_KEY written by the run before it, and every harness was handed both. Whichever a
    /// harness reads first then decides what the person is billed for, which is the whole thing the
    /// plan path exists to avoid.
    #[test]
    fn answering_the_model_screen_clears_the_keys_it_does_not_imply() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ClaudePlan {
                    token: "oauth-token".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(&"oauth-token".to_string())
        );
        for cleared in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "ANTHROPIC_API_KEY",
            "BOT_PROVIDER",
        ] {
            assert_eq!(
                env.get(cleared),
                Some(&String::new()),
                "{cleared} survived a switch to a Claude plan"
            );
        }
    }

    /// An Anthropic key is written as one, and does not become an OpenAI key because that is the
    /// field this struct used to have.
    #[test]
    fn an_anthropic_key_is_an_anthropic_key() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Anthropic {
                    api_key: "sk-ant-real".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("ANTHROPIC_API_KEY"),
            Some(&"sk-ant-real".to_string())
        );
        assert_eq!(env.get("BOT_PROVIDER"), Some(&"anthropic".to_string()));
        // No model was chosen on that screen, so none is written for the server to treat as one.
        assert!(!env.contains_key("BOT_MODEL"));
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
    }

    #[test]
    fn an_openai_key_does_not_keep_an_anthropic_provider() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::OpenAi {
                    api_key: "sk-openai-real".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENAI_API_KEY"),
            Some(&"sk-openai-real".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
        assert_eq!(env.get("BOT_PROVIDER"), Some(&String::new()));
        assert!(!env.contains_key("BOT_MODEL"));
    }

    /// The everything-else row writes all three, since an endpoint without a model name is an
    /// endpoint that answers with a complaint about a model nobody chose.
    #[test]
    fn a_compatible_endpoint_carries_its_address_and_its_model() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "https://example.test/v1".into(),
                    container_base_url: None,
                    api_key: "sk-whatever".into(),
                    model: "some-model".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENAI_BASE_URL"),
            Some(&"https://example.test/v1".to_string())
        );
        assert_eq!(env.get("BOT_MODEL"), Some(&"some-model".to_string()));
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"sk-whatever".to_string()));
        // Nothing about Anthropic is implied by choosing an OpenAI-compatible endpoint.
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
    }

    #[test]
    fn a_compatible_endpoint_can_give_containers_their_own_base_url() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "http://127.0.0.1:11434/v1".into(),
                    container_base_url: Some("http://ollama:11434/v1".into()),
                    api_key: "".into(),
                    model: "qwen3-vl:2b".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENAI_BASE_URL"),
            Some(&"http://127.0.0.1:11434/v1".to_string())
        );
        assert_eq!(
            env.get("OPENAI_CONTAINER_BASE_URL"),
            Some(&"http://ollama:11434/v1".to_string())
        );
    }

    #[test]
    fn a_compatible_endpoint_without_container_url_clears_stale_container_override() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "https://models.example/v1".into(),
                    container_base_url: None,
                    api_key: "".into(),
                    model: "remote-model".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        assert_eq!(
            env.get("OPENAI_BASE_URL"),
            Some(&"https://models.example/v1".to_string())
        );
        assert_eq!(env.get("OPENAI_CONTAINER_BASE_URL"), Some(&String::new()));
    }

    /// Nothing chosen writes no model keys at all, rather than empty ones.
    #[test]
    fn no_choice_writes_no_model_keys() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
            &BTreeMap::new(),
        );
        // Untouched, not cleared: a key somebody set by hand is theirs to keep while the model
        // screen has not answered. See the note in `compose`.
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_AUTH_FILE",
        ] {
            assert!(
                !env.contains_key(key),
                "{key} was written with no choice made"
            );
        }
    }

    /// The wizard does not ask twice for something already in the file.
    #[test]
    fn what_is_already_set_is_read_back() {
        let dir = temp_root("read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# a comment\nINTELLIGENCE_API_KEY=already-here\nINTELLIGENCE_API_URL=\nSOMETHING_ELSE=theirs\n",
        )
        .unwrap();

        let found = already_set(
            &path,
            &[
                "INTELLIGENCE_API_KEY",
                "INTELLIGENCE_API_URL",
                "SOMETHING_ELSE",
            ],
        );
        assert_eq!(
            found.get("INTELLIGENCE_API_KEY").map(String::as_str),
            Some("already-here")
        );
        // Blank is not a value: the writer clears keys a choice does not imply, and handing those
        // back would undo that.
        assert!(!found.contains_key("INTELLIGENCE_API_URL"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn strict_read_reports_unreadable_env_but_missing_file_is_empty() {
        let dir = temp_root("strict-read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        let missing = read_already_set(&path, &["INTELLIGENCE_API_KEY"]).unwrap();
        assert!(missing.is_empty());

        std::fs::create_dir(&path).unwrap();
        let directory = read_already_set(&path, &["INTELLIGENCE_API_KEY"])
            .expect_err("a directory .env is not a first-run empty file");
        assert_ne!(directory.kind(), std::io::ErrorKind::NotFound);
        std::fs::remove_dir(&path).unwrap();

        std::fs::write(&path, b"INTELLIGENCE_API_KEY=\xff\n").unwrap();
        let invalid = read_already_set(&path, &["INTELLIGENCE_API_KEY"])
            .expect_err("invalid UTF-8 must not be treated as absent");
        assert_eq!(invalid.kind(), std::io::ErrorKind::InvalidData);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_preserves_invalid_utf8_input_byte_for_byte() {
        let dir = temp_root("invalid-write");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        let original = b"CUSTOM=\xff\nINTELLIGENCE_API_KEY=legacy\n".to_vec();
        std::fs::write(&path, &original).unwrap();

        let error = write(
            &path,
            &BTreeMap::from([("INTELLIGENCE_API_KEY".into(), "replacement".into())]),
            &BTreeMap::new(),
        )
        .expect_err("invalid UTF-8 input must stop replacement writes");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only what the wizard asks about. The rest of that file is somebody else's.
    #[test]
    fn nothing_the_wizard_did_not_ask_for_is_read_back() {
        let dir = temp_root("read2");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "PRIVATE_THING=not-yours\nINTELLIGENCE_API_KEY=k\n").unwrap();
        let found = already_set(&path, &["INTELLIGENCE_API_KEY"]);
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key("PRIVATE_THING"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No file is not an error; it is a first run.
    #[test]
    fn a_missing_file_reads_back_nothing() {
        let found = already_set(Path::new("/nowhere/at/all/.env"), &["INTELLIGENCE_API_KEY"]);
        assert!(found.is_empty());
    }
}
