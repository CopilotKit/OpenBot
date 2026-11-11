//! OpenBot's dead port rules, removed after its machine starts on Windows.
//!
//! **What goes wrong.** Every WSL 2 distro runs in one utility VM and shares its network namespace
//! ("Linux distributions running via WSL 2 will share the same network namespace", Microsoft's
//! "What is WSL 2?"), and a Podman machine on Windows is a WSL distro. Rootful Podman publishes a
//! port with netavark's DNAT rules in that namespace. `podman machine stop` ends the distro
//! (`WSLStubber.StopVM`: systemd stopped, then `wsl --terminate`), so the containers' processes and
//! `/run` go, but the rules stay. Started again, the containers get new addresses, often the old
//! ones in a different order, and netavark appends their rules after the old ones. The first match
//! wins, so `127.0.0.1:3010` still goes to an address nothing holds, and the first Start waits
//! about 215 seconds or fails. Seen on a Windows test machine after OpenBot's own heal and update
//! restarts; reproduced with netavark 1.17.2 (Podman 5.8.9, iptables) and 2.1.0 (Podman 6.1.3,
//! nftables) in `live` below. A Mac's machine is a VM with a kernel of its own: stopping it ends its
//! namespace and every rule in it, so nothing outlives a restart there.
//!
//! **Why not a Podman or netavark command.** None removes a rule for an address from an earlier
//! start. `podman network reload` tears down and sets up each running container's own rules, for
//! the address it has now (`reloadContainerNetwork` in libpod), and netavark appends the new ones
//! after the old (`append_unique`), so they stay behind them. `netavark firewall-reload` (1.17)
//! only sets up again what its state files hold. A network's complete teardown deletes its chain
//! only when it is empty (netavark 1.x `VarkChain::remove`), and nft refuses to delete a chain that
//! still has rules (2.x). Both commands were run on the reproduction and the port stayed dead.
//!
//! **What is removed, and only that.** A DNAT rule in a chain netavark keeps for one of OpenBot's
//! own networks, whose address is in that network and held by no container running on OpenBot's
//! machine. Every other rule in the namespace belongs to somebody else and is left alone: another
//! Podman machine's, whose networks are not OpenBot's machine's, and Docker Desktop's, which are
//! not netavark's. The default network, `podman`, has the same name and id on every machine, so
//! its chain is shared and never touched. A network of the person's named like one of OpenBot's
//! would share its iptables chain, but not its subnet: Podman refuses a subnet already routed in
//! the namespace. The rules are read before the containers are, so a container that starts in
//! between is seen running.
//!
//! netavark names a network's DNAT chain one of two ways, and both are looked for:
//! - iptables, netavark 1.x (Podman forces it on WSL before 6.0): `NETAVARK-DN-` and the first 13
//!   hex digits of the SHA-512 of the network's name, in `ip nat` and `ip6 nat`
//!   (`get_port_forwarding_chains`, `create_network_hash`).
//! - nftables, netavark 2.x: `nv_<first 8 of the network id>_<subnet>_dnat` in `inet netavark`
//!   (`get_subnet_chain_name`).
//!
//! **Rules a removed machine left.** A machine OpenBot's uninstall removed, with OpenBot installed
//! again after it, leaves its rules in the namespace in chains no network on the new machine maps
//! to, ahead of the new machine's. On a Windows test machine 3001, 3010, 5432, 4100 and 4206 went
//! to its addresses, and OpenBot stopped at "Opening OpenBot". OpenBot can't see that machine's
//! networks any more, so such a chain is taken for OpenBot's only when every one of these holds
//! (`orphan_rules`): no network on OpenBot's machine maps to it; every rule in it publishes one of
//! OpenBot's own host ports (published by a container on OpenBot's machine, stopped ones included,
//! or recorded for the installation, `remember_own_ports`); and every address it sends to is dead:
//! held by no container running on OpenBot's machine, and either in one of OpenBot's networks or
//! reached by no bridge with anything attached (no route, or `linkdown`). A machine of the
//! person's that publishes one of those ports is never taken for it: its running container keeps
//! its bridge up. The same holds for rules in one of OpenBot's own iptables chains for an address
//! outside that network, which a removed machine's network of the same name left.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;

