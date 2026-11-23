//! Cross-process coordination for Freedom's shared Codex capability state.
//! Keep this file outside workload write roots. Closing the handle releases the
//! OS lock even if the adapter crashes; never unlink it while other users wait.
use std::fs::{File, TryLockError};
#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

pub struct StartupLock {
    file: File,
    held: bool,
}

impl StartupLock {
    pub(super) fn is_held(&self) -> bool { self.held }

    pub fn open(home: &Path, user: Option<&str>) -> io::Result<Self> {
        #[cfg(windows)]
        let file = protected_file(&home.join(".freedom-startup-v1.lock"), user)?;
        #[cfg(not(windows))]
        let file = {
            let _ = user;
            OpenOptions::new().read(true).write(true).create(true).truncate(false)
                .open(home.join(".freedom-startup-v1.lock"))?
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other("Invalid Windows sandbox startup lock"));
        }
        #[cfg(windows)]
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Windows sandbox startup lock is a reparse point"));
        }
        Ok(Self { file, held: false })
    }

    pub fn try_acquire(&mut self) -> io::Result<bool> {
        if self.held { return Ok(true); }
        match self.file.try_lock() {
            Ok(()) => { self.held = true; Ok(true) }
            Err(TryLockError::WouldBlock) => Ok(false),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

// The shared profile is broadly readable by sandbox accounts. Create the lock
// with a protected DACL at creation, not a later chmod that leaves an opening
// for an already-running workload to obtain a handle. Provisioning can name
// the actual standard user even when this adapter runs as an administrator.
#[cfg(windows)]
fn protected_file(path: &Path, user: Option<&str>) -> io::Result<File> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    #[repr(C)]
    struct SecurityAttributes { length: u32, descriptor: *mut c_void, inherit: i32 }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32,
            descriptor: *mut *mut c_void, size: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CreateFileW(path: *const u16, access: u32, share: u32, attributes: *const SecurityAttributes,
            disposition: u32, flags: u32, template: *mut c_void) -> *mut c_void;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let error = |value: anyhow::Error| io::Error::other(value.to_string());
    let sid = if let Some(user) = user {
        codex_windows_sandbox::resolve_sid(user).map_err(error)?
    } else {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _token = unsafe { OwnedHandle::from_raw_handle(token) };
        unsafe { codex_windows_sandbox::get_user_sid_bytes(token) }.map_err(error)?
    };
    let sid = codex_windows_sandbox::string_from_sid_bytes(&sid).map_err(io::Error::other)?;
    let sddl: Vec<u16> = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})\0").encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1,
        &mut descriptor, std::ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
    let attributes = SecurityAttributes { length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor, inherit: 0 };
    let pathname: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    // GENERIC_READ | GENERIC_WRITE, shared read/write but never deletion,
    // OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT. No descriptor data is inherited.
    let handle = unsafe { CreateFileW(pathname.as_ptr(), 0xc0000000, 3, &attributes, 4,
        0x00200000, std::ptr::null_mut()) };
    let failure = (handle as isize == -1).then(io::Error::last_os_error);
    unsafe { LocalFree(descriptor); }
    if let Some(failure) = failure { return Err(failure); }
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    // A separate process, rather than a thread/clone of the same file handle.
    #[test]
    #[ignore]
    fn lock_child() {
        let home = std::env::var_os("FREEDOM_STARTUP_LOCK_FIXTURE").expect("Owned lock fixture");
        let mut lock = StartupLock::open(Path::new(&home), None).unwrap();
        assert!(!lock.try_acquire().unwrap());
        println!("waiting");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !lock.try_acquire().unwrap() {
            assert!(Instant::now() < deadline, "Parent did not release startup lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        println!("acquired");
    }

    #[test]
    fn independent_processes_wait_then_acquire_after_handle_release() -> io::Result<()> {
        use std::io::{BufRead, BufReader};
        let home = std::env::temp_dir().join(format!("freedom-startup-lock-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&home)?;
        let mut lock = StartupLock::open(&home, None)?;
        assert!(lock.try_acquire()?);
        let mut other = StartupLock::open(&home, None)?;
        assert!(!other.try_acquire()?);
        let child_test = format!("{}::lock_child", module_path!().split_once("::").unwrap().1);
        let mut child = Command::new(std::env::current_exe()?).args(["--ignored", "--exact", &child_test, "--nocapture"])
            .env("FREEDOM_STARTUP_LOCK_FIXTURE", &home).stdout(Stdio::piped()).spawn()?;
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("waiting") { line.clear(); assert!(output.read_line(&mut line)? > 0); }
        drop(lock);
        assert!(child.wait()?.success());
        assert!(other.try_acquire()?);
        drop(other);
        std::fs::remove_dir_all(home)?;
        Ok(())
    }
}
