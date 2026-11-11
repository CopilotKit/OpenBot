use super::*;
use crate::test_support::temp_root;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};

/// One request as the server saw it.
#[derive(Clone, Debug)]
pub(crate) struct Seen {
    pub(crate) path: String,
    pub(crate) range: Option<String>,
    authorization: Option<String>,
}

/// What the server answers a request with.
pub(crate) enum Reply {
    /// `status`, these headers, then `body`. With `cut`, only that many bytes of the body are sent
    /// before the connection closes, under a `Content-Length` for the whole of it.
    Send {
        status: &'static str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        cut: Option<usize>,
    },
}

/// A loopback HTTP/1.1 server that answers each request with `answer`, and keeps what it was asked.
pub(crate) struct Server {
    address: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    body_bytes: Arc<AtomicUsize>,
    /// Loopback ports are shared with the port tests: held while this server listens.
    _ports: MutexGuard<'static, ()>,
}

impl Server {
    pub(crate) fn start(answer: impl Fn(&Seen, usize) -> Reply + Send + Sync + 'static) -> Self {
        let ports = crate::test_support::hold_ports();
        let listener = below_the_ephemeral_ports();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let body_bytes = Arc::new(AtomicUsize::new(0));
        let answer = Arc::new(answer);
        {
            let (seen, body_bytes) = (seen.clone(), body_bytes.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let (seen, body_bytes, answer) =
                        (seen.clone(), body_bytes.clone(), answer.clone());
                    std::thread::spawn(move || serve(stream, &seen, &body_bytes, &*answer));
                }
            });
        }
        Self {
            address,
            seen,
            body_bytes,
            _ports: ports,
        }
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.address)
    }

    pub(crate) fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Body bytes sent, over every answer.
    pub(crate) fn sent(&self) -> usize {
        self.body_bytes.load(Ordering::SeqCst)
    }
}

/**
A listener on a port below the range the system hands out for port 0.

This server closes each connection first, so each one leaves its port in TIME_WAIT for a while after
the test. On a port the system hands out, that broke `env`'s port tests, which bind port 0 and then
probe the port they got without SO_REUSEADDR: the probe found it taken. Below that range, nothing
asks the system for it.
*/
fn below_the_ephemeral_ports() -> TcpListener {
    let start = 20_000 + (std::process::id() % 8_000) as u16;
    (0..2_000u16)
        .map(|step| 20_000 + (start - 20_000 + step * 7) % 10_000)
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .expect("a free port from 20000 to 29999")
}

fn serve(
    stream: TcpStream,
    seen: &Mutex<Vec<Seen>>,
    body_bytes: &AtomicUsize,
    answer: &(dyn Fn(&Seen, usize) -> Reply + Send + Sync),
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() || first.is_empty() {
        return;
    }
    let path = first
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let (mut range, mut authorization) = (None, None);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "range" => range = Some(value.trim().to_string()),
                "authorization" => authorization = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    let request = Seen {
        path,
        range,
        authorization,
    };
    let index = {
        let mut seen = seen.lock().unwrap();
        seen.push(request.clone());
        seen.len() - 1
    };
    let Reply::Send {
        status,
        headers,
        body,
        cut,
    } = answer(&request, index);
    let mut stream = stream;
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let sent = cut.unwrap_or(body.len()).min(body.len());
    let _ = stream.write_all(&body[..sent]);
    body_bytes.fetch_add(sent, Ordering::SeqCst);
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// `body` from the start, or from where a `Range: bytes=N-` asks, as a server that resumes does.
pub(crate) fn ranged(request: &Seen, body: &[u8]) -> Reply {
    match request
        .range
        .as_deref()
        .and_then(|range| range.strip_prefix("bytes="))
        .and_then(|range| range.strip_suffix('-'))
        .and_then(|from| from.parse::<usize>().ok())
    {
        Some(from) if from < body.len() => Reply::Send {
            status: "206 Partial Content",
            headers: vec![(
                "Content-Range".into(),
                format!("bytes {from}-{}/{}", body.len() - 1, body.len()),
            )],
            body: body[from..].to_vec(),
            cut: None,
        },
        Some(_) => Reply::Send {
            status: "416 Range Not Satisfiable",
            headers: vec![],
            body: vec![],
            cut: None,
        },
        None => whole(body, None),
    }
}

pub(crate) fn whole(body: &[u8], cut: Option<usize>) -> Reply {
    Reply::Send {
        status: "200 OK",
        headers: vec![],
        body: body.to_vec(),
        cut,
    }
}

fn refused(status: &'static str) -> Reply {
    Reply::Send {
        status,
        headers: vec![],
        body: vec![],
        cut: None,
    }
}

/// A file of `size` bytes that is not all one byte, and the pin for it.
pub(crate) fn file(size: usize) -> (Vec<u8>, String) {
    let body: Vec<u8> = (0..size).map(|n| (n * 7 % 251) as u8).collect();
    let sha = hex(&Sha256::digest(&body));
    (body, sha)
}

fn pinned(name: &str, sha256: &str, size: usize, sources: Vec<String>) -> Pinned {
    Pinned {
        name: name.into(),
        sha256: sha256.into(),
        size: Some(size as u64),
        sources,
    }
}

const NO_WAIT: [Duration; 0] = [];

/// The table is one per process. Tests that read it run one at a time, each from an empty one.
fn table_to_myself() -> MutexGuard<'static, ()> {
    static TABLE_TEST: Mutex<()> = Mutex::new(());
    let held = TABLE_TEST.lock().unwrap_or_else(|held| held.into_inner());
    *table() = Table::default();
    held
}