use serde::Deserialize;
use sha2::{Digest, Sha512};

/// Printed between the ruleset and the networks, to tell them apart.
pub const BETWEEN: &str = "--- openbot: podman network inspect ---";
/// Printed before the namespace's routes.
pub const ROUTES: &str = "--- openbot: ip route ---";
/// Printed before every container on OpenBot's machine, with the ports each publishes.
pub const PUBLISHED: &str = "--- openbot: podman ps ---";

/// The default network's id, the same on every machine.
const DEFAULT_NETWORK_ID: &str = "2f259bab93aaaaa2542ba43ef33eb990d0999ee1b9924b557b7be53c0b7a1bb9";

/// Run in the machine: its firewall, then OpenBot's networks with the containers running on each,
/// then the namespace's routes, then every container on OpenBot's machine with the ports it
/// publishes. In that order, so a container that starts or a bridge that comes up while this runs
/// is seen running. Through `sudo`, as the gateway's script is: a no-op for root, passwordless for
/// the machine's own user.
pub fn read_script() -> String {
    format!(
        "sudo nft -a list ruleset; echo '{BETWEEN}'; \
         sudo podman network inspect $(sudo podman network ls -q); echo '{ROUTES}'; \
         ip route show; ip -6 route show; echo '{PUBLISHED}'; sudo podman ps -a --format json"
    )
}

/// The host ports OpenBot's installation publishes, recorded by the app when it knows them.
static OWN_PORTS: std::sync::Mutex<std::collections::BTreeSet<u16>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Record host ports OpenBot's installation publishes, for `orphan_rules`.
pub fn remember_own_ports(ports: impl IntoIterator<Item = u16>) {
    OWN_PORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .extend(ports);
}

fn remembered_ports() -> std::collections::BTreeSet<u16> {
    OWN_PORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// One rule as `nft -a list ruleset` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub family: String,
    pub table: String,
    pub chain: String,
    pub handle: u64,
    /// As listed, without its handle.
    pub text: String,
    /// Where a DNAT rule sends traffic.
    pub to: Option<IpAddr>,
}

/// Every rule in an `nft -a list ruleset` listing, with the table and chain it is in.
pub fn rules(listing: &str) -> Vec<Rule> {
    let mut found = Vec::new();
    let mut table: Option<(String, String)> = None;
    let mut chain: Option<String> = None;
    let mut depth = 0usize;
    for line in listing.lines() {
        let line = line.trim();
        let (body, handle) = match line.rsplit_once(" # handle ") {
            Some((body, handle)) => (body.trim(), handle.trim().parse::<u64>().ok()),
            None => (line, None),
        };
        let mut words = body.split_whitespace();
        match depth {
            0 if words.next() == Some("table") => {
                table = words
                    .next()
                    .zip(words.next())
                    .map(|(family, name)| (family.to_string(), name.to_string()));
            }
            1 if words.next() == Some("chain") => chain = words.next().map(str::to_string),
            2 => {
                if let (Some((family, name)), Some(chain), Some(handle)) = (&table, &chain, handle)
                {
                    found.push(Rule {
                        family: family.clone(),
                        table: name.clone(),
                        chain: chain.clone(),
                        handle,
                        text: body.to_string(),
                        to: dnat_target(body),
                    });
                }
            }
            _ => {}
        }
        depth = depth.saturating_add_signed(brace_change(body));
        if depth < 2 {
            chain = None;
        }
        if depth < 1 {
            table = None;
        }
    }
    found
}

/// How a line changes the nesting, braces in quoted text not counted.
fn brace_change(line: &str) -> isize {
    let mut quoted = false;
    let mut change = 0;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            '{' if !quoted => change += 1,
            '}' if !quoted => change -= 1,
            _ => {}
        }
    }
    change
}

