use super::*;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

fn count(kind: &str, count: u64) -> Count {
    Count {
        kind: kind.into(),
        count,
    }
}

fn gmail() -> ReconnectApp {
    ReconnectApp {
        app_id: "gmail".into(),
        app_name: "Gmail".into(),
        account_label: Some("sam@example.com".into()),
        icon_url: None,
        bot_names: vec!["Inbox helper".into()],
    }
}

fn quick() -> Limits {
    Limits {
        export: Duration::from_secs(5),
        import: Duration::from_secs(5),
        poll: Duration::from_millis(1),
        part_tries: 3,
    }
}

fn asked() -> Asked<'static> {
    Asked {
        include_model_keys: true,
        source_name: "Sam's MacBook",
        limits: quick(),
    }
}

#[derive(Default)]
struct Steps(Vec<String>);

impl Progress for Steps {
    fn running(&mut self, stage: Stage, _progress: Option<f64>) {
        let line = format!("{stage:?} running");
        if self.0.last() != Some(&line) {
            self.0.push(line);
        }
    }
    fn done(&mut self, stage: Stage) {
        self.0.push(format!("{stage:?} done"));
    }
}

// ------------------------------------------------------------------------------------------------
// The person's answer.

/// Offered once, after the update, to OpenBot (Self-Contained) only: never to an app connected to
/// OpenBot Cloud or a company's OpenBot, never without an OpenBot set up here, never once answered,
/// and never by a build that doesn't offer Cloud.
#[test]
fn the_move_is_offered_once_and_only_to_self_contained() {
    let said = |answer| Recorded {
        answer,
        ..Recorded::default()
    };
    let release = "1.2.0";
    assert!(due(true, false, true, &said(None), release));
    // OpenBot Cloud or OpenBot for Business: connected to an OpenBot elsewhere.
    assert!(!due(true, true, true, &said(None), release));
    assert!(!due(true, false, false, &said(None), release));
    assert!(!due(false, false, true, &said(None), release));
    assert!(!due(true, false, true, &said(Some(Answer::Kept)), release));
    assert!(!due(true, false, true, &said(Some(Answer::Moved)), release));
    // Keep never asks again at launch, and Settings still offers it; a move is final.
    assert!(offered_in_settings(true, false, Some(Answer::Kept)));
    assert!(offered_in_settings(true, false, None));
    assert!(!offered_in_settings(true, false, Some(Answer::Moved)));
    assert!(!offered_in_settings(true, true, None));
    assert!(!offered_in_settings(false, false, None));
}

/// Keep is kept: written, read back on the next launch, and the offer is not due again.
#[test]
fn keep_is_remembered_across_launches() {
    let dir = crate::test_support::temp_root("move-answer");
    assert_eq!(answered(&dir), None);
    record_kept(&dir, "1.2.0").unwrap();
    // A later launch reads the folder afresh, in the next release too.
    let next_launch = on_record(&dir);
    assert_eq!(next_launch.answer, Some(Answer::Kept));
    assert!(!due(true, false, true, &next_launch, "1.2.0"));
    assert!(!due(true, false, true, &next_launch, "1.3.0"));
    record_moved(&dir).unwrap();
    assert_eq!(answered(&dir), Some(Answer::Moved));
    assert!(!dir.join(format!("{FILE}.partial")).exists());
    // A file that isn't an answer is no answer, and the offer stands.
    std::fs::write(dir.join(FILE), "{").unwrap();
    assert_eq!(answered(&dir), None);
    let _ = std::fs::remove_dir_all(dir);
}