/// The app was quit part-way through a download. The next launch asks only for the rest, carries
/// on hashing from the bytes already there, and keeps the file only once it is the pinned one.
#[test]
fn a_download_stopped_part_way_carries_on_from_the_bytes_already_there() {
    let (body, sha) = file(300_000);
    let served = body.clone();
    let server = Server::start(move |request, index| match index {
        // The first launch: the connection drops two fifths of the way through.
        0 => whole(&served, Some(120_000)),
        _ => ranged(request, &served),
    });
    let cache = temp_root("early-resume");
    let pin = pinned("disk.raw.zst", &sha, body.len(), vec![server.url("/disk")]);

    fetch_waiting(&pin, &cache, &(), &NO_WAIT).expect_err("the first download was cut off");
    assert!(
        !cache.join("disk.raw.zst").exists(),
        "an unfinished file is never kept"
    );
    assert_eq!(
        std::fs::metadata(partial_path(&cache, "disk.raw.zst"))
            .unwrap()
            .len(),
        120_000
    );

    // The next launch.
    let path = fetch_waiting(&pin, &cache, &(), &NO_WAIT).expect("the rest of the download");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert_eq!(file_sha256(&path).unwrap(), sha);
    assert!(!partial_path(&cache, "disk.raw.zst").exists());
    let seen = server.seen();
    assert_eq!(seen[1].range.as_deref(), Some("bytes=120000-"), "{seen:?}");
    // Nothing was downloaded twice.
    assert_eq!(server.sent(), body.len());
    let _ = std::fs::remove_dir_all(&cache);
}

/// A server that answers a range with the whole file starts the download again from nothing,
/// rather than appending the whole file to the part already there.
#[test]
fn a_server_that_sends_the_whole_file_again_starts_the_download_again() {
    let (body, sha) = file(200_000);
    let served = body.clone();
    let server = Server::start(move |_, _| whole(&served, None));
    let cache = temp_root("early-whole-again");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(partial_path(&cache, "f"), &body[..50_000]).unwrap();

    let path = fetch_waiting(
        &pinned("f", &sha, body.len(), vec![server.url("/f")]),
        &cache,
        &(),
        &NO_WAIT,
    )
    .expect("the whole file");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert_eq!(server.seen()[0].range.as_deref(), Some("bytes=50000-"));
    let _ = std::fs::remove_dir_all(&cache);
}

