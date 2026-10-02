//! STORED (uncompressed) ZIP archive streamed across batches.

use serde::{Deserialize, Serialize};

const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const END_SIGNATURE: u32 = 0x0605_4b50;
const VERSION: u16 = 20;
/// 1980-01-01: components have no clock, and output must be reproducible.
const DOS_DATE: u16 = 0x0021;

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
}

#[derive(Default, Deserialize, Serialize)]
pub struct ZipState {
    length: u32,
    entries: Vec<Entry>,
}

fn u16le(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn u32le(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

impl ZipState {
    /// Local header and data for one file.
    pub fn entry(&mut self, name: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        let size = u32::try_from(data.len()).map_err(|_| "document too large")?;
        let crc = crc32(data);
        let mut bytes = Vec::with_capacity(30 + name.len() + data.len());
        u32le(&mut bytes, LOCAL_SIGNATURE);
        u16le(&mut bytes, VERSION);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, DOS_DATE);
        u32le(&mut bytes, crc);
        u32le(&mut bytes, size);
        u32le(&mut bytes, size);
        u16le(&mut bytes, name.len() as u16);
        u16le(&mut bytes, 0);
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(data);
        self.entries.push(Entry {
            name: name.to_owned(),
            crc,
            size,
            offset: self.length,
        });
        self.length += bytes.len() as u32;
        Ok(bytes)
    }

    /// Central directory and end record.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for entry in &self.entries {
            u32le(&mut bytes, CENTRAL_SIGNATURE);
            u16le(&mut bytes, VERSION);
            u16le(&mut bytes, VERSION);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, DOS_DATE);
            u32le(&mut bytes, entry.crc);
            u32le(&mut bytes, entry.size);
            u32le(&mut bytes, entry.size);
            u16le(&mut bytes, entry.name.len() as u16);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, 0);
            u16le(&mut bytes, 0);
            u32le(&mut bytes, 0);
            u32le(&mut bytes, entry.offset);
            bytes.extend_from_slice(entry.name.as_bytes());
        }
        let directory_size = bytes.len() as u32;
        u32le(&mut bytes, END_SIGNATURE);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, self.entries.len() as u16);
        u16le(&mut bytes, self.entries.len() as u16);
        u32le(&mut bytes, directory_size);
        u32le(&mut bytes, self.length);
        u16le(&mut bytes, 0);
        self.length += bytes.len() as u32;
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn archive_lists_every_entry() {
        let mut state = ZipState::default();
        let mut bytes = state.entry("a.pdf", b"one").unwrap();
        bytes.extend(state.entry("b.pdf", b"two").unwrap());
        bytes.extend(state.finish());
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], &END_SIGNATURE.to_le_bytes());
        assert_eq!(u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]), 2);
    }
}