/**
FOUND ON 1.2.0-rc.2: five moves failed their last check, the person quit, and at the next launch
chose Keep to get back to work. rc.3 fixed the move and never offered it again. A Keep chosen while a
failed move is on record is offered again at the first launch of another release, once; a second
Keep then sticks. A plain Keep never comes back at launch, and a finished move never comes back at
all, whatever failed before it.
*/
#[test]
fn a_keep_after_a_failed_move_is_offered_again_once_after_an_update() {
    let offered = |dir: &Path, release: &str| due(true, false, true, &on_record(dir), release);

    // Failed, then Keep: not again in the same release, again in the next.
    let dir = crate::test_support::temp_root("move-kept-after-failure");
    record_failed_move(&dir).unwrap();
    assert!(offered(&dir, "1.2.0-rc.2"), "a failed move is no answer");
    record_kept(&dir, "1.2.0-rc.2").unwrap();
    assert!(!offered(&dir, "1.2.0-rc.2"), "not again before an update");
    assert!(
        offered(&dir, "1.2.0-rc.3"),
        "offered again after the update"
    );
    assert!(offered(&dir, "1.2.0-rc.3"), "until it is answered");
    // Answered again with Keep, even after another failed move: it sticks.
    record_failed_move(&dir).unwrap();
    record_kept(&dir, "1.2.0-rc.3").unwrap();
    assert!(!offered(&dir, "1.2.0-rc.3"));
    assert!(
        !offered(&dir, "1.2.0"),
        "offered again once, not every update"
    );
    assert_eq!(
        on_record(&dir),
        Recorded {
            answer: Some(Answer::Kept),
            ..Recorded::default()
        },
        "the failed move is cleared once the offer is answered again"
    );
    let _ = std::fs::remove_dir_all(&dir);

    // Kept again in the same release, before any update: still offered once after it.
    let dir = crate::test_support::temp_root("move-kept-twice");
    record_failed_move(&dir).unwrap();
    record_kept(&dir, "1.2.0-rc.3").unwrap();
    record_kept(&dir, "1.2.0-rc.3").unwrap();
    assert!(offered(&dir, "1.2.0"));
    let _ = std::fs::remove_dir_all(&dir);

    // A plain Keep: never again at launch, whatever the release.
    let dir = crate::test_support::temp_root("move-plain-keep");
    record_kept(&dir, "1.2.0-rc.2").unwrap();
    assert!(!offered(&dir, "1.2.0-rc.3"));
    assert!(!offered(&dir, "1.2.0"));
    let _ = std::fs::remove_dir_all(&dir);

    // Moved: never again, and nothing failed stays on record.
    let dir = crate::test_support::temp_root("move-moved-after-failure");
    record_failed_move(&dir).unwrap();
    record_kept(&dir, "1.2.0-rc.2").unwrap();
    record_moved(&dir).unwrap();
    record_failed_move(&dir).unwrap();
    assert!(!offered(&dir, "1.2.0-rc.3"));
    assert_eq!(
        on_record(&dir),
        Recorded {
            answer: Some(Answer::Moved),
            ..Recorded::default()
        }
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The file reads both ways: what 1.2.0-rc.3 and earlier wrote reads here as it did there, and what
/// this release writes reads there as the same answer.
#[test]
fn the_answer_file_reads_across_releases() {
    let dir = crate::test_support::temp_root("move-answer-file");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(FILE), r#"{"answer":"kept"}"#).unwrap();
    assert_eq!(answered(&dir), Some(Answer::Kept));
    assert!(!due(true, false, true, &on_record(&dir), "1.2.0"));

    record_failed_move(&dir).unwrap();
    record_kept(&dir, "1.2.0").unwrap();
    // As 1.2.0-rc.3 reads it: `{ answer: Answer }`, other fields passed over.
    #[derive(Deserialize)]
    struct Before {
        answer: Answer,
    }
    let bytes = std::fs::read(dir.join(FILE)).unwrap();
    assert_eq!(
        serde_json::from_slice::<Before>(&bytes).unwrap().answer,
        Answer::Kept
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------------------------
// The checks.

fn verification(matches: bool, kinds: &[(&str, u64, u64, u64)]) -> Verification {
    Verification {
        matches,
        kinds: kinds
            .iter()
            .map(|(kind, expected, found, left_out)| VerifiedKind {
                kind: (*kind).into(),
                expected: *expected,
                found: *found,
                left_out: *left_out,
            })
            .collect(),
        notes: Vec::new(),
        reconnect: Vec::new(),
    }
}

/// Removing waits for Cloud's own word and for the export's counts: a check Cloud says matches
/// but that is short of what was exported is still short, a kind Cloud doesn't list is short, and
/// what Cloud left out on purpose (and said so) counts as there.
#[test]
fn only_a_full_match_lets_the_move_remove_anything() {
    let exported = [
        count("bots", 3),
        count("conversations", 12),
        count("goals", 0),
    ];
    assert_eq!(
        short_of(
            &exported,
            &verification(true, &[("bots", 3, 2, 1), ("conversations", 12, 12, 0)])
        ),
        None
    );
    assert!(short_of(
        &exported,
        &verification(false, &[("bots", 3, 3, 0), ("conversations", 12, 12, 0)])
    )
    .is_some());
    assert_eq!(
        short_of(
            &exported,
            &verification(true, &[("bots", 3, 3, 0), ("conversations", 12, 11, 0)])
        )
        .as_deref(),
        Some("conversations: 11 of 12")
    );
    assert_eq!(
        short_of(&exported, &verification(true, &[("bots", 3, 3, 0)])).as_deref(),
        Some("conversations: 0 of 12")
    );
}

// ------------------------------------------------------------------------------------------------
// The move, with each side in memory.

/// A bundle of `sizes.len()` parts, with their bytes.
fn bundle(sizes: &[usize]) -> Vec<(Part, Vec<u8>)> {
    sizes
        .iter()
        .enumerate()
        .map(|(index, size)| {
            let bytes: Vec<u8> = (0..*size).map(|at| (at * 7 + index) as u8).collect();
            let part = Part {
                number: index as u32 + 1,
                bytes: *size as u64,
                sha256: hex(&Sha256::digest(&bytes)),
            };
            (part, bytes)
        })
        .collect()
}

struct MemoryLocal {
    parts: Vec<(Part, Vec<u8>)>,
    counts: Vec<Count>,
    polls_before_ready: u32,
    fail_export: bool,
    /// Bytes handed per download, to make drops.
    chunk: usize,
    /// Downloads of a part that come back damaged first.
    damaged: u32,
    asked_key: Option<serde_json::Value>,
}

impl MemoryLocal {
    fn new(parts: Vec<(Part, Vec<u8>)>) -> Self {
        MemoryLocal {
            parts,
            counts: vec![count("bots", 2), count("conversations", 5)],
            polls_before_ready: 2,
            fail_export: false,
            chunk: usize::MAX,
            damaged: 0,
            asked_key: None,
        }
    }

    fn ready(&self) -> Export {
        Export {
            id: "exp_1".into(),
            status: "ready".into(),
            parts: self.parts.iter().map(|(part, _)| part.clone()).collect(),
            counts: self.counts.clone(),
            reconnect: vec![gmail()],
            progress: None,
            error: None,
        }
    }
}

impl Local for MemoryLocal {
    fn estimate(&mut self) -> Result<Estimate, String> {
        Ok(Estimate {
            counts: self.counts.clone(),
            stored_bytes: 1,
            reconnect: vec![gmail()],
            model_keys_available: true,
        })
    }
    fn create_export(&mut self, key: Option<&serde_json::Value>) -> Result<Export, String> {
        self.asked_key = key.cloned();
        Ok(Export {
            status: "preparing".into(),
            parts: Vec::new(),
            ..self.ready()
        })
    }
    fn export(&mut self, _id: &str) -> Result<Export, String> {
        if self.fail_export {
            return Ok(Export {
                status: "failed".into(),
                error: Some("the database didn't answer".into()),
                ..self.ready()
            });
        }
        if self.polls_before_ready > 0 {
            self.polls_before_ready -= 1;
            return Ok(Export {
                status: "preparing".into(),
                progress: Some(0.5),
                ..self.ready()
            });
        }
        Ok(self.ready())
    }
    fn download(&mut self, _id: &str, part: u32, from: u64) -> Result<Vec<u8>, String> {
        let (_, bytes) = &self.parts[part as usize - 1];
        let mut rest = bytes[from as usize..].to_vec();
        rest.truncate(self.chunk);
        if self.damaged > 0 && !rest.is_empty() {
            self.damaged -= 1;
            rest[0] ^= 0xff;
        }
        Ok(rest)
    }
}

/// OpenBot Cloud's sentence for an import that stopped part way and goes on when applied again.
const PASSING: &str =
    "Something went wrong while importing. Apply again to go on from where it stopped.";

#[derive(Default)]
struct MemoryCloud {
    received: BTreeMap<u32, Vec<u8>>,
    order: Vec<u32>,
    fail_create: bool,
    refuse_uploads: bool,
    failed_imports: u32,
    polls_before_imported: u32,
    verification: Option<Verification>,
}

impl MemoryCloud {
    fn answer(&self, status: &str) -> Import {
        Import {
            id: "imp_1".into(),
            status: status.into(),
            recipient_key: Some(serde_json::json!({"kty": "RSA", "kid": "imp_1"})),
            received_parts: self.received.keys().copied().collect(),
            // What OpenBot Cloud says of a run that stopped part way (`failureOf`).
            error: (status == "failed").then(|| PASSING.into()),
        }
    }
}

impl Cloud for MemoryCloud {
    fn create_import(&mut self, _source_name: &str) -> Result<Import, String> {
        if self.fail_create {
            return Err("POST /imports answered 503".into());
        }
        Ok(self.answer("waiting-for-bundle"))
    }
    fn upload(&mut self, _id: &str, part: u32, bytes: &[u8]) -> Result<Import, String> {
        if self.refuse_uploads {
            return Err("PUT answered 409 IMPORT_PART_MISMATCH".into());
        }
        self.order.push(part);
        self.received.insert(part, bytes.to_vec());
        Ok(self.answer("receiving"))
    }
    fn apply(&mut self, _id: &str) -> Result<Import, String> {
        if self.failed_imports > 0 {
            self.failed_imports -= 1;
            return Ok(self.answer("failed"));
        }
        Ok(self.answer("importing"))
    }
    fn import(&mut self, _id: &str) -> Result<Import, String> {
        if self.polls_before_imported > 0 {
            self.polls_before_imported -= 1;
            return Ok(self.answer("importing"));
        }
        Ok(self.answer("imported"))
    }
    fn verification(&mut self, _id: &str) -> Result<Verification, String> {
        Ok(self.verification.clone().unwrap_or_else(|| Verification {
            notes: vec![Note {
                code: "isolated-bot-made-ordinary".into(),
                message: "Research runs on an ordinary computer here.".into(),
            }],
            reconnect: vec![gmail()],
            ..verification(true, &[("bots", 2, 2, 0), ("conversations", 5, 5, 0)])
        }))
    }
}

/// This computer, in memory: how much it holds, and whether anything was removed.
struct MemoryHere {
    held: u64,
    moved: bool,
    removed: bool,
}

impl Here for MemoryHere {
    fn footprint(&mut self) -> Option<u64> {
        Some(self.held)
    }
    fn moved(&mut self) -> Result<(), String> {
        self.moved = true;
        Ok(())
    }
    fn remove(&mut self) -> Vec<String> {
        self.removed = true;
        self.held = 0;
        Vec::new()
    }
}

fn here() -> MemoryHere {
    MemoryHere {
        held: 7_000_000_000,
        moved: false,
        removed: false,
    }
}

#[test]
fn a_move_that_arrives_and_matches_removes_openbot_and_says_what_it_freed() {
    let mut local = MemoryLocal::new(bundle(&[1000, 400, 7]));
    let mut cloud = MemoryCloud {
        polls_before_imported: 2,
        ..MemoryCloud::default()
    };
    let mut here = here();
    let mut steps = Steps::default();
    let moved = run(&mut local, &mut cloud, &mut here, &asked(), &mut steps).unwrap();

    assert!(here.moved && here.removed);
    assert_eq!(moved.removed_bytes, Some(7_000_000_000));
    assert_eq!(moved.apps, [gmail()]);
    assert_eq!(moved.notes, ["Research runs on an ordinary computer here."]);
    // Part 1, which carries the manifest, first; every part arrived as it left.
    assert_eq!(cloud.order, [1, 2, 3]);
    for (part, bytes) in &local.parts {
        assert_eq!(&cloud.received[&part.number], bytes);
    }
    // The model key is sealed to this import's key, when the person brings it.
    assert_eq!(local.asked_key.unwrap()["kid"], "imp_1");
    assert_eq!(
        steps.0,
        [
            "Export running",
            "Export done",
            "Upload running",
            "Upload done",
            "Import running",
            "Import done",
            "Verify running",
            "Verify done",
            "Remove running",
            "Remove done",
        ]
    );
}

/// Without the model key, the export is asked for none.
#[test]
fn the_model_key_stays_unless_the_person_brings_it() {
    let mut local = MemoryLocal::new(bundle(&[10]));
    let asked = Asked {
        include_model_keys: false,
        ..asked()
    };
    run(
        &mut local,
        &mut MemoryCloud::default(),
        &mut here(),
        &asked,
        &mut Steps::default(),
    )
    .unwrap();
    assert_eq!(local.asked_key, None);
}

/// A download that drops resumes where it stopped, and a part that arrives damaged is fetched
/// again: what Cloud gets is exactly the part.
#[test]
fn a_dropped_or_damaged_part_is_fetched_again() {
    let mut local = MemoryLocal::new(bundle(&[1000, 10]));
    local.chunk = 300;
    local.damaged = 1;
    let mut cloud = MemoryCloud::default();
    run(
        &mut local,
        &mut cloud,
        &mut here(),
        &asked(),
        &mut Steps::default(),
    )
    .unwrap();
    assert_eq!(cloud.received[&1], local.parts[0].1);
    assert_eq!(cloud.received[&2], local.parts[1].1);
}

/// Every way the move can fail before Cloud's check has passed leaves this computer exactly as it
/// was: nothing is kept as moved and nothing is removed. The person can try again or keep OpenBot.
#[test]
fn a_move_that_fails_anywhere_before_the_check_removes_nothing() {
    type Breaks = fn(&mut MemoryLocal, &mut MemoryCloud);
    let cases: [(&str, Breaks, &str); 7] = [
        (
            "Cloud can't start the import",
            |_, cloud| cloud.fail_create = true,
            "move-failed",
        ),
        (
            "the export fails",
            |local, _| local.fail_export = true,
            "move-failed",
        ),
        (
            "every part arrives damaged",
            |local, _| local.damaged = u32::MAX,
            "move-failed",
        ),
        (
            "Cloud refuses the parts",
            |_, cloud| cloud.refuse_uploads = true,
            "move-failed",
        ),
        (
            "the import fails twice",
            |_, cloud| cloud.failed_imports = 2,
            "move-failed",
        ),
        (
            "Cloud's check doesn't match",
            |_, cloud| {
                cloud.verification = Some(verification(
                    false,
                    &[("bots", 2, 1, 0), ("conversations", 5, 5, 0)],
                ))
            },
            "move-mismatch",
        ),
        (
            "Cloud says it matches but is short of the export",
            |_, cloud| {
                cloud.verification = Some(verification(
                    true,
                    &[("bots", 2, 2, 0), ("conversations", 4, 4, 0)],
                ))
            },
            "move-mismatch",
        ),
    ];
    for (case, breaks, kind) in cases {
        let mut local = MemoryLocal::new(bundle(&[100, 50]));
        let mut cloud = MemoryCloud::default();
        breaks(&mut local, &mut cloud);
        let mut here = here();
        let failed = run(
            &mut local,
            &mut cloud,
            &mut here,
            &asked(),
            &mut Steps::default(),
        )
        .unwrap_err();
        assert_eq!(failed.kind(), kind, "{case}: {failed:?}");
        assert!(!here.moved, "{case}: the move was kept");
        assert!(!here.removed, "{case}: something was removed");
        assert_eq!(here.held, 7_000_000_000, "{case}");
        // What the person reads is plain, and never the engine's or the server's own words.
        let said = failed.said().to_lowercase();
        for word in [
            "import",
            "export",
            "manifest",
            "409",
            "verification",
            "container",
        ] {
            assert!(!said.contains(word), "{case}: {word} in {said}");
        }
    }
}

/// A failed import is applied once more, which goes on from where it stopped.
#[test]
fn a_failed_import_is_applied_once_more() {
    let mut cloud = MemoryCloud {
        failed_imports: 1,
        ..MemoryCloud::default()
    };
    let mut here = here();
    run(
        &mut MemoryLocal::new(bundle(&[10])),
        &mut cloud,
        &mut here,
        &asked(),
        &mut Steps::default(),
    )
    .unwrap();
    assert!(here.removed);
}

/// What was removed is what the files measured before less what is left, whatever the disk says;
/// what the disk gained is its own figure, beside it. Box B's files measured 12.0 GB while its disk
/// gained 10.8 GB. A disk that didn't grow (another program wrote meanwhile) or couldn't be read
/// says nothing.
#[test]
fn what_was_removed_and_what_the_disk_gained_are_each_their_own() {
    const GB: u64 = 1_000_000_000;
    assert_eq!(removed(Some(12 * GB), Some(0)), Some(12 * GB));
    assert_eq!(removed(Some(12 * GB), None), Some(12 * GB));
    assert_eq!(removed(Some(12 * GB), Some(GB)), Some(11 * GB));
    assert_eq!(removed(None, Some(0)), None);
    assert_eq!(
        disk_gained(Some(106_810_000_000), Some(117_610_000_000)),
        Some(10_800_000_000)
    );
    assert_eq!(disk_gained(Some(100 * GB), Some(99 * GB)), None);
    assert_eq!(disk_gained(Some(100 * GB), Some(100 * GB)), None);
    assert_eq!(disk_gained(None, Some(3 * GB)), None);
}

// ------------------------------------------------------------------------------------------------
// Footprint.

#[test]
fn the_footprint_counts_each_file_once_and_never_follows_a_link() {
    let root = crate::test_support::temp_root("move-footprint");
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::write(root.join("a/one"), vec![1u8; 10_000]).unwrap();
    std::fs::write(root.join("a/b/two"), vec![2u8; 20_000]).unwrap();
    let whole = footprint(&[root.join("a")]);
    assert!(whole >= 30_000, "{whole}");
    // A part inside one already counted adds nothing.
    assert_eq!(footprint(&[root.join("a"), root.join("a/b")]), whole);
    assert_eq!(footprint(&[root.join("missing")]), 0);
    #[cfg(unix)]
    {
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("big"), vec![3u8; 50_000]).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("a/link")).unwrap();
        assert!(footprint(&[root.join("a")]) < whole + 50_000);
    }
    let _ = std::fs::remove_dir_all(root);
}

/// A Podman machine's disk is found wherever this Podman's inspect names it.
#[test]
fn a_machines_disk_is_found_in_what_inspect_prints() {
    let root = crate::test_support::temp_root("move-machine-disk");
    std::fs::create_dir_all(&root).unwrap();
    let disk = root.join("openbot-arm64.raw");
    std::fs::write(&disk, vec![0u8; 4096]).unwrap();
    let inspected = serde_json::json!([{
        "Name": "openbot",
        "ConfigDir": { "Path": root.display().to_string() },
        "Image": { "ImagePath": { "Path": disk.display().to_string() } },
        "Resources": { "DiskSize": 100 },
        "Elsewhere": [root.join("gone.raw").display().to_string()]
    }])
    .to_string();
    assert_eq!(machine_disks(&inspected, "openbot", None), [disk]);
    assert!(machine_disks("not json", "openbot", None).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

/// The cloud Mac: Podman 6.1.1's inspect names no disk, only the provider through ConfigDir, and
/// the move offered to free 168 MB of a 9 GB machine. The machine's disk is found in that
/// provider's data folder, and another machine's beside it is not.
#[test]
fn a_macs_machine_disk_is_found_through_its_provider() {
    let home = crate::test_support::temp_root("move-mac-disk");
    let data = home.join(".local/share");
    let folder = data.join("containers/podman/machine/libkrun");
    std::fs::create_dir_all(folder.join("cache")).unwrap();
    let disk = folder.join("openbot-arm64.raw");
    std::fs::write(&disk, vec![1u8; 8192]).unwrap();
    std::fs::write(folder.join("openbot-s1-arm64.raw"), vec![1u8; 8192]).unwrap();
    std::fs::write(
        folder.join("podman-machine-default-arm64.raw"),
        vec![1u8; 8192],
    )
    .unwrap();
    // As Podman 6.1.1 printed it on the cloud Mac, paths moved under the test's home.
    let inspected = serde_json::json!([{
        "ConfigDir": { "Path": home.join(".config/containers/podman/machine/libkrun").display().to_string() },
        "ConnectionInfo": { "PodmanSocket": { "Path": "/tmp/podman/openbot-api.sock" }, "PodmanPipe": null },
        "Created": "2026-11-22T00:14:08.925059Z",
        "LastUp": "2026-11-22T01:06:40.153517Z",
        "Name": "openbot",
        "Resources": { "CPUs": 4, "DiskSize": 60, "Memory": 6144, "USBs": [] },
        "SSHConfig": {
            "IdentityPath": data.join("containers/podman/machine/machine").display().to_string(),
            "Port": 49812,
            "RemoteUsername": "core"
        },
        "State": "running",
        "UserModeNetworking": true,
        "Rootful": true,
        "Rosetta": false
    }])
    .to_string();
    assert!(machine_disks(&inspected, "openbot", None).is_empty());
    assert_eq!(
        machine_disks(&inspected, "openbot", Some(&data)),
        std::slice::from_ref(&disk)
    );
    assert!(footprint(&machine_disks(&inspected, "openbot", Some(&data))) >= 8192);
    let _ = std::fs::remove_dir_all(home);
}

// ------------------------------------------------------------------------------------------------
// What the move screens promise, and what the result says.

/// Podman 6.1's `podman machine inspect openbot` on a Mac, as it printed it on the cloud Mac, paths
/// moved under `home`: no disk named, the provider only through `ConfigDir`.
fn podman_61_inspect(home: &Path) -> String {
    serde_json::json!([{
        "ConfigDir": { "Path": home.join(".config/containers/podman/machine/libkrun").display().to_string() },
        "ConnectionInfo": { "PodmanSocket": { "Path": "/tmp/podman/openbot-api.sock" }, "PodmanPipe": null },
        "Created": "2026-11-22T15:58:37.375Z",
        "LastUp": "2026-11-22T16:38:54.845Z",
        "Name": "openbot",
        "Resources": { "CPUs": 4, "DiskSize": 60, "Memory": 6144, "USBs": [] },
        "SSHConfig": {
            "IdentityPath": home.join(".local/share/containers/podman/machine/machine").display().to_string(),
            "Port": 49812,
            "RemoteUsername": "core"
        },
        "State": "running",
        "UserModeNetworking": true,
        "Rootful": true,
        "Rosetta": false
    }])
    .to_string()
}

/**
A Mac with OpenBot (Self-Contained) on its own Podman 6.1 machine, as 1.2.0-rc.1 left it: the
installation folder, the downloads, and the machine's sparse disk in the provider's data folder.
Removing OpenBot deletes all of them, but the disk shows only `shown` of what was deleted as free
at once: a local snapshot taken a few minutes before keeps the rest.
*/
struct MacWithSnapshot {
    home: PathBuf,
    root: PathBuf,
    disk: PathBuf,
    /// What `podman machine inspect openbot` prints, until the machine is removed.
    inspected: Option<String>,
    free: u64,
    shown: (u64, u64),
    /// `podman machine rm` fails and leaves the disk, though Podman no longer names the machine.
    machine_stays: bool,
    measured: Footprint,
}

impl MacWithSnapshot {
    fn new(shown: (u64, u64)) -> MacWithSnapshot {
        let home = crate::test_support::temp_root("move-mac-snapshot");
        let root = installation(&home);
        let downloads = home.join("OpenBot/openbot-engine/images");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("blob"), vec![5u8; 1_000_000]).unwrap();
        let folder = home.join(".local/share/containers/podman/machine/libkrun");
        std::fs::create_dir_all(&folder).unwrap();
        // Sparse, as Podman makes it: long, and only what the machine wrote on disk.
        let disk = folder.join("openbot-arm64.raw");
        let mut file = std::fs::File::create(&disk).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
        for at in [0u64, 8, 40] {
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(at * 1024 * 1024)).unwrap();
            file.write_all(&vec![9u8; 2 * 1024 * 1024]).unwrap();
        }
        drop(file);
        MacWithSnapshot {
            inspected: Some(podman_61_inspect(&home)),
            home,
            root,
            disk,
            free: 844_165_000_000,
            shown,
            machine_stays: false,
            measured: Footprint::default(),
        }
    }

    /// OpenBot's files, found as the move finds them on a Mac: the installation's own and its
    /// downloads, and the machine's disk through what Podman's inspect prints.
    fn parts(&self) -> Vec<PathBuf> {
        let mut parts = crate::uninstall::installation_parts(&self.root, Some(&self.home));
        if let Some(inspected) = &self.inspected {
            parts.extend(machine_disks(
                inspected,
                "openbot",
                Some(&self.home.join(".local/share")),
            ));
        }
        parts
    }
}

/// As `desktop_move`'s `ThisComputer` measures: the parts found once, then measured again.
impl Here for MacWithSnapshot {
    fn footprint(&mut self) -> Option<u64> {
        let parts = self.parts();
        self.measured.measure(|| parts)
    }
    fn moved(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// `podman machine rm openbot` deletes the disk and Podman no longer knows the machine, then
    /// the installation's files go.
    fn remove(&mut self) -> Vec<String> {
        let before = footprint(&self.parts());
        if !self.machine_stays {
            std::fs::remove_file(&self.disk).unwrap();
        }
        self.inspected = None;
        crate::uninstall::remove_installation(&self.root, Some(&self.home), false).unwrap();
        let left = if self.machine_stays {
            footprint(std::slice::from_ref(&self.disk))
        } else {
            0
        };
        self.free += (before - left) * self.shown.0 / self.shown.1;
        Vec::new()
    }
    fn free_space(&mut self) -> Option<u64> {
        Some(self.free)
    }
}

/// Seen on a Mac with Apple silicon, 1.2.0-rc.1 moved to OpenBot Cloud: the move screen said
/// "Frees about 20.2 GB", then the result said "4.5 GB freed on this computer". The files were all
/// gone; the disk showed 4.5 of the 20.2 GB free at once. The result says what the move removed,
/// counted as the move screen counted it, and the disk's own figure beside it.
#[test]
fn the_result_counts_what_the_move_screen_counted() {
    let mut mac = MacWithSnapshot::new((45, 202));
    // What the move screen says: `move_offer` and `move_preview` measure these parts this way.
    let promised = footprint(&mac.parts());
    assert!(promised >= 7 * 1024 * 1024, "{promised}");
    let moved = run(
        &mut MemoryLocal::new(bundle(&[1000, 400, 7])),
        &mut MemoryCloud::default(),
        &mut mac,
        &asked(),
        &mut Steps::default(),
    )
    .unwrap();
    assert!(!mac.disk.exists() && !mac.root.exists());
    assert_eq!(moved.removed_bytes, Some(promised));
    assert_eq!(moved.disk_gained_bytes, Some(promised * 45 / 202));
    let _ = std::fs::remove_dir_all(&mac.home);
}

/// A machine whose removal failed is no longer named by Podman, but its disk is still there: the
/// result measures the paths it measured before, so that disk is not counted as removed.
#[test]
fn a_disk_the_removal_left_is_not_counted_as_removed() {
    let mut mac = MacWithSnapshot::new((1, 1));
    mac.machine_stays = true;
    let promised = footprint(&mac.parts());
    let disk = footprint(std::slice::from_ref(&mac.disk));
    let moved = run(
        &mut MemoryLocal::new(bundle(&[1000, 400, 7])),
        &mut MemoryCloud::default(),
        &mut mac,
        &asked(),
        &mut Steps::default(),
    )
    .unwrap();
    assert!(mac.disk.exists() && !mac.root.exists());
    assert_eq!(moved.removed_bytes, Some(promised - disk));
    assert_eq!(moved.disk_gained_bytes, Some(promised - disk));
    let _ = std::fs::remove_dir_all(&mac.home);
}

// ------------------------------------------------------------------------------------------------
// Over HTTP, against an OpenBot here and an OpenBot Cloud that answer as the API says, and with the
// real uninstall code removing a real installation folder.

/// One request as the fake server read it.
struct Request {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn json_response(status: u16, value: serde_json::Value) -> Response {
    Response {
        status,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: value.to_string().into_bytes(),
    }
}

/// A server on 127.0.0.1 that answers every request with `answer`, until the test ends.
fn serve(answer: impl Fn(&Request) -> Response + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let answer = Arc::new(answer);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let answer = answer.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() {
                    return;
                }
                let mut words = first.split_whitespace();
                let method = words.next().unwrap_or_default().to_owned();
                let path = words.next().unwrap_or_default().to_owned();
                let mut headers = BTreeMap::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.insert(name.trim().to_lowercase(), value.trim().to_owned());
                    }
                }
                let length: usize = headers
                    .get("content-length")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; length];
                if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                    return;
                }
                let response = answer(&Request {
                    method,
                    path,
                    headers,
                    body,
                });
                let mut stream = stream;
                let mut head = format!(
                    "HTTP/1.1 {} Answer\r\nContent-Length: {}\r\nConnection: close\r\n",
                    response.status,
                    response.body.len()
                );
                for (name, value) in &response.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&response.body);
            });
        }
    });
    address
}