/// The part already there was not the start of the file (a disk error, another file). The digest
/// check at the end refuses it, nothing is kept under the file's name, and the next try downloads
/// the whole file.
#[test]
fn a_partial_download_that_is_not_the_file_is_refused_then_downloaded_whole() {
    let (body, sha) = file(200_000);
    let served = body.clone();
    let server = Server::start(move |request, _| ranged(request, &served));
    let cache = temp_root("early-wrong-partial");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(partial_path(&cache, "f"), vec![0u8; 80_000]).unwrap();
    let pin = pinned("f", &sha, body.len(), vec![server.url("/f")]);

    let refused = fetch_waiting(&pin, &cache, &(), &NO_WAIT).expect_err("a wrong file");
    assert!(
        refused.contains("is not what OpenBot expected"),
        "{refused}"
    );
    assert!(!cache.join("f").exists());

    let path = fetch_waiting(&pin, &cache, &(), &NO_WAIT).expect("the file, downloaded whole");
    assert_eq!(file_sha256(&path).unwrap(), sha);
    let seen = server.seen();
    assert_eq!(seen[0].range.as_deref(), Some("bytes=80000-"));
    assert_eq!(seen[1].range, None, "{seen:?}");
    let _ = std::fs::remove_dir_all(&cache);
}

/// A file already there with its pinned digest is used as it is: no request at all.
#[test]
fn a_file_already_downloaded_is_not_downloaded_again() {
    let (body, sha) = file(10_000);
    let server = Server::start(|_, _| refused("500 Internal Server Error"));
    let cache = temp_root("early-already");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("f"), &body).unwrap();
    fetch_waiting(
        &pinned("f", &sha, body.len(), vec![server.url("/f")]),
        &cache,
        &(),
        &NO_WAIT,
    )
    .expect("the file already here");
    assert!(server.seen().is_empty());
    let _ = std::fs::remove_dir_all(&cache);
}

/// downloads.copilotkit.ai first, once; the file's own source when the copy is not there.
#[test]
fn the_mirror_is_asked_first_and_the_source_after_it() {
    let (body, sha) = file(20_000);
    let served = body.clone();
    let server = Server::start(move |request, _| {
        if request.path.starts_with("/mirror/") {
            refused("403 Forbidden")
        } else {
            whole(&served, None)
        }
    });
    let cache = temp_root("early-mirror");
    fetch_waiting(
        &pinned(
            "f",
            &sha,
            body.len(),
            vec![server.url("/mirror/f"), server.url("/source/f")],
        ),
        &cache,
        &(),
        &NO_WAIT,
    )
    .expect("the file from its source");
    let paths: Vec<String> = server.seen().into_iter().map(|seen| seen.path).collect();
    assert_eq!(paths, ["/mirror/f", "/source/f"]);
    let _ = std::fs::remove_dir_all(&cache);
}

/// quay.io answers an anonymous blob download with the token to ask for, as every registry does.
#[test]
fn a_registry_that_asks_for_a_token_is_given_an_anonymous_one() {
    let (body, sha) = file(20_000);
    let served = body.clone();
    let realm = Arc::new(Mutex::new(String::new()));
    let server = {
        let realm = realm.clone();
        Server::start(move |request, _| {
            if request.path.starts_with("/token") {
                return Reply::Send {
                    status: "200 OK",
                    headers: vec![("Content-Type".into(), "application/json".into())],
                    body: br#"{"token":"anonymous-token"}"#.to_vec(),
                    cut: None,
                };
            }
            if request.authorization.as_deref() != Some("Bearer anonymous-token") {
                return Reply::Send {
                    status: "401 Unauthorized",
                    headers: vec![(
                        "WWW-Authenticate".into(),
                        format!(
                            r#"Bearer realm="{}/token",service="quay.io",scope="repository:podman/machine-os:pull""#,
                            realm.lock().unwrap()
                        ),
                    )],
                    body: vec![],
                    cut: None,
                };
            }
            whole(&served, None)
        })
    };
    *realm.lock().unwrap() = server.address.clone();
    let cache = temp_root("early-token");
    fetch_waiting(
        &pinned(
            "f",
            &sha,
            body.len(),
            vec![server.url("/v2/podman/machine-os/blobs/sha256:x")],
        ),
        &cache,
        &(),
        &NO_WAIT,
    )
    .expect("the blob, with the token");
    let seen = server.seen();
    assert!(seen
        .iter()
        .any(|seen| seen.path.starts_with("/token?") && seen.path.contains("scope=repository")));
    let _ = std::fs::remove_dir_all(&cache);
}

