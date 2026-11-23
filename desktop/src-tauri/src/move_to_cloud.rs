/*!
Moving OpenBot (Self-Contained) to OpenBot Cloud: everything a person has in the OpenBot on their
own computer brought into their organization on OpenBot Cloud, checked there, and only then
OpenBot's software and data on this computer removed.

THE ORDER, as the API's "Moving to OpenBot Cloud" area lays it out (`api/openapi/moves.yaml`):
1. Cloud: `createImport`, whose answer carries the public key a model key is sealed to.
2. Here: `createExport` (sealing the model key to that key when the person brings it), then
   `getExport` until it is ready. Its counts by kind are what the move is checked against.
3. Each part: `downloadExportPart` here, its SHA-256 checked, then `uploadImportPart` on Cloud,
   part 1 first. A dropped download resumes with Range; a part Cloud already has is a no-op.
4. Cloud: `applyImport`, then `getImport` until it is imported.
5. Cloud: `getImportVerification`. It must say `matches`, and for every kind the export counted,
   what Cloud found plus what it left out on purpose must be at least what the export held.
6. Only then is the move kept (`Here::moved`: the answer recorded, the app switched to Cloud), and
   OpenBot removed from this computer (`Here::remove`), measured before and after.

NOTHING IS REMOVED UNLESS STEP 5 PASSED. Every failure before it returns a `Failure` and leaves this
computer exactly as it was; running the move again starts a new import, which Cloud makes safe to
repeat (an import of the same OpenBot adds only what isn't there yet). A failure while removing,
after the move was kept, is said in plain words (`Moved::left_behind`) and is not a failed move.

App connections never move: their sign-ins stay on this computer. The export lists them
(`ReconnectApp`), and the person connects each one again on Cloud.
*/

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The file in the app's configuration folder that keeps the person's answer.
pub const FILE: &str = "move-to-cloud.json";

/// What the person answered when Desktop offered the move.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Answer {
    /// "Keep OpenBot (Self-Contained)": never offered again at launch. Settings still offers it.
    Kept,
    /// Moved, and checked on Cloud. Never offered again anywhere.
    Moved,
}

#[derive(Serialize, Deserialize)]
struct Recorded {
    answer: Answer,
}

/// The answer on record in `config_dir`, if any. A file that can't be read is no answer.
pub fn answered(config_dir: &Path) -> Option<Answer> {
    let bytes = std::fs::read(config_dir.join(FILE)).ok()?;
    serde_json::from_slice::<Recorded>(&bytes)
        .ok()
        .map(|recorded| recorded.answer)
}

/// Keep `answer` in `config_dir`, written whole or not at all.
pub fn record(config_dir: &Path, answer: Answer) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join(FILE);
    let partial = config_dir.join(format!("{FILE}.partial"));
    std::fs::write(&partial, serde_json::to_vec(&Recorded { answer })?)?;
    std::fs::rename(&partial, &path)
}

/**
Whether the setup window offers the move when it is about to show OpenBot: once per person, after
the update, for OpenBot (Self-Contained) only.

- `cloud`: this build offers OpenBot Cloud at all (the setup page's own switch).
- `connected`: the app is connected to an OpenBot that runs elsewhere (OpenBot Cloud, or a
  company's): there is nothing here to move.
- `installed_here`: an OpenBot is set up on this computer.
- `answer`: what the person said before. Any answer ends the offer at launch.
*/
pub fn due(cloud: bool, connected: bool, installed_here: bool, answer: Option<Answer>) -> bool {
    cloud && !connected && installed_here && answer.is_none()
}

/// Whether Settings may offer the move: as `due`, but a person who kept Self-Contained may still.
pub fn offered_in_settings(cloud: bool, connected: bool, answer: Option<Answer>) -> bool {
    cloud && !connected && answer != Some(Answer::Moved)
}

// ------------------------------------------------------------------------------------------------
// What the API answers. Only the fields the move reads; anything else is passed over.

/// How many of one kind of thing move. A kind this app doesn't know is counted like any other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Count {
    pub kind: String,
    pub count: u64,
}

/// A connection to an app that doesn't move: the person connects it again on Cloud.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectApp {
    pub app_id: String,
    pub app_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bot_names: Vec<String>,
}

