//! Bounded, package-local Wire ABI and value codecs.
//!
//! Profiles select protocol semantics before decoding. Metadata is never converted
//! through a legacy Antelope ABI. Wide integers and raw descriptor JSON stay lossless.

mod binary;
mod metadata;
pub mod native_actions;
pub mod observations;
mod protobuf;
mod scalar;
pub mod ship;
mod value;

use serde_json::Value;
use std::fmt;

pub use metadata::{decode_abi, encode_abi};
pub use value::{decode_value, encode_value};

pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ELEMENTS: usize = 100_000;
pub const MAX_DEPTH: usize = 64;
pub const MAX_NODES: usize = 1_000_000;

/// Explicitly selected engineering profiles, not final launch pins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecProfile {
    pub id: String,
    pub upstream_revision: String,
    pub epoch_milliseconds: i64,
    pub slot_milliseconds: i64,
    pub slug_name_builtin: bool,
}

impl CodecProfile {
    pub(crate) fn validate(&self) -> Result<(), CodecError> {
        if self != &Self::for_id(&self.id)? {
            return Err(CodecError::unsupported(
                "profile parameters do not match pinned dialect",
            ));
        }
        Ok(())
    }
    pub fn for_id(id: &str) -> Result<Self, CodecError> {
        let (revision, slug_name_builtin) = match id {
            "wire-sysio-6508c9e8-engineering-v1" | "wire-sysio-6508c9e8-native-engineering-v1" => {
                ("6508c9e8f4044df8d5acb082a7af3be6a80cd9a0", true)
            }
            "wire-sysio-7dede884-engineering-v1" => {
                ("7dede884e0150d36fa788e85a119e10653ade8ca", false)
            }
            _ => return Err(CodecError::unsupported("unknown codec profile")),
        };
        Ok(Self {
            id: id.into(),
            upstream_revision: revision.into(),
            epoch_milliseconds: 1_735_689_600_000,
            slot_milliseconds: 500,
            slug_name_builtin,
        })
    }
}

impl Default for CodecProfile {
    fn default() -> Self {
        Self::for_id("wire-sysio-6508c9e8-engineering-v1").expect("bundled profile")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecError {
    code: &'static str,
    message: String,
}

impl CodecError {
    pub const fn code(&self) -> &'static str {
        self.code
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub(crate) fn abi(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_abi",
            message: message.into(),
        }
    }
    pub(crate) fn value(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_value",
            message: message.into(),
        }
    }
    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "unsupported_feature",
            message: message.into(),
        }
    }
    pub(crate) fn limits(message: impl Into<String>) -> Self {
        Self {
            code: "limits_exceeded",
            message: message.into(),
        }
    }
    pub(crate) fn into_abi(self) -> Self {
        if self.code == "invalid_value" {
            Self::abi(self.message)
        } else {
            self
        }
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CodecError {}

pub(crate) fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, CodecError> {
    value
        .as_object()
        .ok_or_else(|| CodecError::value("expected object"))
}
pub(crate) fn string(value: &Value) -> Result<&str, CodecError> {
    value
        .as_str()
        .ok_or_else(|| CodecError::value("expected string"))
}
pub(crate) fn array(value: &Value) -> Result<&[Value], CodecError> {
    let items = value
        .as_array()
        .ok_or_else(|| CodecError::value("expected array"))?;
    if items.len() > MAX_ELEMENTS {
        return Err(CodecError::limits("array element limit"));
    }
    Ok(items)
}

/// Reject oversized JSON and excessive nesting before recursive codec work.
pub(crate) fn check_json(value: &Value) -> Result<(), CodecError> {
    let mut stack = vec![(value, 0)];
    let mut nodes = 0;
    let mut text_bytes: usize = 0;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if nodes > MAX_NODES || depth > MAX_DEPTH {
            return Err(CodecError::limits("JSON traversal limit"));
        }
        match value {
            Value::String(text) => text_bytes = text_bytes.saturating_add(text.len()),
            Value::Array(items) => {
                if items.len() > MAX_ELEMENTS {
                    return Err(CodecError::limits("JSON array limit"));
                }
                stack.extend(items.iter().map(|item| (item, depth + 1)));
            }
            Value::Object(items) => {
                text_bytes =
                    text_bytes.saturating_add(items.keys().map(String::len).sum::<usize>());
                stack.extend(items.values().map(|item| (item, depth + 1)));
            }
            _ => {}
        }
        if text_bytes > MAX_BYTES {
            return Err(CodecError::limits("JSON byte limit"));
        }
    }
    Ok(())
}