/// Install asks for a file the first screen is already downloading. It waits for that download
/// and uses it: the file is downloaded once.
#[test]
fn two_asks_for_one_file_download_it_once() {
    let (body, sha) = file(400_000);
    let served = body.clone();
    let server = Server::start(move |_, _| {
        std::thread::sleep(Duration::from_millis(300));
        whole(&served, None)
    });
    let cache = temp_root("early-once");
    let pin = pinned("f", &sha, body.len(), vec![server.url("/f")]);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| fetch_waiting(&pin, &cache, &(), &NO_WAIT));
        let second = scope.spawn(|| fetch_waiting(&pin, &cache, &(), &NO_WAIT));
        first.join().unwrap().expect("the first ask");
        second.join().unwrap().expect("the second ask");
    });
    assert_eq!(server.seen().len(), 1);
    let _ = std::fs::remove_dir_all(&cache);
}

/// With less free disk than the back end and the downloads need, nothing downloads: the window
/// is told how much is free and how much is needed. Once there is room, the downloads start.
#[test]
fn with_too_little_free_disk_nothing_downloads_until_there_is_room() {
    let _table = table_to_myself();
    let (body, sha) = file(50_000);
    let served = body.clone();
    let server = Server::start(move |_, _| whole(&served, None));
    let cache = temp_root("early-disk");
    let looks = AtomicUsize::new(0);
    let said = Mutex::new(Vec::<Summary>::new());
    let needed = needed_for(&Plan {
        machine_image: machine_image_for("macos", "aarch64"),
        deployment: true,
        ..Plan::default()
    });
    // 40 GiB for the back end, and the machine image.
    assert_eq!(needed, 40 * 1024 * 1024 * 1024 + 937_318_069);
    run(
        vec![Job::file(
            "machine-image",
            pinned("f", &sha, body.len(), vec![server.url("/f")]),
            cache.clone(),
        )],
        needed,
        || {
            // Nothing is asked of the server while the disk is short.
            assert!(server.seen().is_empty());
            let look = looks.fetch_add(1, Ordering::SeqCst);
            Some(if look < 2 { 12_000_000_000 } else { needed })
        },
        &|summary| said.lock().unwrap().push(summary),
        Duration::ZERO,
    );
    let said = said.into_inner().unwrap();
    assert_eq!(
        said[0],
        Summary {
            state: State::Short,
            free: Some(12_000_000_000),
            needed: Some(needed),
            ..Summary::default()
        }
    );
    let last = said.last().unwrap();
    assert_eq!(last.state, State::Done, "{said:?}");
    assert_eq!(last.bytes, body.len() as u64);
    assert_eq!(last.size, Some(body.len() as u64));
    assert_eq!(file_sha256(&cache.join("f")).unwrap(), sha);
    let _ = std::fs::remove_dir_all(&cache);
}

/// The free space this computer reports for a real folder, as `df` would: some, and not more than
/// the disk holds.
#[test]
fn free_space_is_read_from_the_disk_that_holds_the_folder() {
    let folder = temp_root("early-free").join("not-yet").join("made");
    let free = free_space(&folder).expect("the free space of the nearest folder that exists");
    assert!(free > 0);
}

/// A download that fails is said as failed, and the others still finish.
#[test]
fn a_download_that_fails_is_said_and_the_others_finish() {
    let _table = table_to_myself();
    let (body, sha) = file(30_000);
    let served = body.clone();
    let server = Server::start(move |request, _| {
        if request.path == "/missing" {
            refused("404 Not Found")
        } else {
            whole(&served, None)
        }
    });
    let cache = temp_root("early-fails");
    let said = Mutex::new(Vec::<Summary>::new());
    run(
        vec![
            Job::file(
                "podman",
                pinned("missing", &sha, body.len(), vec![server.url("/missing")]),
                cache.clone(),
            ),
            Job::file(
                "compose",
                pinned("there", &sha, body.len(), vec![server.url("/there")]),
                cache.clone(),
            ),
        ],
        0,
        || None,
        &|summary| said.lock().unwrap().push(summary),
        Duration::ZERO,
    );
    assert_eq!(
        said.into_inner().unwrap().last().unwrap().state,
        State::Failed
    );
    assert!(cache.join("there").is_file());
    let _ = std::fs::remove_dir_all(&cache);
}