const TOKEN: &str = "synthetic-install-token";
const BEARER: &str = "synthetic-cloud-access";

/// The OpenBot on this computer, as the API says it answers: one organization, an export that is
/// preparing once and then ready, and its parts with Range.
fn local_openbot(parts: Vec<(Part, Vec<u8>)>, counts: Vec<Count>) -> String {
    let polled = Arc::new(Mutex::new(0u32));
    serve(move |request| {
        if request
            .headers
            .get("x-openbot-install-token")
            .map(String::as_str)
            != Some(TOKEN)
        {
            return json_response(401, serde_json::json!({"code": "UNAUTHENTICATED"}));
        }
        let ready = serde_json::json!({
            "id": "exp_1",
            "status": "ready",
            "createdAt": "2026-11-21T10:00:00Z",
            "expiresAt": "2026-11-28T10:00:00Z",
            "includesModelKeys": false,
            "parts": parts.iter().map(|(part, _)| serde_json::json!({
                "number": part.number, "bytes": part.bytes, "sha256": part.sha256
            })).collect::<Vec<_>>(),
            "counts": counts.iter().map(|c| serde_json::json!({"kind": c.kind, "count": c.count})).collect::<Vec<_>>(),
            "reconnect": [{"appId": "gmail", "appName": "Gmail", "accountLabel": "sam@example.com"}],
        });
        // OpenBot (Self-Contained) lists no organizations (box A: that address answered 404);
        // its one organization is `default`.
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/api/v2/organizations/default/exports") => {
                assert!(request.headers.contains_key("idempotency-key"));
                let mut preparing = ready.clone();
                preparing["status"] = "preparing".into();
                json_response(202, preparing)
            }
            ("GET", "/api/v2/organizations/default/exports/exp_1") => {
                let mut polled = polled.lock().unwrap();
                *polled += 1;
                if *polled == 1 {
                    let mut preparing = ready.clone();
                    preparing["status"] = "preparing".into();
                    json_response(200, preparing)
                } else {
                    json_response(200, ready.clone())
                }
            }
            ("GET", path) if path.contains("/default/exports/exp_1/parts/") => {
                let number: usize = path.rsplit('/').next().unwrap().parse().unwrap();
                let bytes = &parts[number - 1].1;
                match request.headers.get("range") {
                    Some(range) => {
                        let from: usize = range
                            .trim_start_matches("bytes=")
                            .trim_end_matches('-')
                            .parse()
                            .unwrap();
                        Response {
                            status: 206,
                            headers: vec![],
                            body: bytes[from..].to_vec(),
                        }
                    }
                    // The first download of each part drops half-way, as a dropped connection does.
                    None => Response {
                        status: 200,
                        headers: vec![],
                        body: bytes[..bytes.len() / 2].to_vec(),
                    },
                }
            }
            _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
        }
    })
}