/// `dnat to 10.89.2.6:3001` (iptables-nft), `dnat ip to 10.89.0.3:80` (netavark's nftables), and
/// `dnat ip6 to [fd00::2]:80`: the address.
fn dnat_target(rule: &str) -> Option<IpAddr> {
    let words: Vec<&str> = rule.split_whitespace().collect();
    let at = words.iter().position(|word| *word == "dnat")?;
    let mut next = at + 1;
    if matches!(words.get(next), Some(&"ip") | Some(&"ip6")) {
        next += 1;
    }
    if words.get(next) != Some(&"to") {
        return None;
    }
    let address = words.get(next + 1)?;
    if let Some(v6) = address.strip_prefix('[') {
        return v6.split(']').next()?.parse().ok();
    }
    address
        .parse()
        .ok()
        .or_else(|| address.rsplit_once(':')?.0.parse().ok())
}

#[derive(Deserialize)]
struct Network {
    name: String,
    id: String,
    #[serde(default)]
    subnets: Vec<Subnet>,
    /// The containers running on it. Since Podman 5.0; without it nothing can be told apart.
    containers: Option<HashMap<String, Attached>>,
}

#[derive(Deserialize)]
struct Subnet {
    subnet: String,
}

#[derive(Deserialize)]
struct Attached {
    #[serde(default)]
    interfaces: HashMap<String, Interface>,
}

#[derive(Deserialize)]
struct Interface {
    #[serde(default)]
    subnets: Vec<Address>,
}

#[derive(Deserialize)]
struct Address {
    ipnet: String,
}

/// The DNAT rules in `listing` that are OpenBot's and dead, given OpenBot's machine's networks as
/// `podman network inspect` lists them.
pub fn dead_rules(listing: &str, networks: &str) -> Result<Vec<Rule>, String> {
    let networks: Vec<Network> = serde_json::from_str(networks)
        .map_err(|error| format!("could not read podman network inspect: {error}"))?;
    if let Some(network) = networks.iter().find(|network| network.containers.is_none()) {
        return Err(format!(
            "podman network inspect does not say which containers run on {} (Podman before 5.0), \
             so no rule is touched",
            network.name
        ));
    }
    let running: HashSet<IpAddr> = networks
        .iter()
        .flat_map(|network| network.containers.iter().flatten())
        .flat_map(|(_, container)| container.interfaces.values())
        .flat_map(|interface| &interface.subnets)
        .filter_map(|address| address.ipnet.split('/').next()?.parse().ok())
        .collect();
    let mut own: HashMap<(&str, &str, String), &[Subnet]> = HashMap::new();
    for network in networks
        .iter()
        .filter(|network| network.name != "podman" && network.id != DEFAULT_NETWORK_ID)
    {
        let chain = iptables_chain(&network.name);
        own.insert(("ip", "nat", chain.clone()), &network.subnets);
        own.insert(("ip6", "nat", chain), &network.subnets);
        for subnet in &network.subnets {
            own.insert(
                (
                    "inet",
                    "netavark",
                    nftables_chain(&network.id, &subnet.subnet),
                ),
                &network.subnets,
            );
        }
    }
    Ok(rules(listing)
        .into_iter()
        .filter(|rule| {
            let Some(to) = rule.to else {
                return false;
            };
            let key = (
                rule.family.as_str(),
                rule.table.as_str(),
                rule.chain.clone(),
            );
            own.get(&key).is_some_and(|subnets| {
                subnets.iter().any(|subnet| within(to, &subnet.subnet)) && !running.contains(&to)
            })
        })
        .collect())
}

/// netavark 1.x's DNAT chain for a network: `NETAVARK-DN-` and 13 hex digits of the SHA-512 of its
/// name, upper case.
fn iptables_chain(network: &str) -> String {
    let digest = Sha512::digest(network.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02X}")).collect();
    format!("NETAVARK-DN-{}", &hex[..13])
}

