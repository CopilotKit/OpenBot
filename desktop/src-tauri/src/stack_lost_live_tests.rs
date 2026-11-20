/*!
A backend whose node a prune of stopped containers removed, on a real engine.

A Mac on Docker Desktop, Desktop 1.1.2: the backend's k3d node was stopped while OpenBot was closed,
`docker container prune` removed it, and from then on every `local status`, `local stop` and Retry
failed at the CLI's ownership check (`GET /containers/k3d-<stack>-server-0/json`, 404). OpenBot only
looked for a lost cluster in its own Podman machine, so on Docker the window said "Setup stopped
partway through with an error. Retry." for good, and Quit failed the same way.

`engine` runs on the runner's Docker: a node shaped like the one k3d makes, with the network and
image volume k3d makes beside it, stopped and pruned. `recovery` is the whole thing with the real
CLI, signed in, on a computer that can run a backend: run with
`cargo test --lib local_eval::stack_lost_live::recovery -- --ignored --nocapture` and the developer
CLI named (`OPENBOT_DEV_LOCAL_EVAL_PROGRAM` and its digest, and `..._ENTRY` with its digest).
*/

use super::*;
use std::process::{Command, Stdio};

fn docker(args: &[&str]) -> (bool, String) {
    let output = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("docker should run");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr),
    )
}

const NGINX: &str = "docker.io/library/nginx:1.31.6-alpine";

/// A stack id in the CLI's shape: `local-` and 24 hex digits.
fn stack_for_test() -> StackId {
    let id = format!("local-{:024x}", rand::random::<u128>() >> 32);
    StackId::parse(&id).unwrap()
}

/// What k3d leaves of `stack`'s cluster and its own leftovers, removed when dropped.
struct Node {
    stack: StackId,
}

impl Node {
    /// The node, its network and its image volume, named and labelled as k3d and the CLI name them.
    fn new(stack: &StackId) -> Self {
        let id = stack.as_str();
        let node = Self {
            stack: stack.clone(),
        };
        let network = format!("k3d-{id}");
        let volume = format!("k3d-{id}-images");
        let label = format!("copilotkit.local-stack={id}");
        assert!(docker(&["network", "create", &network]).0);
        assert!(docker(&["volume", "create", &volume]).0);
        let mount = format!("{volume}:/k3d/images");
        let (started, said) = docker(&[
            "run",
            "-d",
            "--name",
            &format!("k3d-{id}-server-0"),
            "--label",
            &label,
            "--label",
            &format!("k3d.cluster={id}"),
            "--network",
            &network,
            "--volume",
            &mount,
            NGINX,
        ]);
        assert!(started, "the node should start: {said}");
        // k3d's tools container, which outlived the node on the cloud Mac: a prune of stopped
        // containers leaves it, since it is still running.
        let (tools, said) = docker(&[
            "run",
            "-d",
            "--name",
            &format!("k3d-{id}-tools"),
            "--label",
            &format!("k3d.cluster={id}"),
            "--network",
            &network,
            NGINX,
        ]);
        assert!(tools, "the tools container should start: {said}");
        node
    }

    /// Stopped, as when OpenBot was closed, then removed as `docker container prune` removes every
    /// stopped container. Filtered to this node's label, so nothing else on the engine goes.
    fn stop_and_prune(&self) {
        let id = self.stack.as_str();
        assert!(docker(&["stop", &format!("k3d-{id}-server-0")]).0);
        let label = format!("label=copilotkit.local-stack={id}");
        let (pruned, said) = docker(&["container", "prune", "--force", "--filter", &label]);
        assert!(pruned, "{said}");
        assert!(said.contains(&format!("k3d-{id}-server-0")) || said.contains("Total"));
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        let id = self.stack.as_str();
        let _ = docker(&["rm", "-f", "-v", &format!("k3d-{id}-server-0")]);
        let _ = docker(&["rm", "-f", "-v", &format!("k3d-{id}-tools")]);
        let _ = docker(&["network", "rm", &format!("k3d-{id}")]);
        let _ = docker(&["volume", "rm", &format!("k3d-{id}-images")]);
    }
}

/// Docker is OpenBot's engine, as on the Mac it was found on, so the CLI and these checks are told
/// the same engine (`use_engine`).
fn on_docker() {
    use_engine(&crate::engine::Address::new(
        crate::engine::Engine::Docker,
        None,
    ));
}

/**
The node is there, then a prune removes it: `cluster_gone`, which the window's offer to set the
backend up again and Quit's stop both rest on, says it is gone, and `cluster_removed`, which lets
setup forget a stack that can't be resumed, says so too, from the network and image volume k3d
left. Before the fix, Docker was never asked, and neither said anything.
*/
#[test]
#[ignore = "creates and prunes a container, a network and a volume on the runner's Docker"]
fn engine_a_node_pruned_while_stopped_is_found_gone() {
    on_docker();
    let stack = stack_for_test();
    let node = Node::new(&stack);
    assert_eq!(cluster_gone(&stack), Some(false));
    assert_eq!(cluster_removed(&stack), Some(false));

    node.stop_and_prune();
    let (inspected, said) = docker(&[
        "container",
        "inspect",
        &format!("k3d-{}-server-0", stack.as_str()),
    ]);
    assert!(!inspected, "the prune removed the node: {said}");
    assert_eq!(cluster_gone(&stack), Some(true));
    assert_eq!(cluster_removed(&stack), Some(true));

    // k3d's tools container, still running, would make `k3d cluster create` refuse: it is cleared,
    // and the network and image volume, which setup reuses, stay.
    let tools = format!("k3d-{}-tools", stack.as_str());
    assert!(docker(&["container", "inspect", &tools]).0);
    clear_leftovers_of_gone(&stack);
    assert!(!docker(&["container", "inspect", &tools]).0);
    assert_eq!(cluster_removed(&stack), Some(true));

    // An engine with no trace of the stack at all may not be the one it lives in: the offer still
    // stands, but setup never deletes the stack on that alone.
    drop(node);
    assert_eq!(cluster_gone(&stack), Some(true));
    assert_eq!(cluster_removed(&stack), Some(false));
}