/// The parts an OpenBot Cloud in a test received, by number.
type Received = Arc<Mutex<BTreeMap<u32, Vec<u8>>>>;

/// OpenBot Cloud, as the API says it answers: the person's own organization, an import that
/// checks each part against the manifest, imports on apply, and is checked by `verify`. With
/// `stops`, every run of the import fails, and the import says that sentence as its `error`.
fn cloud_openbot(
    expected: Vec<Part>,
    verify: serde_json::Value,
    stops: Option<&'static str>,
) -> (String, Received) {
    let received: Received = Arc::default();
    let parts = received.clone();
    let address = serve(move |request| {
        if request.headers.get("authorization").map(String::as_str)
            != Some(&format!("Bearer {BEARER}"))
        {
            return json_response(401, serde_json::json!({"code": "UNAUTHENTICATED"}));
        }
        let import = |status: &str| {
            serde_json::json!({
                "id": "imp_1", "status": status, "createdAt": "2026-11-21T10:00:00Z",
                "recipientKey": {"kty": "RSA", "n": "abc", "e": "AQAB", "alg": "RSA-OAEP-256", "kid": "imp_1"},
                "maxBundleBytes": 10_737_418_240u64, "maxPartBytes": 33_554_432u64,
                "receivedParts": parts.lock().unwrap().keys().collect::<Vec<_>>(),
            })
        };
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v2/people/me/organizations") => json_response(
                200,
                serde_json::json!({"organizations": [
                    {"id": "org_team", "slug": "team", "name": "Team", "role": "member", "active": true, "personal": false},
                    {"id": "org_mine", "slug": "sam", "name": "Sam", "role": "owner", "active": false, "personal": true}
                ], "canCreate": true, "nextCursor": null}),
            ),
            ("POST", "/api/v2/organizations/org_mine/imports") => {
                json_response(201, import("waiting-for-bundle"))
            }
            ("PUT", path) if path.contains("/org_mine/imports/imp_1/parts/") => {
                let number: u32 = path.rsplit('/').next().unwrap().parse().unwrap();
                let held = parts.lock().unwrap();
                if number != 1 && !held.contains_key(&1) {
                    return json_response(
                        409,
                        serde_json::json!({"code": "IMPORT_MANIFEST_MISSING"}),
                    );
                }
                drop(held);
                let part = &expected[number as usize - 1];
                if hex(&Sha256::digest(&request.body)) != part.sha256 {
                    return json_response(409, serde_json::json!({"code": "IMPORT_PART_MISMATCH"}));
                }
                parts.lock().unwrap().insert(number, request.body.clone());
                json_response(200, import("receiving"))
            }
            ("POST", "/api/v2/organizations/org_mine/imports/imp_1/apply") => {
                if parts.lock().unwrap().len() != expected.len() {
                    return json_response(409, serde_json::json!({"code": "IMPORT_INCOMPLETE"}));
                }
                json_response(202, import("importing"))
            }
            ("GET", "/api/v2/organizations/org_mine/imports/imp_1") => match stops {
                Some(sentence) => {
                    let mut failed = import("failed");
                    failed["error"] = sentence.into();
                    json_response(200, failed)
                }
                None => json_response(200, import("imported")),
            },
            ("GET", "/api/v2/organizations/org_mine/imports/imp_1/verification") => {
                json_response(200, verify.clone())
            }
            _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
        }
    });
    (address, received)
}