/// Install's machine step waits for the machine image the first screen started, saying how far it
/// is on its own row, and gets the verified file to build the machine from.
#[test]
fn the_machine_step_waits_for_the_image_and_gets_the_verified_file() {
    let _table = table_to_myself();
    let (body, sha) = file(600_000);
    let served = body.clone();
    let server = Server::start(move |request, _| {
        std::thread::sleep(Duration::from_millis(400));
        ranged(request, &served)
    });
    let cache = temp_root("early-machine");
    let pin = pinned(
        "podman-machine.aarch64.applehv.raw.zst",
        &sha,
        body.len(),
        vec![server.url("/blob")],
    );
    let rows = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        // The first screen's download, already running.
        let early = scope.spawn(|| fetch(&pin, &cache, &Tracked("machine-image")));
        std::thread::sleep(Duration::from_millis(100));
        let path = machine_image_waiting(&pin, &cache, |downloads| {
            rows.lock().unwrap().push(downloads)
        })
        .expect("the machine image");
        assert_eq!(file_sha256(&path).unwrap(), sha);
        assert_eq!(path, cache.join("podman-machine.aarch64.applehv.raw.zst"));
        early.join().unwrap().expect("the early download");
    });
    let rows = rows.into_inner().unwrap();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|row| row.size == Some(body.len() as u64)));
    assert_eq!(server.seen().len(), 1, "downloaded once");
    let _ = std::fs::remove_dir_all(&cache);
}

/// What each kind of computer downloads before Install is clicked.
#[test]
fn what_downloads_early_depends_on_the_engine_install_will_use() {
    use crate::install::Choice;
    let mac = machine_image_for("macos", "aarch64");
    let docker = Address::new(Engine::Docker, None);
    let facts =
        |os, choice, podman: Option<&str>, machine_exists, answering: Option<&Address>| Facts {
            os,
            choice,
            podman_version: podman.map(str::to_string),
            machine_exists,
            answering: answering.cloned(),
            installed_before: false,
            machine_image: if os == "macos" { mac } else { None },
        };
    // A new Mac with no engine: everything Install will need, OpenBot's images included, named by
    // the Compose OpenBot downloads, to load once the engine answers.
    assert_eq!(
        plan(&facts("macos", Choice::InstallPodman, None, false, None)),
        Plan {
            machine_image: mac,
            podman: true,
            compose: true,
            deployment: true,
            images: None,
            offline_images: true,
        }
    );
    // Docker Desktop answering: the images go straight into it, and no engine is downloaded. Their
    // list comes from OpenBot's own Compose, which an old Docker Desktop's may not read.
    assert_eq!(
        plan(&facts(
            "macos",
            Choice::UseDocker,
            None,
            false,
            Some(&docker)
        )),
        Plan {
            compose: true,
            deployment: true,
            images: Some(docker.clone()),
            ..Plan::default()
        }
    );
    // Windows D: a person's Podman answering with no Compose installed. OpenBot's own Compose
    // downloads too, to name the images, since `podman compose` has no provider to run.
    let podman = Address::new(Engine::Podman, Some("podman-machine-default".into()));
    let answering = plan(&facts(
        "windows",
        Choice::UsePodman,
        Some("podman version 6.1.1"),
        false,
        Some(&podman),
    ));
    assert!(answering.compose, "{answering:?}");
    assert_eq!(answering.images, Some(podman));
    // Podman 6.1 is here without OpenBot's machine: the machine image only.
    assert_eq!(
        plan(&facts(
            "macos",
            Choice::UsePodman,
            Some("podman version 6.1.1"),
            false,
            None
        )),
        Plan {
            machine_image: mac,
            compose: true,
            deployment: true,
            offline_images: true,
            ..Plan::default()
        }
    );
    // Another Podman pulls its own machine-os, and OpenBot's machine already there needs none.
    for (version, exists) in [
        ("podman version 5.7.0", false),
        ("podman version 6.1.1", true),
    ] {
        assert_eq!(
            plan(&facts(
                "macos",
                Choice::UsePodman,
                Some(version),
                exists,
                None
            ))
            .machine_image,
            None,
            "{version} {exists}"
        );
    }
    // A Podman too old for OpenBot is updated over with OpenBot's installer: it downloads early too.
    let old = plan(&facts(
        "macos",
        Choice::UsePodman,
        Some("podman version 5.7.0"),
        true,
        None,
    ));
    assert!(old.podman, "{old:?}");
    assert_eq!(old.machine_image, None);
    // A Docker Desktop that is stopped is not opened before Install: OpenBot's own Compose names
    // the images, which download to load once it answers.
    assert_eq!(
        plan(&facts(
            "macos",
            Choice::OpenDockerDesktop,
            None,
            false,
            None
        )),
        Plan {
            compose: true,
            deployment: true,
            offline_images: true,
            ..Plan::default()
        }
    );
    // A new Windows computer is the same as a new Mac, with the WSL image.
    let windows = plan(&facts("windows", Choice::InstallPodman, None, false, None));
    assert!(windows.offline_images);
    assert!(windows.compose && windows.podman);
    // Linux's Podman comes from its own packages, and it has no machine.
    assert_eq!(
        plan(&facts("linux", Choice::InstallPodman, None, false, None)),
        Plan {
            deployment: true,
            ..Plan::default()
        }
    );
    // An installation that finished before needs nothing early.
    let mut done = facts("macos", Choice::InstallPodman, None, false, None);
    done.installed_before = true;
    assert!(plan(&done).is_empty());
}