/// `getExportEstimate`: what an export would hold, read before the person decides.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub counts: Vec<Count>,
    #[serde(default)]
    pub stored_bytes: u64,
    #[serde(default)]
    pub reconnect: Vec<ReconnectApp>,
    #[serde(default)]
    pub model_keys_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Part {
    pub number: u32,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default)]
    pub counts: Vec<Count>,
    #[serde(default)]
    pub reconnect: Vec<ReconnectApp>,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Note {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub recipient_key: Option<serde_json::Value>,
    #[serde(default)]
    pub received_parts: Vec<u32>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedKind {
    pub kind: String,
    pub expected: u64,
    pub found: u64,
    #[serde(default)]
    pub left_out: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Verification {
    pub matches: bool,
    #[serde(default)]
    pub kinds: Vec<VerifiedKind>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub reconnect: Vec<ReconnectApp>,
}

// ------------------------------------------------------------------------------------------------
// The two OpenBots, as the move asks them.

/// The OpenBot on this computer: where the export is made.
pub trait Local {
    fn estimate(&mut self) -> Result<Estimate, String>;
    /// `createExport`. `recipient_key` is Cloud's, when the model key comes along.
    fn create_export(
        &mut self,
        recipient_key: Option<&serde_json::Value>,
    ) -> Result<Export, String>;
    fn export(&mut self, id: &str) -> Result<Export, String>;
    /// `downloadExportPart`, from `from` bytes on: the bytes that came, which may be fewer than
    /// asked when the connection dropped.
    fn download(&mut self, id: &str, part: u32, from: u64) -> Result<Vec<u8>, String>;
}

/// OpenBot Cloud: where the import is made and checked.
pub trait Cloud {
    fn create_import(&mut self, source_name: &str) -> Result<Import, String>;
    fn upload(&mut self, id: &str, part: u32, bytes: &[u8]) -> Result<Import, String>;
    fn apply(&mut self, id: &str) -> Result<Import, String>;
    fn import(&mut self, id: &str) -> Result<Import, String>;
    fn verification(&mut self, id: &str) -> Result<Verification, String>;
}

/// This computer, once the move has arrived and been checked.
pub trait Here {
    /// What OpenBot takes on this computer now, in bytes, when it can be measured: by the rule the
    /// move screens' estimate uses, over the same paths before and after (`Footprint`).
    fn footprint(&mut self) -> Option<u64>;
    /// The move is kept: the answer recorded and the app pointed at Cloud, before anything goes,
    /// so a removal cut short never offers the move again.
    fn moved(&mut self) -> Result<(), String>;
    /// OpenBot's software and data removed from this computer. What couldn't be, in plain words.
    fn remove(&mut self) -> Vec<String>;
    /// The space free on the disk OpenBot is on, when the system says.
    fn free_space(&mut self) -> Option<u64> {
        None
    }
}

/**
What the move removed of OpenBot's files: what they took before the removal, less what is still
there after, measured by the rule the move screens' estimate uses (`footprint`, over the same
paths: `Footprint`). So the result counts what the estimate counted.
*/
pub fn removed(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    before.map(|before| before.saturating_sub(after.unwrap_or(0)))
}

/**
How much more space the disk says is free after the removal than before, when it says, and when
that grew at all (another program writing meanwhile can shrink it).

This is not the same figure as `removed`, and is never put in its place. On a Mac with Apple
silicon (1.2.0-rc.1, Podman 6.1.4, OpenBot's machine on a 60 GB sparse disk) the move screen said
"Frees about 20.2 GB" and the result, then the smaller of the two, said "4.5 GB freed": the files
were all gone, and the disk gained 4.5 GB at once. That is about what OpenBot wrote in the minutes
before the move (the log's free-space lines), which is what deleting frees when a local snapshot
of the disk was taken just before: the snapshot keeps the older blocks until the system lets it
go. On two Windows boxes the files measured 12.2 and 12.0 GB while the disk gained 11.4 and
10.8 GB.
*/
pub fn disk_gained(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    match (before, after) {
        (Some(before), Some(after)) if after > before => Some(after - before),
        _ => None,
    }
}

/**
OpenBot's footprint on this computer, measured over the same paths each time: the paths are found
once, at the first measure, and the measure after the removal reads those same paths. Found again,
a machine whose removal failed would no longer be found (its engine no longer names it), and its
disk would count as removed while it is still there.
*/
#[derive(Default)]
pub struct Footprint {
    parts: Option<Vec<PathBuf>>,
}

impl Footprint {
    /// What the parts take now, finding them with `find` the first time. None when nothing is there
    /// to measure the first time.
    pub fn measure(&mut self, find: impl FnOnce() -> Vec<PathBuf>) -> Option<u64> {
        let parts = self.parts.get_or_insert_with(find);
        let total = footprint(parts);
        (total > 0 || !parts.is_empty()).then_some(total)
    }
}

/// The move's steps, for the setup window's progress rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    SignIn,
    Export,
    Upload,
    Import,
    Verify,
    Remove,
}

/// What a step reports: started, how far (0 to 1) when it knows, or done.
pub trait Progress {
    fn running(&mut self, stage: Stage, progress: Option<f64>);
    fn done(&mut self, stage: Stage);
}

/// Why the move didn't happen. Nothing on this computer was removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Packing up, sending, or importing stopped. `detail` is for the log.
    Failed { stage: Stage, detail: String },
    /**
    Cloud stopped the import and said why, in a sentence the person reads (`Import.error`): a
    conversation carried on in OpenBot Cloud that it won't overwrite, or one a Bot is answering
    there now. The window shows that sentence as it is. Trying again in a moment doesn't get past
    it, so the window doesn't say to.
    */
    Stopped { said: String },
    /// Cloud has the import, but not everything in it: what was short, for the log.
    Mismatch { detail: String },
}