/// netavark 2.x's DNAT chain for one of a network's subnets.
fn nftables_chain(id: &str, subnet: &str) -> String {
    let id = id.get(..8).unwrap_or(id);
    let subnet = subnet
        .replace('.', "_")
        .replace(':', "-")
        .replace('/', "_nm");
    format!("nv_{id}_{subnet}_dnat")
}

fn within(address: IpAddr, subnet: &str) -> bool {
    let Some((network, length)) = subnet.split_once('/') else {
        return false;
    };
    let (Ok(network), Ok(length)) = (network.parse::<IpAddr>(), length.parse::<u32>()) else {
        return false;
    };
    match (address, network) {
        (IpAddr::V4(address), IpAddr::V4(network)) if length <= 32 => {
            let mask = u32::MAX.checked_shl(32 - length).unwrap_or(0);
            u32::from(address) & mask == u32::from(network) & mask
        }
        (IpAddr::V6(address), IpAddr::V6(network)) if length <= 128 => {
            let mask = u128::MAX.checked_shl(128 - length).unwrap_or(0);
            u128::from(address) & mask == u128::from(network) & mask
        }
        _ => false,
    }
}

/// Run in the machine to delete `dead`, each on its own: one already gone, its container's own
/// teardown having removed it meanwhile, does not keep the others.
pub fn delete_script(dead: &[Rule]) -> String {
    let mut script = String::from("failed=0;");
    for rule in dead {
        script.push_str(&format!(
            " sudo nft delete rule {} {} {} handle {} || failed=1;",
            rule.family, rule.table, rule.chain, rule.handle
        ));
    }
    script.push_str(" exit $failed");
    script
}

/// Remove OpenBot's dead port rules on `machine`, through `run` as `podman` runs, and say which.
pub fn clear_dead(
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    machine: &str,
) -> Result<Vec<Rule>, String> {
    let said = run(&["machine", "ssh", machine, &read_script()])?;
    let (listing, rest) = said
        .split_once(BETWEEN)
        .ok_or_else(|| format!("the machine did not list its rules and networks: {said}"))?;
    let (networks, rest) = rest.split_once(ROUTES).unwrap_or((rest, ""));
    let (routes, published) = rest.split_once(PUBLISHED).unwrap_or((rest, ""));
    let mut dead = dead_rules(listing, networks)?;
    if !routes.trim().is_empty() {
        for orphan in orphan_rules(listing, networks, routes, published, &remembered_ports())? {
            if !dead.contains(&orphan) {
                dead.push(orphan);
            }
        }
    }
    if !dead.is_empty() {
        run(&["machine", "ssh", machine, &delete_script(&dead)])?;
    }
    Ok(dead)
}

/// A container on OpenBot's machine as `podman ps -a --format json` lists it: only its ports.
#[derive(Deserialize)]
struct Listed {
    #[serde(rename = "Ports", default)]
    ports: Option<Vec<Published>>,
}

#[derive(Deserialize)]
struct Published {
    host_port: u16,
    #[serde(default)]
    range: u16,
}

/// The host ports the containers on OpenBot's machine publish, stopped ones included.
fn published_ports(published: &str) -> Result<HashSet<u16>, String> {
    if published.trim().is_empty() {
        return Ok(HashSet::new());
    }
    let listed: Vec<Listed> = serde_json::from_str(published)
        .map_err(|error| format!("could not read podman ps: {error}"))?;
    Ok(listed
        .into_iter()
        .flat_map(|container| container.ports.unwrap_or_default())
        .flat_map(|port| {
            let last = port.host_port.saturating_add(port.range.max(1) - 1);
            port.host_port..=last
        })
        .collect())
}

/// The host ports a DNAT rule matches: `dport 3010`, or a range, `dport 8000-8010`.
fn dports(rule: &str) -> Option<Vec<u16>> {
    let after = rule.split("dport ").nth(1)?.split_whitespace().next()?;
    match after.split_once('-') {
        Some((first, last)) => Some((first.parse().ok()?..=last.parse().ok()?).collect()),
        None => Some(vec![after.parse().ok()?]),
    }
}

