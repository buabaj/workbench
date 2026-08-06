//! Keychain access — the ONLY module allowed to call `keyring`.
//!
//! keyring 4's default `v1` feature auto-registers the classic macOS login
//! keychain store (verified by spike 2026-08-06; no explicit setter needed).
//! The classic store works for unsigned/ad-hoc binaries; the `protected` store
//! does not — never switch without a provisioning profile.

use crate::secret::SecretString;

pub const SERVICE: &str = "co.morpheusgh.workbench.credentials";

pub fn account_for(profile_id: &str) -> String {
    format!("cred:{profile_id}")
}

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keychain error: {0}")]
    Backend(String),
}

/// Trait so the store and every security test run against an in-memory
/// implementation; only `MacKeychain` touches the real login keychain.
pub trait Keychain: Send + Sync {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), KeychainError>;
    fn get(&self, account: &str) -> Result<Option<SecretString>, KeychainError>;
    /// Idempotent: deleting a missing entry is Ok.
    fn delete(&self, account: &str) -> Result<(), KeychainError>;
}

pub struct MacKeychain;

impl Keychain for MacKeychain {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), KeychainError> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(secret.expose()))
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }

    fn get(&self, account: &str) -> Result<Option<SecretString>, KeychainError> {
        match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
            Ok(p) => Ok(Some(SecretString::new(p))),
            // Absent is a NORMAL branch — "re-add your key", never an error toast.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeychainError::Backend(e.to_string())),
        }
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        match keyring::Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeychainError::Backend(e.to_string())),
        }
    }
}

/// In-memory keychain for tests.
#[derive(Default)]
pub struct MemKeychain(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl Keychain for MemKeychain {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), KeychainError> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.expose().to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<SecretString>, KeychainError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(account)
            .map(|s| SecretString::new(s.clone())))
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

impl MemKeychain {
    pub fn contains(&self, account: &str) -> bool {
        self.0.lock().unwrap().contains_key(account)
    }
}