/**
The reason in a failed import's own sentence, when it gives one. None when there is no sentence,
or when it only asks to apply again: the import stopped part way, the move applied it again
already, and Desktop's own line (try again in a moment) is the right one.
*/
pub fn reason_of(error: Option<&str>) -> Option<&str> {
    error
        .map(str::trim)
        .filter(|said| !said.is_empty() && !said.contains("Apply again"))
}

impl Failure {
    /// The sentence the setup window shows. Nothing was removed, which the window says too.
    pub fn said(&self) -> &str {
        match self {
            Failure::Stopped { said } => said,
            Failure::Failed {
                stage: Stage::Export,
                ..
            } => "OpenBot couldn't pack up your Bots and conversations on this computer. Try again.",
            Failure::Failed {
                stage: Stage::Upload,
                ..
            } => "OpenBot couldn't send everything to OpenBot Cloud. Check your internet connection and try again.",
            Failure::Failed { .. } => "OpenBot Cloud couldn't add everything to your account. Try again in a moment.",
            Failure::Mismatch { .. } => "Some of your things didn't arrive in OpenBot Cloud, so OpenBot stays on this computer. Try again.",
        }
    }

    /// The kind the setup window tells apart.
    pub fn kind(&self) -> &'static str {
        match self {
            Failure::Failed { .. } => "move-failed",
            Failure::Stopped { .. } => "move-stopped",
            Failure::Mismatch { .. } => "move-mismatch",
        }
    }

    /// For the log. Cloud's own sentence is the whole of what it said.
    pub fn detail(&self) -> &str {
        match self {
            Failure::Failed { detail, .. } | Failure::Mismatch { detail } => detail,
            Failure::Stopped { said } => said,
        }
    }
}

/// The move, done and checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    /// What the move removed of OpenBot's files, counted as the move screens' estimate counts them
    /// (`removed`), when it could be measured.
    pub removed_bytes: Option<u64>,
    /// How much more free space the disk showed right after (`disk_gained`). Less than
    /// `removed_bytes` when the system holds on to deleted files for a while.
    pub disk_gained_bytes: Option<u64>,
    /// The apps to connect again on Cloud.
    pub apps: Vec<ReconnectApp>,
    /// What Cloud brought in differently, in its own sentences.
    pub notes: Vec<String>,
    /// What of OpenBot couldn't be removed from this computer.
    pub left_behind: Vec<String>,
    /// Whether OpenBot Cloud still needs the person's AI before their Bots can run
    /// (`Api::needs_ai_connection`), asked once the move is done. None when it couldn't be asked.
    pub connect_ai: Option<bool>,
}

/// How long the move waits on each side, and how often it asks.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub export: Duration,
    pub import: Duration,
    pub poll: Duration,
    /// Tries for one part: a drop or a damaged part is fetched and sent again.
    pub part_tries: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            export: Duration::from_secs(60 * 60),
            import: Duration::from_secs(60 * 60),
            poll: Duration::from_secs(1),
            part_tries: 4,
        }
    }
}

/// Everything the move needs to be told.
pub struct Asked<'a> {
    pub include_model_keys: bool,
    pub source_name: &'a str,
    pub limits: Limits,
}