/// Whether a bridge with something attached routes `address` in the namespace: a route that
/// covers it, other than the default one, without `linkdown`.
fn bridge_up_for(address: IpAddr, routes: &str) -> bool {
    routes.lines().any(|route| {
        let mut words = route.split_whitespace();
        let Some(prefix) = words.next() else {
            return false;
        };
        let covers = if prefix.contains('/') {
            within(address, prefix)
        } else {
            prefix.parse::<IpAddr>().is_ok_and(|host| host == address)
        };
        covers && !route.split_whitespace().any(|word| word == "linkdown")
    })
}

/// A chain netavark keeps for port forwarding, by either driver's name for it.
fn forwarding_chain(rule: &Rule) -> bool {
    match (rule.family.as_str(), rule.table.as_str()) {
        ("ip" | "ip6", "nat") => rule.chain.starts_with("NETAVARK-DN-"),
        ("inet", "netavark") => rule.chain.starts_with("nv_") && rule.chain.ends_with("_dnat"),
        _ => false,
    }
}

/**
The DNAT rules a machine OpenBot's uninstall removed left behind, given what OpenBot's machine
lists: its networks with the containers running on each (`networks`), the namespace's routes
(`routes`), and its containers with the ports each publishes (`published`). `own_ports` are the
installation's own, recorded by the app. See the module's "Rules a removed machine left".

For each forwarding chain, the rules no network on OpenBot's machine made: all of them in a chain
no network maps to, and in one a network maps to, those for an address outside that network. They
go together, or not at all: only when every one of them publishes one of OpenBot's own host ports
and sends to a dead address.
*/
pub fn orphan_rules(
    listing: &str,
    networks: &str,
    routes: &str,
    published: &str,
    own_ports: &std::collections::BTreeSet<u16>,
) -> Result<Vec<Rule>, String> {
    let networks: Vec<Network> = serde_json::from_str(networks)
        .map_err(|error| format!("could not read podman network inspect: {error}"))?;
    if networks.iter().any(|network| network.containers.is_none()) {
        return Ok(Vec::new());
    }
    let running: HashSet<IpAddr> = networks
        .iter()
        .flat_map(|network| network.containers.iter().flatten())
        .flat_map(|(_, container)| container.interfaces.values())
        .flat_map(|interface| &interface.subnets)
        .filter_map(|address| address.ipnet.split('/').next()?.parse().ok())
        .collect();
    let subnets: Vec<&str> = networks
        .iter()
        .flat_map(|network| &network.subnets)
        .map(|subnet| subnet.subnet.as_str())
        .collect();
    // Every chain a network on OpenBot's machine maps to, the shared default network's included,
    // with that network's subnets.
    let mut mapped: HashMap<(&str, &str, String), Vec<&str>> = HashMap::new();
    for network in &networks {
        let own: Vec<&str> = network.subnets.iter().map(|s| s.subnet.as_str()).collect();
        let chain = iptables_chain(&network.name);
        for family in ["ip", "ip6"] {
            mapped
                .entry((family, "nat", chain.clone()))
                .or_default()
                .extend(&own);
        }
        for subnet in &network.subnets {
            mapped
                .entry((
                    "inet",
                    "netavark",
                    nftables_chain(&network.id, &subnet.subnet),
                ))
                .or_default()
                .extend(&own);
        }
    }
    let mut ports: HashSet<u16> = published_ports(published)?;
    ports.extend(own_ports);
    let dead = |address: IpAddr| {
        !running.contains(&address)
            && (subnets.iter().any(|subnet| within(address, subnet))
                || !bridge_up_for(address, routes))
    };

    let mut by_chain: Vec<((String, String, String), Vec<Rule>)> = Vec::new();
    for rule in rules(listing) {
        let Some(to) = rule.to else {
            continue;
        };
        if !forwarding_chain(&rule) {
            continue;
        }
        let key = (
            rule.family.as_str(),
            rule.table.as_str(),
            rule.chain.clone(),
        );
        let made_by_a_network = mapped
            .get(&key)
            .is_some_and(|own| own.iter().any(|subnet| within(to, subnet)));
        if made_by_a_network {
            continue;
        }
        let chain = (rule.family.clone(), rule.table.clone(), rule.chain.clone());
        match by_chain.iter_mut().find(|(seen, _)| *seen == chain) {
            Some((_, rules)) => rules.push(rule),
            None => by_chain.push((chain, vec![rule])),
        }
    }
    Ok(by_chain
        .into_iter()
        .filter(|(_, rules)| {
            rules.iter().all(|rule| {
                dports(&rule.text).is_some_and(|matched| matched.iter().all(|p| ports.contains(p)))
                    && rule.to.is_some_and(dead)
            })
        })
        .flat_map(|(_, rules)| rules)
        .collect())
}

