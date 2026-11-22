//! Temporary harness: `own_podman` on this Windows computer, as the move runs it once OpenBot is
//! removed. Arguments: OpenBot's downloads folders.
use openbot_desktop_lib::own_podman::{self, Computer, ThisComputer, USERMODE};
use std::path::{Path, PathBuf};

fn main() {
    let downloads: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    let mut computer = ThisComputer;
    let registrations = computer.registrations();
    println!("registrations: {registrations:?}");
    let users = computer.users();
    println!("users: {users:?}");
    println!(
        "verdict for removal: {:?}",
        own_podman::judge(&registrations, users, &downloads, true)
    );
    let parts = own_podman::parts(&mut computer, &downloads);
    println!(
        "counted: {parts:?} = {} bytes",
        openbot_desktop_lib::move_to_cloud::footprint(&parts)
    );
    let disk = Path::new(r"C:\");
    let before = openbot_desktop_lib::early_downloads::free_space(disk).unwrap_or(0);
    let left = own_podman::remove(&mut computer, &downloads);
    let after = openbot_desktop_lib::early_downloads::free_space(disk).unwrap_or(0);
    println!("left behind: {left:?}");
    println!("registrations after: {:?}", computer.registrations());
    println!("{USERMODE} after: {:?}", computer.distribution(USERMODE));
    println!("program folder after: {:?}", computer.program_folder());
    println!("disk gained: {} bytes", after as i128 - before as i128);
}