/// The machine images are pinned for the Podman this app installs. Moving `install::PODMAN` to
/// another minor release means pinning that release's machine images.
#[test]
fn the_machine_images_belong_to_the_podman_this_app_installs() {
    assert!(
        crate::install::PODMAN.starts_with(&format!("{MACHINE_OS}.")),
        "Podman {} pulls machine-os {}: pin its images",
        crate::install::PODMAN,
        crate::install::PODMAN
    );
    assert!(podman_takes_pinned_machine_image("podman version 6.1.1"));
    assert!(podman_takes_pinned_machine_image(
        "podman.exe version 6.1.0"
    ));
    assert!(!podman_takes_pinned_machine_image("podman version 5.7.1"));
    assert!(!podman_takes_pinned_machine_image("podman version 6.10.0"));
    assert_eq!(machine_image_for("macos", "x86_64"), None);
    assert_eq!(machine_image_for("linux", "x86_64"), None);
    let mac = machine_image_for("macos", "aarch64").unwrap();
    assert_eq!(
        mac.sources(),
        [
            "https://downloads.copilotkit.ai/v2/quay.io/podman/machine-os/blobs/sha256:cd711cd582d301f11616281f0b0098de7cad26b050b7317b8bd3f3ac667c0d21",
            "https://quay.io/v2/podman/machine-os/blobs/sha256:cd711cd582d301f11616281f0b0098de7cad26b050b7317b8bd3f3ac667c0d21",
        ]
    );
    assert_eq!(machine_image_references().len(), 3);
}

/**
The machine is built from the downloaded image, with nothing asked of quay.io.

Runs the real `podman machine init --image` against the pinned applehv image, with every proxy
pointed at a closed loopback port, so any download Podman tried would fail the init. Needs Podman
6.1 and the image on disk: `OPENBOT_LIVE_MACHINE_IMAGE=<path to podman-machine.aarch64.applehv.raw.zst>`.
The machine is removed afterwards.
*/
#[test]
#[ignore = "runs podman machine init with the 937 MB machine image"]
fn a_machine_is_built_from_the_downloaded_image_without_asking_quay() {
    let image = PathBuf::from(
        std::env::var("OPENBOT_LIVE_MACHINE_IMAGE").expect("OPENBOT_LIVE_MACHINE_IMAGE"),
    );
    let pinned = machine_image_for("macos", "aarch64").unwrap();
    assert_eq!(file_sha256(&image).unwrap(), pinned.sha256());
    let name = format!("openbot-early-{}", std::process::id());
    let closed = "http://127.0.0.1:9";
    let podman = |args: &[&str]| {
        std::process::Command::new("podman")
            .args(args)
            .env("HTTP_PROXY", closed)
            .env("HTTPS_PROXY", closed)
            .env("http_proxy", closed)
            .env("https_proxy", closed)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .output()
            .unwrap()
    };
    // `machine init` makes the new machine the default connection, and `rm` hands that on to
    // another: the person's own default is put back afterwards.
    let default_connection = || {
        let listed = podman(&[
            "system",
            "connection",
            "list",
            "--format",
            "{{.Name}} {{.Default}}",
        ]);
        String::from_utf8_lossy(&listed.stdout)
            .lines()
            .find_map(|line| line.strip_suffix(" true").map(str::to_string))
    };
    let default_before = default_connection();
    let image_arg = image.to_string_lossy().into_owned();
    let init = podman(&[
        "machine",
        "init",
        &name,
        "--cpus",
        "2",
        "--memory",
        "2048",
        "--disk-size",
        "12",
        "--rootful",
        "--image",
        &image_arg,
    ]);
    let listed = podman(&["machine", "inspect", &name]);
    let removed = podman(&["machine", "rm", "--force", &name]);
    if let Some(before) =
        default_before.filter(|before| Some(before) != default_connection().as_ref())
    {
        podman(&["system", "connection", "default", &before]);
    }
    assert!(
        init.status.success(),
        "init: {}{}",
        String::from_utf8_lossy(&init.stdout),
        String::from_utf8_lossy(&init.stderr)
    );
    let said = String::from_utf8_lossy(&init.stdout);
    assert!(
        !said.contains("Looking up Podman Machine image"),
        "Podman looked the image up: {said}"
    );
    assert!(listed.status.success());
    assert!(removed.status.success());
}