struct Bearer;

impl Credentials for Bearer {
    fn header(&self) -> Result<(&'static str, String), String> {
        Ok(("Authorization", "Bearer expired".into()))
    }
    fn after_refused(&self, used: &str) -> Result<(&'static str, String), String> {
        assert_eq!(used, "Bearer expired");
        Ok(("Authorization", format!("Bearer {BEARER}")))
    }
}

/// A computer where every engine command answers, and removing the installation runs the real
/// `uninstall::remove_installation` on a real folder.
struct EngineAnswers {
    home: PathBuf,
    calls: Vec<String>,
}

impl crate::uninstall::Computer for EngineAnswers {
    fn engine(&mut self, _root: &Path) -> Option<crate::engine::Address> {
        Some(crate::engine::Address::new(
            crate::engine::Engine::Docker,
            None,
        ))
    }
    fn compose_down(&mut self, _: &crate::engine::Address, _: &Path) -> Result<(), String> {
        self.calls.push("compose down".into());
        Ok(())
    }
    fn stop_backend(&mut self, _: &crate::engine::Address, _: &Path) -> Result<(), String> {
        self.calls.push("stop backend".into());
        Ok(())
    }
    fn delete_backend(&mut self, _: &crate::engine::Address, _: &Path) -> Result<(), String> {
        self.calls.push("delete backend".into());
        Ok(())
    }
    fn remove_volumes(&mut self, _: &crate::engine::Address, _: &Path) -> Result<(), String> {
        self.calls.push("remove volumes".into());
        Ok(())
    }
    fn remove_images(&mut self, _: &crate::engine::Address, _: &Path) -> Result<(), String> {
        self.calls.push("remove images".into());
        Ok(())
    }
    fn machine(&mut self, _: &str) -> Result<Option<bool>, String> {
        Ok(None)
    }
    fn stop_machine(&mut self, _: &str) -> Result<(), String> {
        unreachable!("no machine of OpenBot's here")
    }
    fn remove_machine(&mut self, _: &str) -> Result<(), String> {
        unreachable!("no machine of OpenBot's here")
    }
    fn stop_containers(&mut self, _: &str) -> Result<(), String> {
        unreachable!("no machine of OpenBot's here")
    }
    fn clear_port_rules(&mut self, _: &str) -> Result<(), String> {
        unreachable!("no machine of OpenBot's here")
    }
    fn remove_installation(&mut self, root: &Path, keep_engine: bool) -> Result<(), String> {
        crate::uninstall::remove_installation(root, Some(&self.home), keep_engine)
    }
}