/**
The move: export here, import on Cloud, check it there, and only then remove OpenBot from this
computer. See the module's documentation for the order and what each failure leaves.
*/
pub fn run(
    local: &mut dyn Local,
    cloud: &mut dyn Cloud,
    here: &mut dyn Here,
    asked: &Asked,
    progress: &mut dyn Progress,
) -> Result<Moved, Failure> {
    let failed = |stage: Stage| move |detail: String| Failure::Failed { stage, detail };

    // 1. The import on Cloud first: its key seals the model key in the export.
    progress.running(Stage::Export, Some(0.0));
    let import = cloud
        .create_import(asked.source_name)
        .map_err(failed(Stage::Upload))?;
    let recipient_key = asked
        .include_model_keys
        .then_some(import.recipient_key.as_ref())
        .flatten();

    // 2. The export here, until it is ready.
    let started = local
        .create_export(recipient_key)
        .map_err(failed(Stage::Export))?;
    let export = wait_for_export(local, &started.id, asked.limits, progress)?;
    progress.done(Stage::Export);

    // 3. Every part across, part 1 first: it carries the manifest.
    progress.running(Stage::Upload, Some(0.0));
    let mut parts = export.parts.clone();
    parts.sort_by_key(|part| part.number);
    if parts.is_empty() {
        return Err(Failure::Failed {
            stage: Stage::Export,
            detail: "the export was ready with no parts".into(),
        });
    }
    let total: u64 = parts.iter().map(|part| part.bytes).sum::<u64>().max(1);
    let mut sent = 0u64;
    for part in &parts {
        send_part(local, cloud, &export.id, &import.id, part, asked.limits)?;
        sent += part.bytes;
        progress.running(Stage::Upload, Some(sent as f64 / total as f64));
    }
    progress.done(Stage::Upload);

    // 4. Cloud imports it.
    progress.running(Stage::Import, None);
    wait_for_import(cloud, &import.id, asked.limits)?;
    progress.done(Stage::Import);

    // 5. Checked against what Cloud now holds, and against the export's own counts.
    progress.running(Stage::Verify, None);
    let verification = cloud
        .verification(&import.id)
        .map_err(failed(Stage::Verify))?;
    if let Some(short) = short_of(&export.counts, &verification) {
        return Err(Failure::Mismatch { detail: short });
    }
    progress.done(Stage::Verify);

    // 6. Kept, then removed. From here on the move has happened, whatever removing leaves.
    progress.running(Stage::Remove, None);
    here.moved().map_err(failed(Stage::Verify))?;
    let before = here.footprint();
    let free_before = here.free_space();
    let left_behind = here.remove();
    let after = here.footprint();
    let free_after = here.free_space();
    progress.done(Stage::Remove);

    let apps = if verification.reconnect.is_empty() {
        export.reconnect
    } else {
        verification.reconnect
    };
    Ok(Moved {
        removed_bytes: removed(before, after),
        disk_gained_bytes: disk_gained(free_before, free_after),
        apps,
        notes: verification
            .notes
            .into_iter()
            .map(|note| note.message)
            .collect(),
        left_behind,
        connect_ai: None,
    })
}

/**
What Cloud is short of, or None when everything is there: Cloud must say `matches`, and for every
kind the export counted, what Cloud found plus what it left out on purpose must reach the export's
own count. A kind the export counted that Cloud doesn't list at all is short.
*/
pub fn short_of(exported: &[Count], verification: &Verification) -> Option<String> {
    let mut short = Vec::new();
    if !verification.matches {
        short.push("OpenBot Cloud's check didn't match".to_owned());
    }
    for count in exported.iter().filter(|count| count.count > 0) {
        let there = verification
            .kinds
            .iter()
            .find(|kind| kind.kind == count.kind)
            .map(|kind| kind.found + kind.left_out)
            .unwrap_or(0);
        if there < count.count {
            short.push(format!("{}: {there} of {}", count.kind, count.count));
        }
    }
    (!short.is_empty()).then(|| short.join("; "))
}

fn wait_for_export(
    local: &mut dyn Local,
    id: &str,
    limits: Limits,
    progress: &mut dyn Progress,
) -> Result<Export, Failure> {
    let deadline = Instant::now() + limits.export;
    loop {
        let export = local.export(id).map_err(|detail| Failure::Failed {
            stage: Stage::Export,
            detail,
        })?;
        match export.status.as_str() {
            "ready" => return Ok(export),
            "failed" => {
                return Err(Failure::Failed {
                    stage: Stage::Export,
                    detail: export.error.unwrap_or_else(|| "the export failed".into()),
                })
            }
            // `preparing`, and any status a later OpenBot adds.
            _ => progress.running(Stage::Export, export.progress),
        }
        if Instant::now() >= deadline {
            return Err(Failure::Failed {
                stage: Stage::Export,
                detail: format!("the export wasn't ready after {:?}", limits.export),
            });
        }
        std::thread::sleep(limits.poll);
    }
}

