use super::{CodecError, MAX_BYTES, MAX_ELEMENTS, MAX_NODES};

pub(crate) struct Reader<'a> {
    pub bytes: &'a [u8],
    pub pos: usize,
    pub nodes: usize,
}
impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, CodecError> {
        if bytes.len() > MAX_BYTES {
            return Err(CodecError::limits("binary byte limit"));
        }
        Ok(Self {
            bytes,
            pos: 0,
            nodes: 0,
        })
    }
    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
    pub fn read(&mut self, count: usize) -> Result<&'a [u8], CodecError> {
        if count > self.remaining() {
            return Err(CodecError::value("truncated binary"));
        }
        let start = self.pos;
        self.pos += count;
        Ok(&self.bytes[start..self.pos])
    }
    pub fn fixed<const N: usize>(&mut self) -> Result<[u8; N], CodecError> {
        self.read(N)?
            .try_into()
            .map_err(|_| CodecError::value("truncated binary"))
    }
    pub fn byte(&mut self) -> Result<u8, CodecError> {
        Ok(self.read(1)?[0])
    }
    pub fn varuint(&mut self) -> Result<u32, CodecError> {
        let mut value = 0u32;
        for n in 0..5 {
            let byte = self.byte()?;
            if n == 4 && byte > 15 {
                return Err(CodecError::value("overflowing varuint32"));
            }
            value |= u32::from(byte & 127) << (7 * n);
            if byte < 128 {
                if n > 0 && byte == 0 {
                    return Err(CodecError::value("noncanonical varuint32"));
                }
                return Ok(value);
            }
        }
        Err(CodecError::value("overflowing varuint32"))
    }
    pub fn count(&mut self) -> Result<usize, CodecError> {
        let count = self.varuint()? as usize;
        if count > MAX_ELEMENTS {
            return Err(CodecError::limits("binary element limit"));
        }
        Ok(count)
    }
    pub fn node(&mut self) -> Result<(), CodecError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(CodecError::limits("binary traversal limit"));
        }
        Ok(())
    }
    pub fn blob(&mut self) -> Result<&'a [u8], CodecError> {
        let count = self.varuint()? as usize;
        self.read(count)
    }
    pub fn string(&mut self) -> Result<String, CodecError> {
        String::from_utf8(self.blob()?.to_vec()).map_err(|_| CodecError::value("invalid UTF-8"))
    }
    pub fn end(&self) -> Result<(), CodecError> {
        if self.remaining() != 0 {
            Err(CodecError::value("trailing binary bytes"))
        } else {
            Ok(())
        }
    }
}

pub(crate) struct Writer {
    pub bytes: Vec<u8>,
    pub nodes: usize,
}
impl Writer {
    pub fn new() -> Self {
        Self {
            bytes: Vec::new(),
            nodes: 0,
        }
    }
    pub fn node(&mut self) -> Result<(), CodecError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(CodecError::limits("binary traversal limit"));
        }
        Ok(())
    }
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), CodecError> {
        if bytes.len() > MAX_BYTES.saturating_sub(self.bytes.len()) {
            return Err(CodecError::limits("binary byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    pub fn byte(&mut self, byte: u8) -> Result<(), CodecError> {
        self.write(&[byte])
    }
    pub fn varuint(&mut self, mut value: u32) -> Result<(), CodecError> {
        loop {
            let byte = (value & 127) as u8;
            value >>= 7;
            self.byte(byte | if value == 0 { 0 } else { 128 })?;
            if value == 0 {
                return Ok(());
            }
        }
    }
    pub fn blob(&mut self, bytes: &[u8]) -> Result<(), CodecError> {
        self.varuint(
            u32::try_from(bytes.len()).map_err(|_| CodecError::limits("length overflow"))?,
        )?;
        self.write(bytes)
    }
    pub fn string(&mut self, text: &str) -> Result<(), CodecError> {
        self.blob(text.as_bytes())
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(ALPHABET[(byte >> 4) as usize] as char);
        out.push(ALPHABET[(byte & 15) as usize] as char);
    }
    out
}
pub(crate) fn unhex(text: &str) -> Result<Vec<u8>, CodecError> {
    if text.len() > MAX_BYTES * 2 {
        return Err(CodecError::limits("hex byte limit"));
    }
    if !text.len().is_multiple_of(2) {
        return Err(CodecError::value("odd hex length"));
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            Ok(
                digit(pair[0]).ok_or_else(|| CodecError::value("invalid hex"))? * 16
                    + digit(pair[1]).ok_or_else(|| CodecError::value("invalid hex"))?,
            )
        })
        .collect()
}