/// This computer for the move, with the real uninstall: `uninstall::stop_with`, deleting the data,
/// and the footprint measured from the real files it removes.
struct RealHere {
    root: PathBuf,
    computer: EngineAnswers,
    config: PathBuf,
}

impl Here for RealHere {
    fn footprint(&mut self) -> Option<u64> {
        Some(footprint(&crate::uninstall::installation_parts(
            &self.root,
            Some(&self.computer.home),
        )))
    }
    fn moved(&mut self) -> Result<(), String> {
        record_moved(&self.config).map_err(|error| error.to_string())
    }
    fn remove(&mut self) -> Vec<String> {
        crate::uninstall::stop_with(
            &mut self.computer,
            &self.root,
            crate::uninstall::Asked { delete_data: true },
            &mut |_| {},
        )
    }
}

/// An OpenBot (Self-Contained) installation in `home`: the files box I found, a database-sized
/// file, the downloads, and a file of the person's beside it.
fn installation(home: &Path) -> PathBuf {
    let root = home.join("OpenBot");
    for (entry, bytes) in [
        (".openbot-deployment", 10usize),
        (".openbot-prepared.json", 10),
        (".env", 100),
        (".secrets/KEY_ENCRYPTION_KEY.secret", 64),
        ("docker-compose.yml", 2_000),
        ("container-images.json", 500),
        (".logs/openbot.log", 300_000),
        (".copilotkit/local.json", 50),
        ("engine/machine/disk.vhdx", 2_000_000),
        ("openbot-engine/bin/docker-compose", 600_000),
    ] {
        let path = root.join(entry);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![7u8; bytes]).unwrap();
    }
    std::fs::create_dir_all(home.join("Documents")).unwrap();
    std::fs::write(home.join("Documents/notes.txt"), "mine").unwrap();
    root
}