/**
Every port rule of OpenBot's own networks in `listing`, held by a running container or not.

Before OpenBot's machine is removed (`uninstall`): once it is gone none of its containers is left,
and in WSL's shared network namespace each of its rules would outlive it, ahead of the next
OpenBot machine's rules for the same ports. Box I's next install then failed at "Opening OpenBot".
`dead_rules` can't be used there, since the containers may still be running. The same rules are
found, only OpenBot's machine's own networks' DNAT rules, so another machine's and Docker's stay.
*/
pub fn own_rules(listing: &str, networks: &str) -> Result<Vec<Rule>, String> {
    let mut networks: serde_json::Value = serde_json::from_str(networks)
        .map_err(|error| format!("could not read podman network inspect: {error}"))?;
    for network in networks.as_array_mut().into_iter().flatten() {
        // As if nothing ran on it: every address on it is about to be dead.
        network["containers"] = serde_json::json!({});
    }
    dead_rules(listing, &networks.to_string())
}

/// Remove every one of OpenBot's port rules on `machine` (`own_rules`), through `run` as `podman`
/// runs, and say which. For a machine about to be removed.
pub fn clear_own(
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    machine: &str,
) -> Result<Vec<Rule>, String> {
    let said = run(&["machine", "ssh", machine, &read_script()])?;
    let (listing, rest) = said
        .split_once(BETWEEN)
        .ok_or_else(|| format!("the machine did not list its rules and networks: {said}"))?;
    // The routes and the published ports follow the networks (`read_script`); not needed here.
    let (networks, _) = rest.split_once(ROUTES).unwrap_or((rest, ""));
    let own = own_rules(listing, networks)?;
    if !own.is_empty() {
        run(&["machine", "ssh", machine, &delete_script(&own)])?;
    }
    Ok(own)
}

/**
The bug and the fix on real netavark, in WSL as a privileged container on Docker: its network
namespace is the one every distro shares, and OpenBot's machine and the person's are two "distros",
each a mount and PID namespace with a fresh `/run` and its own storage
(`test-fixtures/netavark-rules/wsl-lab.sh`). Stopping one kills its PID namespace, as `wsl
--terminate` does. Each generation of Podman OpenBot's machine may run is reproduced: 5.8.9 with
netavark 1.17.2 and the iptables driver Podman forces on WSL before 6.0, and 6.1.3 with netavark
2.1.0 and nftables, which needs a kernel with nftables' `fib` (Linux runners have it; Docker
Desktop's VM does not, a Podman machine does).

`cargo test --lib netavark_rules::live -- --ignored --test-threads=1`
*/
#[cfg(test)]
mod live {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    const LAB: &str = include_str!("../test-fixtures/netavark-rules/wsl-lab.sh");
    const NGINX: &str = "docker.io/library/nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10";
    /// Docker's own chain, as dockerd writes it with iptables.
    const DOCKER_RULES: &str = "iptables -t nat -N DOCKER && \
        iptables -t nat -A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER && \
        iptables -t nat -A OUTPUT ! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER && \
        iptables -t nat -A DOCKER -i docker0 -j RETURN && \
        iptables -t nat -A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT \
        --to-destination 172.17.0.2:80";