/// Another stack's node, still there, says nothing about this one, and this one's is not found
/// in its name.
#[test]
#[ignore = "creates a container, a network and a volume on the runner's Docker"]
fn engine_another_stacks_node_is_not_this_ones() {
    on_docker();
    let other = stack_for_test();
    let _node = Node::new(&other);
    let stack = stack_for_test();
    assert_eq!(cluster_gone(&other), Some(false));
    assert_eq!(cluster_gone(&stack), Some(true));
    assert_eq!(cluster_removed(&stack), Some(false));
}

/// What a `local` call answered, for the test's output.
fn said(report: &Report) -> String {
    format!(
        "{:?} {:?} stack={:?} readiness={:?}",
        report.outcome,
        report.reason,
        report.stack.as_ref().map(|stack| stack.id.as_str()),
        report.readiness
    )
}

/**
The whole recovery with the real CLI, signed in: set a backend up, stop it as Quit does, prune its
node as `docker container prune` does, then see what OpenBot sees. Status and stop fail with no
stack, the engine the CLI runs on has no node, and setting it up again makes the cluster again for
the same stack, which comes up ready with the licence and keys it had.
*/
#[test]
#[ignore = "sets a real backend up with the developer CLI, signed in, on this computer's Docker"]
fn recovery_a_pruned_backend_is_found_gone_and_set_up_again() {
    on_docker();
    let folder = std::env::temp_dir().join(format!("openbot-stack-lost-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let accepted = match terms_installed("stack-lost-live").expect("the agreement") {
        Terms::Required { version, .. } => Some(EulaVersion::parse(&version).unwrap()),
        Terms::NotRequired => None,
        other => panic!("sign the developer CLI in first: {other:?}"),
    };

    let (first, _) = setup_installed("stack-lost-live", &folder, accepted.as_ref())
        .expect("the first setup should run");
    println!("first setup: {}", said(&first));
    assert_eq!(first.outcome, Outcome::Completed);
    let stack = StackId::parse(&first.stack.as_ref().expect("a stack").id).unwrap();
    let id = stack.as_str().to_owned();
    let status = run_installed("stack-lost-live", Action::Status, &stack).unwrap();
    println!("status: {}", said(&status));
    assert_eq!(status.readiness, Readiness::Ready);
    let secrets = |stack: &StackId| {
        std::fs::read(
            crate::local_update::stack_dir(stack.as_str())
                .unwrap()
                .join("secrets.json"),
        )
        .unwrap()
    };
    let keys = secrets(&stack);

    // Quit stops it; later, a prune of stopped containers removes its node.
    let stopped = run_installed("stack-lost-live", Action::Stop, &stack).unwrap();
    assert_eq!(stopped.outcome, Outcome::Completed, "{}", said(&stopped));
    let (pruned, pruned_said) = docker(&[
        "container",
        "prune",
        "--force",
        "--filter",
        &format!("label=copilotkit.local-stack={id}"),
    ]);
    assert!(pruned, "{pruned_said}");
    println!("pruned: {pruned_said}");

    // What the dogfooding Mac's log said: status and stop both fail with no stack.
    for action in [Action::Status, Action::Stop] {
        let report = run_installed("stack-lost-live", action, &stack).unwrap();
        println!("{action:?} after the prune: {}", said(&report));
        assert_eq!(report.outcome, Outcome::Failed);
        assert!(failed_without_stack(&report));
    }
    // What OpenBot now sees: the node is gone from the engine the CLI runs on, and it was removed
    // from this engine, not left in another one.
    assert_eq!(cluster_gone(&stack), Some(true));
    assert_eq!(cluster_removed(&stack), Some(true));

    // Set up again: the same stack, with its own licence and keys, comes up ready.
    let (again, _) = setup_installed("stack-lost-live", &folder, accepted.as_ref())
        .expect("setting up again should run");
    println!("set up again: {}", said(&again));
    assert_eq!(again.outcome, Outcome::Completed);
    assert_eq!(
        again.stack.as_ref().map(|stack| stack.id.as_str()),
        Some(id.as_str())
    );
    let status = run_installed("stack-lost-live", Action::Status, &stack).unwrap();
    println!("status after: {}", said(&status));
    assert_eq!(status.readiness, Readiness::Ready);
    assert_eq!(cluster_gone(&stack), Some(false));
    assert_eq!(secrets(&stack), keys, "the stack keeps its keys");

    delete_installed(&stack).expect("the test's stack is deleted");
    let _ = std::fs::remove_dir_all(&folder);
}