fn real_move(verify: serde_json::Value) -> (Result<Moved, Failure>, PathBuf, PathBuf, Vec<String>) {
    real_move_stopping(verify, None)
}

fn real_move_stopping(
    verify: serde_json::Value,
    stops: Option<&'static str>,
) -> (Result<Moved, Failure>, PathBuf, PathBuf, Vec<String>) {
    let home = crate::test_support::temp_root("move-real");
    let root = installation(&home);
    let parts = bundle(&[70_000, 30_000, 5]);
    let counts = vec![
        count("bots", 3),
        count("conversations", 12),
        count("memories", 4),
    ];
    let local_address = local_openbot(parts.clone(), counts);
    let (cloud_address, received) = cloud_openbot(
        parts.iter().map(|(part, _)| part.clone()).collect(),
        verify,
        stops,
    );
    let mut local = Api::at(
        &local_address,
        Box::new(InstallToken(Some(TOKEN.into()))),
        THIS_COMPUTERS_ORGANIZATION,
    )
    .unwrap();
    let mut cloud = Api::open(&cloud_address, Box::new(Bearer), their_own_organization).unwrap();
    assert_eq!(cloud.organization(), "org_mine");
    let mut here = RealHere {
        root: root.clone(),
        computer: EngineAnswers {
            home: home.clone(),
            calls: Vec::new(),
        },
        config: home.join("config"),
    };
    let outcome = run(
        &mut local,
        &mut cloud,
        &mut here,
        &asked(),
        &mut Steps::default(),
    );
    // Whatever happened, what arrived on Cloud is exactly what left.
    for (number, bytes) in received.lock().unwrap().iter() {
        assert_eq!(bytes, &parts[*number as usize - 1].1);
    }
    (outcome, home, root, here.computer.calls)
}

/// The whole move over HTTP, with the real uninstall: Cloud's check matches, so OpenBot's software
/// and data are removed (the folder, the downloads, the data and software on the engine), the
/// person's own files stay, and the space freed is what those files took.
#[test]
fn a_real_move_removes_the_installation_and_reports_the_space_it_freed() {
    let (outcome, home, root, calls) = real_move(serde_json::json!({
        "importId": "imp_1", "matches": true,
        "kinds": [
            {"kind": "bots", "expected": 3, "found": 3, "leftOut": 0},
            {"kind": "conversations", "expected": 12, "found": 12, "leftOut": 0},
            {"kind": "memories", "expected": 4, "found": 4, "leftOut": 0}
        ],
        "notes": [],
        "reconnect": [{"appId": "gmail", "appName": "Gmail", "accountLabel": "sam@example.com"}]
    }));
    let moved = outcome.unwrap();
    assert!(!root.exists(), "the installation folder is still there");
    assert!(home.join("Documents/notes.txt").exists());
    assert_eq!(answered(&home.join("config")), Some(Answer::Moved));
    assert!(calls.contains(&"remove volumes".to_owned()));
    assert!(calls.contains(&"remove images".to_owned()));
    assert!(moved.left_behind.is_empty(), "{:?}", moved.left_behind);
    // At least the bytes written, as the disk holds them.
    let removed = moved.removed_bytes.unwrap();
    assert!(removed >= 2_902_734, "{removed}");
    assert_eq!(moved.apps[0].app_name, "Gmail");
    let _ = std::fs::remove_dir_all(home);
}

/// The same move over HTTP, but Cloud's check finds a conversation missing: nothing on this
/// computer is touched, and the move isn't kept.
#[test]
fn a_real_move_whose_check_doesnt_match_deletes_nothing() {
    let (outcome, home, root, calls) = real_move(serde_json::json!({
        "importId": "imp_1", "matches": false,
        "kinds": [
            {"kind": "bots", "expected": 3, "found": 3, "leftOut": 0},
            {"kind": "conversations", "expected": 12, "found": 11, "leftOut": 0},
            {"kind": "memories", "expected": 4, "found": 4, "leftOut": 0}
        ],
        "notes": [], "reconnect": []
    }));
    assert_eq!(outcome.unwrap_err().kind(), "move-mismatch");
    assert!(calls.is_empty(), "{calls:?}");
    assert_eq!(answered(&home.join("config")), None);
    for entry in [
        ".env",
        ".secrets/KEY_ENCRYPTION_KEY.secret",
        "engine/machine/disk.vhdx",
        "openbot-engine/bin/docker-compose",
    ] {
        assert!(root.join(entry).exists(), "{entry} was removed");
    }
    let _ = std::fs::remove_dir_all(home);
}