/// One part: downloaded (resuming a drop), its digest checked, and uploaded. Tried again whole
/// when the bytes don't match or Cloud refuses them as damaged.
fn send_part(
    local: &mut dyn Local,
    cloud: &mut dyn Cloud,
    export: &str,
    import: &str,
    part: &Part,
    limits: Limits,
) -> Result<(), Failure> {
    let mut last = String::new();
    for _ in 0..limits.part_tries.max(1) {
        let bytes = match download_whole(local, export, part, limits.part_tries) {
            Ok(bytes) => bytes,
            Err(detail) => {
                last = detail;
                continue;
            }
        };
        match cloud.upload(import, part.number, &bytes) {
            Ok(_) => return Ok(()),
            Err(detail) => last = detail,
        }
    }
    Err(Failure::Failed {
        stage: Stage::Upload,
        detail: format!("part {}: {last}", part.number),
    })
}

/// A part's bytes, resumed from where a drop left them, checked against its size and SHA-256.
fn download_whole(
    local: &mut dyn Local,
    export: &str,
    part: &Part,
    tries: u32,
) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::with_capacity(part.bytes as usize);
    let mut stalls = 0;
    while (bytes.len() as u64) < part.bytes {
        match local.download(export, part.number, bytes.len() as u64) {
            Ok(more) if !more.is_empty() => bytes.extend_from_slice(&more),
            Ok(_) | Err(_) if stalls + 1 < tries.max(1) => stalls += 1,
            Ok(_) => return Err(format!("part {} stopped arriving", part.number)),
            Err(error) => return Err(error),
        }
    }
    if bytes.len() as u64 != part.bytes {
        return Err(format!(
            "part {} is {} bytes, not {}",
            part.number,
            bytes.len(),
            part.bytes
        ));
    }
    let digest = hex(&Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(&part.sha256) {
        return Err(format!("part {} arrived damaged", part.number));
    }
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn wait_for_import(cloud: &mut dyn Cloud, id: &str, limits: Limits) -> Result<(), Failure> {
    let failed = |detail: String| Failure::Failed {
        stage: Stage::Import,
        detail,
    };
    let deadline = Instant::now() + limits.import;
    // Applying a failed import goes on from where it stopped: once more, then it is a failure.
    let mut applies = 0;
    let mut import = cloud.apply(id).map_err(failed)?;
    loop {
        match import.status.as_str() {
            "imported" => return Ok(()),
            "failed" if applies >= 1 => {
                if let Some(said) = reason_of(import.error.as_deref()) {
                    return Err(Failure::Stopped {
                        said: said.to_owned(),
                    });
                }
                return Err(failed(
                    import.error.unwrap_or_else(|| "the import failed".into()),
                ));
            }
            "failed" => {
                applies += 1;
                import = cloud.apply(id).map_err(failed)?;
                continue;
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(failed(format!(
                "the import hadn't finished after {:?}",
                limits.import
            )));
        }
        std::thread::sleep(limits.poll);
        import = cloud.import(id).map_err(failed)?;
    }
}

// ------------------------------------------------------------------------------------------------
// The two OpenBots over HTTP.

/// How a request proves it is the person's.
pub trait Credentials: Send + Sync {
    /// The header to send, by name.
    fn header(&self) -> Result<(&'static str, String), String>;
    /// After a 401 for `used`: a fresh value to send once more, or Err when there is none.
    fn after_refused(&self, used: &str) -> Result<(&'static str, String), String>;
}

/// An OpenBot's API, in one organization.
pub struct Api {
    base: String,
    organization: String,
    credentials: Box<dyn Credentials>,
    client: reqwest::blocking::Client,
}

/// A request's answer: its status and its body, read whole.
struct Answered {
    status: u16,
    body: Vec<u8>,
    retry_after: Option<u64>,
}

/// The organization OpenBot (Self-Contained) answers for: it has one, and the API names it
/// `default`. Its server doesn't list the caller's organizations, which needs the sign-in an
/// organization-keeping OpenBot has (box A: `/api/v2/people/me/organizations` answered 404).
pub const THIS_COMPUTERS_ORGANIZATION: &str = "default";

impl Api {
    /// The API at `base`, in the organization `organization` (an id or a slug).
    pub fn at(
        base: &str,
        credentials: Box<dyn Credentials>,
        organization: &str,
    ) -> Result<Api, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(crate::client_version::headers())
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Api {
            base: base.trim_end_matches('/').to_owned(),
            organization: organization.to_owned(),
            credentials,
            client,
        })
    }

    /// The API at `base`, in the organization `pick` chooses from the caller's own list.
    pub fn open(
        base: &str,
        credentials: Box<dyn Credentials>,
        pick: fn(&[Organization]) -> Option<String>,
    ) -> Result<Api, String> {
        let mut api = Api::at(base, credentials, "")?;
        let page: OrganizationPage = api.json(
            reqwest::Method::GET,
            "/api/v2/people/me/organizations",
            None,
        )?;
        api.organization = pick(&page.organizations)
            .ok_or_else(|| "the caller belongs to no organization there".to_owned())?;
        Ok(api)
    }

    pub fn organization(&self) -> &str {
        &self.organization
    }

    fn in_organization(&self, path: &str) -> String {
        format!("/api/v2/organizations/{}{path}", self.organization)
    }

    /// Whether the person still has to connect their AI here before their Bots can run
    /// (`getPersonalAiConnection`, read as `PersonalAi::needs_connecting` reads it).
    pub fn needs_ai_connection(&self) -> Result<bool, String> {
        let personal: PersonalAi = self.json(
            reqwest::Method::GET,
            &self.in_organization("/people/me/ai-connection"),
            None,
        )?;
        Ok(personal.needs_connecting())
    }

    fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        build: &dyn Fn(reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder,
    ) -> Result<Answered, String> {
        let url = format!("{}{path}", self.base);
        let mut header = self.credentials.header()?;
        let mut refused_once = false;
        let mut throttled = 0;
        loop {
            let request = build(
                self.client
                    .request(method.clone(), &url)
                    .header(header.0, &header.1),
            );
            let response = request
                .send()
                .map_err(|error| format!("{method} {path}: {error}"))?;
            let status = response.status().as_u16();
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            let mut body = Vec::new();
            response
                .take(64 * 1024 * 1024)
                .read_to_end(&mut body)
                .map_err(|error| format!("{method} {path}: {error}"))?;
            if status == 401 && !refused_once {
                refused_once = true;
                header = self.credentials.after_refused(&header.1)?;
                continue;
            }
            if status == 429 && throttled < 5 {
                throttled += 1;
                std::thread::sleep(Duration::from_secs(retry_after.unwrap_or(5).min(60)));
                continue;
            }
            return Ok(Answered {
                status,
                body,
                retry_after,
            });
        }
    }

    fn json<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, String> {
        let idempotent = method == reqwest::Method::POST;
        let key = idempotency_key();
        let answered = self.send(method.clone(), path, &|request| {
            let request = if idempotent {
                request.header("Idempotency-Key", &key)
            } else {
                request
            };
            match &body {
                Some(body) => request.json(body),
                None => request,
            }
        })?;
        parse(&method, path, answered)
    }
}

fn parse<T: serde::de::DeserializeOwned>(
    method: &reqwest::Method,
    path: &str,
    answered: Answered,
) -> Result<T, String> {
    if !(200..300).contains(&answered.status) {
        return Err(refusal(method, path, &answered));
    }
    serde_json::from_slice(&answered.body)
        .map_err(|error| format!("{method} {path}: the answer wasn't what was expected ({error})"))
}

/// A refusal, for the log: the status and the problem's code and detail, never a body that could
/// hold anything else.
fn refusal(method: &reqwest::Method, path: &str, answered: &Answered) -> String {
    #[derive(Deserialize)]
    struct Problem {
        code: Option<String>,
        detail: Option<String>,
    }
    let problem = serde_json::from_slice::<Problem>(&answered.body).ok();
    let code = problem
        .as_ref()
        .and_then(|problem| problem.code.clone())
        .unwrap_or_default();
    let detail = problem
        .and_then(|problem| problem.detail)
        .unwrap_or_default();
    let wait = answered
        .retry_after
        .map(|seconds| format!(" (retry after {seconds}s)"))
        .unwrap_or_default();
    format!(
        "{method} {path} answered {} {code} {detail}{wait}",
        answered.status
    )
    .trim()
    .to_owned()
}

fn idempotency_key() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::rng().random();
    hex(&bytes)
}

/// The person's own AI connection, as far as the move reads it (`PersonalAiConnection`).
#[derive(Clone, Debug, Deserialize)]
pub struct PersonalAi {
    /// The AI their next run uses: `personal`, `organization`, or `none`.
    pub uses: String,
    /// Whether they must have an AI before they use OpenBot (true on OpenBot Cloud).
    pub required: bool,
}

impl PersonalAi {
    /// The server's two verdicts, never recomputed: required, and nothing to run on yet. The same
    /// rule as the web app's `needsAiConnection`.
    pub fn needs_connecting(&self) -> bool {
        self.required && self.uses == "none"
    }
}

/// One organization in the caller's list.
#[derive(Clone, Debug, Deserialize)]
pub struct Organization {
    pub id: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub personal: bool,
}

#[derive(Deserialize)]
struct OrganizationPage {
    organizations: Vec<Organization>,
}

/// On Cloud: the person's own organization, the one Cloud made for them.
pub fn their_own_organization(list: &[Organization]) -> Option<String> {
    list.iter()
        .find(|organization| organization.personal)
        .or_else(|| list.iter().find(|organization| organization.active))
        .or_else(|| list.first())
        .map(|organization| organization.id.clone())
}

impl Local for Api {
    fn estimate(&mut self) -> Result<Estimate, String> {
        self.json(
            reqwest::Method::GET,
            &self.in_organization("/export-estimate"),
            None,
        )
    }

    fn create_export(
        &mut self,
        recipient_key: Option<&serde_json::Value>,
    ) -> Result<Export, String> {
        let body = match recipient_key {
            Some(key) => serde_json::json!({ "includeModelKeys": true, "recipientKey": key }),
            None => serde_json::json!({ "includeModelKeys": false }),
        };
        self.json(
            reqwest::Method::POST,
            &self.in_organization("/exports"),
            Some(body),
        )
    }

    fn export(&mut self, id: &str) -> Result<Export, String> {
        self.json(
            reqwest::Method::GET,
            &self.in_organization(&format!("/exports/{id}")),
            None,
        )
    }

    fn download(&mut self, id: &str, part: u32, from: u64) -> Result<Vec<u8>, String> {
        let path = self.in_organization(&format!("/exports/{id}/parts/{part}"));
        let answered = self.send(reqwest::Method::GET, &path, &|request| {
            if from > 0 {
                request.header(reqwest::header::RANGE, format!("bytes={from}-"))
            } else {
                request
            }
        })?;
        match answered.status {
            200 if from == 0 => Ok(answered.body),
            206 => Ok(answered.body),
            // Asked for a range and given the whole part: what was asked for is in it.
            200 => Ok(answered
                .body
                .get(from as usize..)
                .map(<[u8]>::to_vec)
                .unwrap_or_default()),
            _ => Err(refusal(&reqwest::Method::GET, &path, &answered)),
        }
    }
}

impl Cloud for Api {
    fn create_import(&mut self, source_name: &str) -> Result<Import, String> {
        let name: String = source_name.chars().take(200).collect();
        let body = (!name.trim().is_empty()).then(|| serde_json::json!({ "sourceName": name }));
        self.json(
            reqwest::Method::POST,
            &self.in_organization("/imports"),
            Some(body.unwrap_or_else(|| serde_json::json!({}))),
        )
    }

    fn upload(&mut self, id: &str, part: u32, bytes: &[u8]) -> Result<Import, String> {
        let path = self.in_organization(&format!("/imports/{id}/parts/{part}"));
        let key = idempotency_key();
        let answered = self.send(reqwest::Method::PUT, &path, &|request| {
            request
                .header("Idempotency-Key", &key)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(bytes.to_vec())
        })?;
        parse(&reqwest::Method::PUT, &path, answered)
    }

    fn apply(&mut self, id: &str) -> Result<Import, String> {
        self.json(
            reqwest::Method::POST,
            &self.in_organization(&format!("/imports/{id}/apply")),
            None,
        )
    }

    fn import(&mut self, id: &str) -> Result<Import, String> {
        self.json(
            reqwest::Method::GET,
            &self.in_organization(&format!("/imports/{id}")),
            None,
        )
    }

    fn verification(&mut self, id: &str) -> Result<Verification, String> {
        self.json(
            reqwest::Method::GET,
            &self.in_organization(&format!("/imports/{id}/verification")),
            None,
        )
    }
}

/// The install's own token, which the OpenBot on this computer admits as the person
/// (`install_token`). One from before the token admits the request without it.
pub struct InstallToken(pub Option<String>);

impl Credentials for InstallToken {
    fn header(&self) -> Result<(&'static str, String), String> {
        Ok((
            crate::install_token::HEADER,
            self.0.clone().unwrap_or_default(),
        ))
    }

    fn after_refused(&self, _used: &str) -> Result<(&'static str, String), String> {
        Err("the OpenBot on this computer didn't accept its own token".into())
    }
}

// ------------------------------------------------------------------------------------------------
// How much OpenBot takes on this computer.

/**
The space `paths` take on disk, each counted once: a folder with everything in it, never following
a link (a link counts as itself). What the disk holds for a file, not its length, where the system
says (a machine's disk image is sparse, and its length overstates it many times).
*/
pub fn footprint(paths: &[PathBuf]) -> u64 {
    let mut sorted: Vec<&PathBuf> = paths.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut counted: Vec<&PathBuf> = Vec::new();
    let mut total = 0;
    for path in sorted {
        if counted.iter().any(|outer| path.starts_with(outer)) {
            continue;
        }
        total += on_disk(path);
        counted.push(path);
    }
    total
}

fn on_disk(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_dir() {
        std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|entry| on_disk(&entry.path())).sum())
            .unwrap_or(0)
    } else {
        allocated(&meta)
    }
}

