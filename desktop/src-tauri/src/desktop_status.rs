//! What the Status window says about what OpenBot is running, and how much memory it takes.
//!
//! OpenBot's containers are the ones that carry this installation's Compose project label, its Bots'
//! computers among them (see `stack::running_containers_of`), and k3d names an Intelligence stack's
//! `k3d-<stack id>-<role>`. Not every `openbot-` container: another project, or a source checkout
//! called `openbot`, names its own that way. Memory is Docker's own figure for each container,
//! OpenBot's own server and worker among them, so the total is what the machine is actually spending.

use serde::Serialize;

/// One container or process and its memory, as the window lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub name: String,
    pub memory_bytes: Option<u64>,
}

/// Docker's `MemUsage` column ("123.4MiB / 7.66GiB"): the used half, in bytes.
pub fn memory_in_use(column: &str) -> Option<u64> {
    let used = column.split('/').next()?.trim();
    let split = used.find(|c: char| c.is_ascii_alphabetic())?;
    let (number, unit) = used.split_at(split);
    let number: f64 = number.trim().parse().ok()?;
    let scale: f64 = match unit.trim() {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        _ => return None,
    };
    (number.is_finite() && number >= 0.0).then(|| (number * scale).round() as u64)
}

/// `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'`, split into OpenBot's containers,
/// the ones named in `owned`, and those of the Intelligence stack `stack`. Anybody else's containers
/// are left out.
pub fn containers(stats: &str, owned: &[String], stack: Option<&str>) -> (Vec<Part>, Vec<Part>) {
    let mut openbot = Vec::new();
    let mut intelligence = Vec::new();
    let intelligence_prefix = stack.map(|stack| format!("k3d-{stack}-"));
    for line in stats.lines() {
        let Some((name, usage)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim().trim_start_matches('/');
        let part = Part {
            name: name.to_owned(),
            memory_bytes: memory_in_use(usage),
        };
        if owned.iter().any(|own| own == name) {
            openbot.push(part);
        } else if intelligence_prefix
            .as_deref()
            .is_some_and(|prefix| name.starts_with(prefix))
        {
            intelligence.push(part);
        }
    }
    (openbot, intelligence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_memory_reads_the_used_half_in_either_unit_family() {
        assert_eq!(memory_in_use("1.5GiB / 7.66GiB"), Some(1_610_612_736));
        assert_eq!(memory_in_use("123.4MiB / 7.66GiB"), Some(129_394_278));
        assert_eq!(memory_in_use("512KiB / 1GiB"), Some(524_288));
        assert_eq!(memory_in_use("0B / 0B"), Some(0));
        assert_eq!(memory_in_use("2.5MB / 1GB"), Some(2_500_000));
        assert_eq!(memory_in_use("--"), None);
        assert_eq!(memory_in_use(""), None);
    }

    #[test]
    fn containers_are_openbots_or_the_stacks_and_nobody_elses() {
        let stats = "openbot-postgres-1\t100MiB / 8GiB\n\
                     k3d-local-abc-server-0\t1GiB / 8GiB\n\
                     k3d-local-other-server-0\t2GiB / 8GiB\n\
                     buildx_buildkit_x\t50MiB / 8GiB\n\
                     /openbot-supervisor-1\t--\n";
        let legacy = [
            "openbot-postgres-1".to_owned(),
            "openbot-supervisor-1".to_owned(),
        ];
        let (openbot, intelligence) = containers(stats, &legacy, Some("local-abc"));
        assert_eq!(
            openbot,
            vec![
                Part {
                    name: "openbot-postgres-1".into(),
                    memory_bytes: Some(104_857_600)
                },
                Part {
                    name: "openbot-supervisor-1".into(),
                    memory_bytes: None
                },
            ]
        );
        assert_eq!(
            intelligence,
            vec![Part {
                name: "k3d-local-abc-server-0".into(),
                memory_bytes: Some(1_073_741_824)
            }]
        );
        assert!(containers(stats, &legacy, None).1.is_empty());
    }

    /// Another project's containers can share the `openbot-` prefix; only the ones named as this
    /// installation's own are listed.
    #[test]
    fn containers_named_like_openbots_but_not_its_own_are_left_out() {
        let stats = "openbot-postgres-1\t1GiB / 8GiB\n\
                     openbot-kite-demo-postgres-1\t1GiB / 8GiB\n\
                     openbot-computer-person-me\t200MiB / 8GiB\n";
        let owned = [
            "openbot-postgres-1".to_owned(),
            "openbot-computer-person-me".to_owned(),
        ];
        let names: Vec<String> = containers(stats, &owned, None)
            .0
            .into_iter()
            .map(|part| part.name)
            .collect();
        assert_eq!(names, ["openbot-postgres-1", "openbot-computer-person-me"]);
    }

    #[test]
    fn the_quick_listing_names_containers_without_measuring_them() {
        let listing = "openbot-postgres-1\t\nk3d-local-abc-server-0\t\n";
        let (openbot, intelligence) = containers(
            listing,
            &["openbot-postgres-1".to_owned()],
            Some("local-abc"),
        );
        assert_eq!(
            openbot,
            vec![Part {
                name: "openbot-postgres-1".into(),
                memory_bytes: None
            }]
        );
        assert_eq!(intelligence[0].memory_bytes, None);
    }
}
