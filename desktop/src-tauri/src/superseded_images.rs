/*!
Removing the images of a release that an update replaced.

THE PROBLEM. An update pulls the new release's images and starts it, and the release before it
stays on the engine's disk for good: a container engine never removes an image by itself. After one
update a Mac under Podman and a Windows computer each kept the previous server (1.62 GB) and
computer (1.45 GB) images beside the new 2.29 GB one.

WHICH IMAGES. Only what this app pulled for the release the update replaced, and only OpenBot's own:
the images that release's finished install recorded (`preparation::installed_images`) that its
image list (`container-images.json`) publishes. So never an image the release only named by a tag
anybody may use (the database's, say), never the back end's, which its own tool pulls and keeps, and
never an image of somebody else's. Of those, never one the installed release runs: whatever its own
install pulled or its image list names stays, whichever release pulled it first. Nothing is found by
asking the engine what looks unused, and nothing is pruned.

WHEN. The list is written (`record`) once an update's new release has started and answered, at the
moment the previous version's files are no longer kept (`upgrade::run`). Until then every image a
failed update goes back to is still wanted, and nothing here has run. The images are removed
(`remove`) after that start, and after every later start while any are left.

HOW. `image rm`, one reference at a time, never forced. An engine refuses to remove an image a
container was made from, running or stopped, of this installation or of anything else on the
computer, and such an image stays. So does one the engine could not be asked about. A reference
that removes one name of an image with others leaves the image to them. What stays is tried again
after the next start, from the list in `FILE`, which is beside the installation and so outlives the
app. Nothing is said to the person either way: it is in the log.
*/

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::engine::Address;
use crate::quiet::said as command_said;
use crate::{deployment, preparation};

/// The images earlier releases of this installation pulled that are still to be removed. Not one
/// of `upgrade::KEPT`: it belongs to the installation, not to a release, and stays where it is
/// through every update.
pub const FILE: &str = ".openbot-superseded-images.json";

#[derive(Default, Serialize, Deserialize)]
struct Superseded {
    images: Vec<String>,
}

/// Held while the list is read and written again, so an update that adds to it and a removal that
/// takes from it never write over each other.
static LIST: Mutex<()> = Mutex::new(());

/// One removal at a time: a Start that follows another closely leaves the first to finish.
static REMOVING: Mutex<()> = Mutex::new(());

fn listed(root: &Path) -> BTreeSet<String> {
    std::fs::read(root.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Superseded>(&bytes).ok())
        .map(|list| list.images.into_iter().collect())
        .unwrap_or_default()
}

/// Write the list, or take the file away once nothing is left on it.
fn write(root: &Path, images: &BTreeSet<String>) -> Result<(), String> {
    if images.is_empty() {
        return match std::fs::remove_file(root.join(FILE)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    preparation::write_checkpoint(
        root,
        FILE,
        &Superseded {
            images: images.iter().cloned().collect(),
        },
    )
}

/// Every image the release laid out in `release` publishes, by the reference its image list pins.
/// None when the list cannot be read.
fn published(release: &Path) -> Option<BTreeSet<String>> {
    let text = std::fs::read_to_string(deployment::images_path(release)).ok()?;
    let list: deployment::Images = serde_json::from_str(&text).ok()?;
    Some(
        list.images
            .into_values()
            .map(|image| image.reference)
            .collect(),
    )
}

/**
Note the images the release set aside in `previous` leaves behind, now that the update of `root`
from it has started and answered: OpenBot's own images that its install pulled. Added to whatever
earlier updates left on the list, so an installation several releases on still removes them all.

Called before `previous` is cleared. A release whose records cannot be read adds nothing, and a
list that cannot be written is said in the log: neither fails an update that has already worked.
*/
pub fn record(root: &Path, previous: &Path) {
    let (Some(pulled), Some(published)) =
        (preparation::installed_images(previous), published(previous))
    else {
        log::info!(
            "[update] the previous release left no record of the images it pulled; none will be removed"
        );
        return;
    };
    let superseded: Vec<String> = pulled
        .into_iter()
        .filter(|image| published.contains(image))
        .collect();
    if superseded.is_empty() {
        return;
    }
    let _held = LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut images = listed(root);
    images.extend(superseded);
    if let Err(error) = write(root, &images) {
        log::warn!("[update] could not note the previous release's images for removal: {error}");
    }
}

/// What the release installed in `root` runs: the images its install pulled, and every image its
/// list publishes, which a Bot picked later is pulled from. None when either cannot be read.
fn needed(root: &Path) -> Option<BTreeSet<String>> {
    let mut needed = published(root)?;
    needed.extend(preparation::installed_images(root)?);
    Some(needed)
}

/**
Remove the images on `root`'s list from `engine`, now that the installed release has started and
answered, and say which went. See the module documentation for which images those are and how each
is removed.

An image the installed release runs comes off the list and stays on the engine. One the engine
removed, or no longer has, comes off the list. One it refused to remove, or could not be asked
about, stays on both for the next start. Never an error: this is tidying up after an update that
already worked.
*/
pub fn remove(engine: &Address, root: &Path) -> Vec<String> {
    let _removing = match REMOVING.try_lock() {
        Ok(removing) => removing,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return Vec::new(),
    };
    let waiting = {
        let _held = LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        listed(root)
    };
    if waiting.is_empty() {
        return Vec::new();
    }
    let Some(needed) = needed(root) else {
        log::info!(
            "[update] this installation's own images could not be read, so no earlier release's image is removed yet"
        );
        return Vec::new();
    };
    let mut removed = Vec::new();
    let mut settled = Vec::new();
    for image in waiting {
        if needed.contains(&image) {
            settled.push(image);
            continue;
        }
        let output = engine
            .command()
            .current_dir(root)
            .args(["image", "rm", &image])
            .output();
        match output {
            Ok(output) if output.status.success() => {
                log::info!("[update] removed {image}, which an earlier release ran");
                removed.push(image.clone());
                settled.push(image);
            }
            // Refused, or never asked. An engine that answers and does not have the image has
            // nothing left to remove; anything else is tried again after the next start.
            failed => {
                let said = match &failed {
                    Ok(output) => command_said(&output.stderr),
                    Err(error) => error.to_string(),
                };
                if engine.responds()
                    && matches!(preparation::image_present(engine, &image), Ok(false))
                {
                    log::info!("[update] {image}, which an earlier release ran, is already gone");
                    settled.push(image);
                } else {
                    log::info!(
                        "[update] left {image}, which an earlier release ran, for the next start: {said}"
                    );
                }
            }
        }
    }
    let _held = LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut images = listed(root);
    for image in &settled {
        images.remove(image);
    }
    if let Err(error) = write(root, &images) {
        log::warn!("[update] could not update the list of earlier releases' images: {error}");
    }
    removed
}
