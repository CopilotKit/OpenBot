//! Shared with server/src/provider-oauth-lock.ts. Keep the directory and lock
//! inode permanently; OS handle ownership releases exclusion after a crash.
use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub fn acquire(credential: &Path) -> io::Result<File> {
    let mut name = credential.as_os_str().to_os_string();
    name.push(".lock");
    let directory = PathBuf::from(name);
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid credential lock directory.",
        ));
    }
    validate_private(&metadata, true)?;
    let path = directory.join("owner.lock");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let file = options.open(path)?;
        validate_file(&file)?;
        loop {
            // SAFETY: file owns a valid descriptor for the lifetime of this call.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(file);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::WouldBlock || Instant::now() >= deadline {
                return Err(error);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Exactly the CreateFileW sharing/no-follow mode used by the Bun helper.
        options.share_mode(0).custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        loop {
            match options.open(&path) {
                Ok(file) => {
                    validate_file(&file)?;
                    return Ok(file);
                }
                Err(error) if error.raw_os_error() == Some(32) && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn validate_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid credential lock file.",
        ));
    }
    validate_private(&metadata, false)
}

fn validate_private(metadata: &std::fs::Metadata, directory: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Legacy mkdir directories may be 0755, but other users must not be
        // able to replace their entries. The lock file remains owner-only.
        if metadata.permissions().mode() & (if directory { 0o022 } else { 0o077 }) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Credential lock is not private.",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let _ = directory;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Credential lock cannot be redirected.",
            ));
        }
    }
    Ok(())
}