/**
The real machine image, from the real sources: downloads.copilotkit.ai (which answers 403 until the
next sync copies it), then quay.io with its anonymous token and its CDN's redirect. Stopped part-way,
as a quit would, then carried on from the bytes on disk and checked against the pin.

The Windows x86_64 image, 252 MB, so it runs on any computer: `cargo test -- --ignored live_machine`.
*/
#[test]
#[ignore = "downloads 252 MB from quay.io"]
fn live_machine_image_downloads_from_quay_and_carries_on_after_a_stop() {
    struct StopAt(u64);
    impl Progress for StopAt {
        fn bytes(&self, bytes: u64) {
            assert!(bytes < self.0, "stopped part-way");
        }
    }
    let image = machine_image_for("windows", "x86_64").unwrap();
    let pinned = machine_pinned(&image);
    let cache = temp_root("early-live-quay");
    let stopped = std::panic::catch_unwind(|| fetch(&pinned, &cache, &StopAt(60_000_000)));
    assert!(stopped.is_err());
    let partial = std::fs::metadata(partial_path(&cache, image.file))
        .unwrap()
        .len();
    assert!(partial >= 60_000_000, "{partial}");
    let started = Instant::now();
    let path = fetch(&pinned, &cache, &()).expect("the rest, from quay.io");
    eprintln!(
        "carried on from {partial} bytes, finished in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    assert_eq!(file_sha256(&path).unwrap(), image.sha256());
    let _ = std::fs::remove_dir_all(&cache);
}

/**
The images the first screen pulls are the ones Install pulls for the default Bot, worked out without
an installation: nothing is recorded in the folder before Install. Runs `docker compose config`
against this repository's Compose file and a release's image list.
*/
#[test]
#[ignore = "runs docker compose"]
fn live_the_first_screen_pulls_the_images_install_would() {
    let root = temp_root("early-images");
    std::fs::create_dir_all(&root).unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::copy(
        repository.join("docker-compose.yml"),
        root.join("docker-compose.yml"),
    )
    .unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures/release-images/container-images-v0.3.3.json"),
        crate::deployment::images_path(&root),
    )
    .unwrap();
    let docker = Address::new(Engine::Docker, None);
    let early = default_bot_images(&docker, &root).expect("the default Bot's images");
    // Nothing of an installation's was decided or written.
    let written: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(written.len(), 2, "{written:?}");
    let harness = crate::harness::HarnessChoice {
        id: crate::harness::DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    let install = crate::preparation::installation_pull_set(&docker, &root, &root, Some(&harness))
        .expect("Install's images");
    assert_eq!(early, install);
    assert!(early.iter().any(|image| image.contains("openbot-server@")));
    eprintln!("{early:#?}");
    let _ = std::fs::remove_dir_all(&root);
}

/**
With no engine on the computer, OpenBot's own Compose, downloaded and run on its own, names the same
images Install pulls for the default Bot. Downloads Compose (about 30 MB) and runs `docker compose`
for Install's list to compare with.
*/
#[test]
#[ignore = "downloads Compose and runs docker compose"]
fn live_openbots_own_compose_names_the_images_with_no_engine() {
    let root = temp_root("early-own-compose");
    std::fs::create_dir_all(&root).unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::copy(
        repository.join("docker-compose.yml"),
        root.join("docker-compose.yml"),
    )
    .unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures/release-images/container-images-v0.3.3.json"),
        crate::deployment::images_path(&root),
    )
    .unwrap();
    let cache = temp_root("early-own-compose-cache");
    let compose = crate::install::runnable_compose(&cache, &()).expect("Compose");
    let harness = crate::harness::HarnessChoice {
        id: crate::harness::DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    let nowhere = root.join(".openbot-early-downloads-nowhere");
    let own = crate::preparation::installation_pull_set_by(
        |settings| crate::stack::standalone_compose_command(&compose, &nowhere, settings),
        &nowhere,
        &root,
        Some(&harness),
    )
    .expect("the images, from OpenBot's own Compose");
    let docker = default_bot_images(&Address::new(Engine::Docker, None), &root).expect("Docker's");
    assert_eq!(own, docker);
    assert_eq!(own.len(), 5, "{own:#?}");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&cache);
}

