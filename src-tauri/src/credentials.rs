//! Gemini API key in the Windows Credential Manager (Control Panel >
//! Credential Manager > Windows Credentials).

use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
    CredWriteW,
};
use windows::core::{HSTRING, PWSTR};

const TARGET: &str = "malum/gemini-api-key";

pub fn load_api_key() -> Result<Option<String>, String> {
    let target = HSTRING::from(TARGET);
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    match unsafe { CredReadW(&target, CRED_TYPE_GENERIC, None, &mut cred) } {
        Ok(()) => {
            let blob = unsafe {
                let c = &*cred;
                let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
                CredFree(cred as *const _);
                bytes
            };
            String::from_utf8(blob)
                .map(Some)
                .map_err(|_| "Saved key is corrupted".into())
        }
        Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
        Err(e) => Err(format!("Could not read the key: {}", e.message())),
    }
}

pub fn save_api_key(key: &str) -> Result<(), String> {
    let mut target: Vec<u16> = TARGET.encode_utf16().chain([0]).collect();
    let mut user: Vec<u16> = "malum".encode_utf16().chain([0]).collect();
    let mut blob = key.as_bytes().to_vec();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        UserName: PWSTR(user.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&cred, 0) }
        .map_err(|e| format!("Could not save the key: {}", e.message()))
}

/// Removing a key that isn't there is fine.
pub fn delete_api_key() -> Result<(), String> {
    let target = HSTRING::from(TARGET);
    match unsafe { CredDeleteW(&target, CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
        Err(e) => Err(format!("Could not remove the key: {}", e.message())),
    }
}