    fn docker(args: &[&str]) -> Result<String, String> {
        let output = Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("docker could not run: {error}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(format!(
                "docker {}: {}{}",
                args.join(" "),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    /// One lab, removed when dropped.
    struct Lab {
        name: String,
    }

    impl Lab {
        fn new(image: &str, driver: &str) -> Lab {
            let lab = Lab {
                name: format!("openbot-netavark-{driver}-{}", std::process::id()),
            };
            let _ = docker(&["rm", "-f", "-v", &lab.name]);
            docker(&[
                "run",
                "-d",
                "--name",
                &lab.name,
                "--privileged",
                "-v",
                "/distros",
                image,
                "sleep",
                "infinity",
            ])
            .unwrap();
            let mut copy = Command::new("docker")
                .args(["exec", "-i", &lab.name, "sh", "-c", "cat > /lab.sh"])
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            copy.stdin
                .take()
                .unwrap()
                .write_all(LAB.as_bytes())
                .unwrap();
            assert!(copy.wait().unwrap().success());
            lab.sh(&["setup", driver]);
            for distro in ["openbot", "person"] {
                lab.sh(&["start", distro]);
                lab.podman(distro, &["pull", "-q", NGINX]);
            }
            lab
        }

        fn sh(&self, args: &[&str]) -> String {
            let mut all = vec!["exec", self.name.as_str(), "sh", "/lab.sh"];
            all.extend_from_slice(args);
            docker(&all).unwrap()
        }

        fn podman(&self, distro: &str, args: &[&str]) -> String {
            let mut all = vec!["podman", distro];
            all.extend_from_slice(args);
            self.sh(&all)
        }

        /// The status a request to `127.0.0.1:port` gets in the namespace, "000" for none in 4s.
        fn curl(&self, port: u16) -> String {
            self.sh(&["curl", &port.to_string(), "4"])
        }

        fn listing(&self) -> String {
            docker(&["exec", &self.name, "nft", "-a", "list", "ruleset"]).unwrap()
        }

        /// `podman machine stop openbot` and `start`, as WSL does them.
        fn restart_openbot(&self) {
            self.sh(&["stop", "openbot"]);
            self.sh(&["start", "openbot"]);
        }

        /// `podman` as OpenBot runs it, reaching OpenBot's machine.
        fn machine(&self, args: &[&str]) -> Result<String, String> {
            match args {
                ["machine", "ssh", "openbot", script] => {
                    docker(&["exec", &self.name, "sh", "/lab.sh", "sh", "openbot", script])
                }
                _ => Err(format!("unexpected args: {args:?}")),
            }
        }
    }

    impl Drop for Lab {
        fn drop(&mut self) {
            let _ = docker(&["rm", "-f", "-v", &self.name]);
        }
    }

    fn keys(rules: &[Rule]) -> Vec<(String, String, String, u64)> {
        rules
            .iter()
            .map(|rule| {
                (
                    rule.family.clone(),
                    rule.table.clone(),
                    rule.chain.clone(),
                    rule.handle,
                )
            })
            .collect()
    }

    fn stale_rules_reproduced_then_cleared(image: &str, driver: &str) {
        let lab = Lab::new(image, driver);
        // OpenBot's first run: its two networks, a container that holds an address and answers
        // nothing ahead of the server, and the server on both, publishing 3010 and 3001 as the
        // stack's does.
        lab.podman("openbot", &["network", "create", "openbot-desktop_default"]);
        lab.podman("openbot", &["network", "create", "openbot-desktop_data"]);
        let both = [
            "--network",
            "openbot-desktop_default",
            "--network",
            "openbot-desktop_data",
        ];
        let filler = [
            &["run", "-d", "--name", "filler"],
            &both[..],
            &[NGINX, "sleep", "infinity"],
        ]
        .concat();
        lab.podman("openbot", &filler);
        let server = [
            &["run", "-d", "--name", "server"],
            &both[..],
            &["-p", "127.0.0.1:3010:80", "-p", "127.0.0.1:3001:80", NGINX],
        ]
        .concat();
        lab.podman("openbot", &server);
        // The person's machine beside it, a network of theirs and their default one, and Docker.
        lab.podman(
            "person",
            &[
                "network",
                "create",
                "--subnet",
                "10.89.5.0/24",
                "--interface-name",
                "person1",
                "myapp_default",
            ],
        );
        lab.podman(
            "person",
            &[
                "run",
                "-d",
                "--name",
                "my-web",
                "--network",
                "myapp_default",
                "-p",
                "127.0.0.1:8081:80",
                NGINX,
            ],
        );
        lab.podman(
            "person",
            &[
                "run",
                "-d",
                "--name",
                "my-default-web",
                "--network",
                "podman",
                "-p",
                "127.0.0.1:8082:80",
                NGINX,
            ],
        );
        docker(&["exec", &lab.name, "sh", "-c", DOCKER_RULES]).unwrap();
        assert_eq!(lab.curl(3010), "200");
        assert_eq!(lab.curl(8081), "200");

        // The bug: the machine stopped and started, and the server back on new addresses behind
        // its old rules.
        lab.restart_openbot();
        lab.podman("openbot", &["start", "server"]);
        assert_eq!(lab.curl(3010), "000", "the old rules are ahead");
        assert_eq!(lab.curl(3001), "000", "the old rules are ahead");

        let before = rules(&lab.listing());
        let cleared = clear_dead(|args| lab.machine(args), "openbot").unwrap();
        assert_eq!(
            cleared.len(),
            4,
            "3010 and 3001 on both networks: {cleared:#?}"
        );
        assert_eq!(lab.curl(3010), "200");
        assert_eq!(lab.curl(3001), "200");
        assert_eq!(lab.curl(8081), "200");
        // Nothing else: the person's rules, their default network's and Docker's are all listed.
        let left: Vec<Rule> = before
            .iter()
            .filter(|rule| !keys(&cleared).contains(&keys(std::slice::from_ref(rule))[0]))
            .cloned()
            .collect();
        assert_eq!(keys(&rules(&lab.listing())), keys(&left));
        let listing = lab.listing();
        for kept in ["to 10.89.5.2:80", "to 10.88.0.2:80", "to 172.17.0.2:80"] {
            assert!(listing.contains(kept), "{kept}: {listing}");
        }

        // As Start runs now: the machine started, its dead rules gone, then its containers. The
        // filler takes the server's last address, where its old rules would send 3010.
        lab.restart_openbot();
        let cleared = clear_dead(|args| lab.machine(args), "openbot").unwrap();
        assert_eq!(cleared.len(), 4, "nothing of OpenBot's runs: {cleared:#?}");
        lab.podman("openbot", &["start", "filler"]);
        lab.podman("openbot", &["start", "server"]);
        assert_eq!(lab.curl(3010), "200");
        assert_eq!(lab.curl(3001), "200");
        assert_eq!(lab.curl(8081), "200");
    }

    #[test]
    #[ignore = "runs a privileged Podman 5.8.9 lab on Docker"]
    fn podman_5_8_9_iptables() {
        stale_rules_reproduced_then_cleared(
            "quay.io/podman/stable:v5.8.9@sha256:f7a17ef911a2b9b866ada8a9426a07e29a6e4f8109ef8c0e0b7010c2541b4e49",
            "iptables",
        );
    }

    #[test]
    #[ignore = "runs a privileged Podman 6.1.3 lab on Docker, on a kernel with nftables fib"]
    fn podman_6_1_3_nftables() {
        stale_rules_reproduced_then_cleared(
            "quay.io/podman/stable:v6.1.3@sha256:4cc31850c189386faca95d72988fe9573b3df06360cb65aea3ff5b17a04d0454",
            "nftables",
        );
    }
}