/**
Windows D: Podman answered with no Compose installed, and the first screen said "Some downloads
didn't finish" because the image list asked `podman compose`, which had no provider to run. The list
waits for OpenBot's own Compose (here a stand-in that arrives a moment later, as a download still
running does) and asks it, and nothing else.
*/
#[cfg(unix)]
#[test]
fn the_image_list_waits_for_openbots_own_compose_and_asks_it() {
    use std::os::unix::fs::PermissionsExt;
    let release = temp_root("early-named-images");
    std::fs::create_dir_all(&release).unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::copy(
        repository.join("docker-compose.yml"),
        release.join("docker-compose.yml"),
    )
    .unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures/release-images/container-images-v0.3.3.json"),
        crate::deployment::images_path(&release),
    )
    .unwrap();
    let compose = release.join("docker-compose-own");
    let asked = release.join("asked");
    let started = Instant::now();
    let images = named_images(&release, || {
        // Still downloading for a moment, then in place.
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(
            &compose,
            format!(
                "#!/bin/sh\necho \"$@\" > '{}'\necho pgvector/pgvector:pg17\necho ghcr.io/copilotkit/openbot-server@sha256:fce3ffc51b12c075642a8b37d00d6137d85f418cd8d43d28456757b173d7eef9\n",
                asked.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&compose, std::fs::Permissions::from_mode(0o755)).unwrap();
        Ok(compose.clone())
    })
    .expect("the images, named by OpenBot's own Compose");
    assert!(started.elapsed() >= Duration::from_millis(300));
    let said = std::fs::read_to_string(&asked).unwrap();
    assert!(said.contains("config --images"), "{said}");
    assert!(
        images.contains(&"pgvector/pgvector:pg17".to_string()),
        "{images:?}"
    );
    // The two sign-in images, from the release's image list.
    assert!(
        images
            .iter()
            .any(|image| image.contains("openbot-agent-langgraph-agui@")),
        "{images:?}"
    );
    let _ = std::fs::remove_dir_all(&release);
}

/**
Live: a Podman whose `compose` has no provider to run, as on Windows D. Asking it for the image list
fails, as the first screen did; OpenBot's own Compose, downloaded (about 30 MB), names the five
images Install pulls.
*/
#[test]
#[ignore = "runs podman compose with no provider, and downloads Compose"]
fn live_podman_with_no_compose_still_has_its_images_named() {
    let release = temp_root("early-no-compose");
    std::fs::create_dir_all(&release).unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::copy(
        repository.join("docker-compose.yml"),
        release.join("docker-compose.yml"),
    )
    .unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures/release-images/container-images-v0.3.3.json"),
        crate::deployment::images_path(&release),
    )
    .unwrap();
    // Podman with no Compose provider: what `podman compose` runs is not there.
    std::env::set_var("PODMAN_COMPOSE_PROVIDER", "/nonexistent/docker-compose");
    let podman = Address::new(Engine::Podman, None);
    let through_podman = default_bot_images(&podman, &release);
    assert!(through_podman.is_err(), "{through_podman:?}");
    eprintln!("podman compose: {}", through_podman.unwrap_err());
    let cache = temp_root("early-no-compose-cache");
    let images = named_images(&release, own_compose(&cache)).expect("named by OpenBot's own");
    assert_eq!(images.len(), 5, "{images:#?}");
    let _ = std::fs::remove_dir_all(&release);
    let _ = std::fs::remove_dir_all(&cache);
}