/// OpenBot Cloud's sentence for a conversation that has new messages here and was carried on there
/// since an earlier move: it won't overwrite it, so trying again stops the same way.
const CARRIED_ON: &str = "\"Field Researcher\" has new messages on your computer, and was also carried on in OpenBot Cloud. OpenBot won't overwrite what was said in OpenBot Cloud, so the new messages can't move.";
/// Its sentence for a conversation a Bot is answering there right now.
const BEING_ANSWERED: &str = "\"Field Researcher\" is being answered in OpenBot Cloud right now. Start the move again once it's done.";

/// The move over HTTP, where OpenBot Cloud stops the import and says why in its own sentence: the
/// person reads that sentence, not a line telling them to try again in a moment, which can't get
/// past a conversation OpenBot Cloud won't overwrite. Nothing on this computer is touched.
/// Seen on 2026-11-22: Desktop said "Try again in a moment" and only logged Cloud's reason.
#[test]
fn a_move_cloud_stops_for_a_reason_says_that_reason() {
    for sentence in [CARRIED_ON, BEING_ANSWERED] {
        let (outcome, home, root, calls) =
            real_move_stopping(serde_json::json!({"matches": true}), Some(sentence));
        let failure = outcome.unwrap_err();
        assert_eq!(failure.said(), sentence);
        assert_eq!(failure.kind(), "move-stopped");
        assert!(calls.is_empty(), "{calls:?}");
        assert_eq!(answered(&home.join("config")), None);
        assert!(root.join("engine/machine/disk.vhdx").exists());
        let _ = std::fs::remove_dir_all(home);
    }
}

/// An import that stopped part way, which OpenBot Cloud says to apply again: Desktop applied it
/// again already, so the person reads Desktop's own line, and trying again in a moment is right.
#[test]
fn a_move_whose_import_only_stopped_part_way_says_try_again() {
    let (outcome, home, _root, calls) =
        real_move_stopping(serde_json::json!({"matches": true}), Some(PASSING));
    let failure = outcome.unwrap_err();
    assert_eq!(
        failure.said(),
        "OpenBot Cloud couldn't add everything to your account. Try again in a moment."
    );
    assert_eq!(failure.kind(), "move-failed");
    assert!(failure.detail().contains(PASSING), "{}", failure.detail());
    assert!(calls.is_empty(), "{calls:?}");
    let _ = std::fs::remove_dir_all(home);
}

/// OpenBot Cloud's answer about the person's own AI (`getPersonalAiConnection`), as the API says it
/// answers: `uses` and `required` beside the connection itself.
fn personal_ai(uses: &str, required: bool) -> serde_json::Value {
    serde_json::json!({
        "connection": {"configured": uses == "personal"},
        "organization": {"configured": uses == "organization"},
        "uses": uses,
        "required": required,
        "available": true,
        "signIns": ["openai", "anthropic"],
    })
}

/**
Seen on 1.2.0-rc.1: the move's result offered only Reconnect, and OpenBot Cloud sent the person to
Connect your AI instead. After the move, Cloud is asked whether the person still needs an AI, in
their own organization, and only "required, and nothing to run on" says they do.
*/
#[test]
fn after_the_move_cloud_is_asked_whether_the_person_still_needs_an_ai() {
    for (answer, needs) in [
        (personal_ai("none", true), true),
        (personal_ai("personal", true), false),
        (personal_ai("organization", true), false),
        // A self-hosted OpenBot never requires one.
        (personal_ai("none", false), false),
        // A value a later server adds is not "none".
        (personal_ai("shared", true), false),
    ] {
        let said = answer.to_string();
        let address = serve(move |request| {
            if request.headers.get("authorization").map(String::as_str)
                != Some(&format!("Bearer {BEARER}"))
            {
                return json_response(401, serde_json::json!({"code": "UNAUTHENTICATED"}));
            }
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v2/people/me/organizations") => json_response(
                    200,
                    serde_json::json!({"organizations": [
                        {"id": "org_mine", "slug": "sam", "name": "Sam", "role": "owner", "active": true, "personal": true}
                    ], "canCreate": true, "nextCursor": null}),
                ),
                ("GET", "/api/v2/organizations/org_mine/people/me/ai-connection") => {
                    json_response(200, answer.clone())
                }
                _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
            }
        });
        let cloud = Api::open(&address, Box::new(Bearer), their_own_organization).unwrap();
        assert_eq!(cloud.needs_ai_connection(), Ok(needs), "{said}");
    }

    // A Cloud that can't say is an error the move logs, never a yes or a no.
    let address = serve(|request| match request.path.as_str() {
        "/api/v2/people/me/organizations" => json_response(
            200,
            serde_json::json!({"organizations": [{"id": "org_mine", "personal": true}]}),
        ),
        _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
    });
    let cloud = Api::open(&address, Box::new(Bearer), their_own_organization).unwrap();
    assert!(cloud.needs_ai_connection().is_err());
}

/**
Seen on 1.2.0-rc.3: after a move the person couldn't tell where OpenBot Cloud was or which account
held their Bots, and signed up again on my.open.bot. After the move, Cloud is asked who signed in, in
the organization the move went into, and the result names the address, the email and the
organization.
*/
#[test]
fn after_the_move_cloud_is_asked_which_account_it_went_into() {
    let address = serve(|request| {
        if request.headers.get("authorization").map(String::as_str)
            != Some(&format!("Bearer {BEARER}"))
        {
            return json_response(401, serde_json::json!({"code": "UNAUTHENTICATED"}));
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v2/people/me/organizations") => json_response(
                200,
                serde_json::json!({"organizations": [
                    {"id": "org_team", "slug": "acme", "name": "Acme", "role": "member", "active": false, "personal": false},
                    {"id": "org_mine", "slug": "sam", "name": " Sam's organization ", "role": "owner", "active": true, "personal": true}
                ], "canCreate": true, "nextCursor": null}),
            ),
            ("GET", "/api/v2/organizations/org_mine/people/me") => json_response(
                200,
                serde_json::json!({"person": {"id": "per_1", "email": "sam@example.com", "name": "Sam", "role": "owner"}}),
            ),
            _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
        }
    });
    let cloud = Api::open(&address, Box::new(Bearer), their_own_organization).unwrap();
    assert_eq!(
        cloud.account(),
        Ok(CloudAccount {
            email: "sam@example.com".into(),
            organization: Some("Sam's organization".into()),
        })
    );

    // A Cloud that can't say is an error the move logs, and the result says the move without it.
    let address = serve(|request| match request.path.as_str() {
        "/api/v2/people/me/organizations" => json_response(
            200,
            serde_json::json!({"organizations": [{"id": "org_mine", "personal": true}]}),
        ),
        _ => json_response(404, serde_json::json!({"code": "NOT_FOUND"})),
    });
    let cloud = Api::open(&address, Box::new(Bearer), their_own_organization).unwrap();
    assert!(cloud.account().is_err());
}