#[cfg(unix)]
fn allocated(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    // `st_blocks` is in 512-byte units on every Unix, whatever the file system's block size.
    meta.blocks() * 512
}

#[cfg(not(unix))]
fn allocated(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// What a Podman machine's disk image is called by its end.
const DISK_IMAGES: [&str; 4] = [".raw", ".vhdx", ".qcow2", ".img"];

/**
The disk images of the Podman machine `machine`, from what `podman machine inspect` printed for
it: every existing file named under any key whose value is a path to a disk image, wherever a
Podman puts one in the JSON, and the machine's own images in its provider's data folder under
`data_home` (`~/.local/share` on a Mac).

Podman 6.1 on a Mac names no disk in inspect at all: it says the provider only through
`ConfigDir` (`~/.config/containers/podman/machine/libkrun`), and keeps the disk at
`~/.local/share/containers/podman/machine/libkrun/openbot-arm64.raw`, 9 GB used of a 60 GB sparse
file on the cloud Mac. Measuring without it, the move offered to free 168 MB.
*/
pub fn machine_disks(inspected: &str, machine: &str, data_home: Option<&Path>) -> Vec<PathBuf> {
    fn walk(value: &serde_json::Value, found: &mut Vec<PathBuf>) {
        match value {
            serde_json::Value::String(text) => {
                let lower = text.to_ascii_lowercase();
                if DISK_IMAGES
                    .iter()
                    .any(|extension| lower.ends_with(extension))
                {
                    let path = PathBuf::from(text);
                    if path.is_absolute() && path.is_file() {
                        found.push(path);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, found)),
            serde_json::Value::Object(map) => map.values().for_each(|item| walk(item, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(inspected) else {
        return found;
    };
    walk(&value, &mut found);
    // The provider, from the machine's configuration folder, and its images in the data folder.
    let entry = value
        .as_array()
        .and_then(|machines| {
            machines
                .iter()
                .find(|entry| entry.get("Name").and_then(|name| name.as_str()) == Some(machine))
        })
        .unwrap_or(&value);
    let provider = entry
        .pointer("/ConfigDir/Path")
        .and_then(|path| path.as_str())
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "..");
    if let (Some(provider), Some(data_home)) = (provider, data_home) {
        let folder = data_home
            .join("containers")
            .join("podman")
            .join("machine")
            .join(provider);
        if let Ok(entries) = std::fs::read_dir(&folder) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                let Some(stem) = DISK_IMAGES
                    .iter()
                    .find_map(|extension| name.strip_suffix(extension))
                else {
                    continue;
                };
                // `openbot.raw` or `openbot-arm64.raw`; never `openbot-s1-arm64.raw`, which is
                // another machine's.
                let machine = machine.to_ascii_lowercase();
                let own = stem == machine
                    || stem
                        .strip_prefix(&format!("{machine}-"))
                        .is_some_and(|arch| {
                            matches!(arch, "arm64" | "aarch64" | "amd64" | "x86_64")
                        });
                if own && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    found.push(entry.path());
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

#[cfg(test)]
mod tests;
