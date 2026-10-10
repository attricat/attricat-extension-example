//! Minimal PDF 1.4 writer: Helvetica with WinAnsi text, one page per record.

use serde::{Deserialize, Serialize};

const WRAP_CHARS: usize = 90;
const MAX_PAGE_LINES: usize = 48;
const FONT_OBJECT: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const HEADER: &[u8] = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";

/// Escapes PDF string delimiters and replaces characters outside printable
/// ASCII, which the standard Helvetica encoding cannot represent reliably.
fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '(' | ')' | '\\' => format!("\\{c}"),
            ' '..='~' => c.to_string(),
            _ => "?".into(),
        })
        .collect()
}

fn wrap(lines: &[String]) -> Vec<String> {
    let mut wrapped = Vec::new();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        if chars.is_empty() {
            wrapped.push(String::new());
        }
        for chunk in chars.chunks(WRAP_CHARS) {
            wrapped.push(chunk.iter().collect());
        }
    }
    if wrapped.len() > MAX_PAGE_LINES {
        wrapped.truncate(MAX_PAGE_LINES - 1);
        wrapped.push("...".into());
    }
    wrapped
}

fn content(title: &str, lines: &[String]) -> String {
    let mut stream = format!(
        "BT /F1 16 Tf 50 790 Td ({}) Tj ET\nBT /F1 10 Tf 50 762 Td 14 TL\n",
        escape(&title.chars().take(WRAP_CHARS).collect::<String>())
    );
    for line in wrap(lines) {
        stream.push_str(&format!("({}) Tj T*\n", escape(&line)));
    }
    stream.push_str("ET\n");
    stream
}

fn object(number: u32, body: &str) -> String {
    format!("{number} 0 obj\n{body}\nendobj\n")
}

fn page_objects(page: u32, content_object: u32, title: &str, lines: &[String]) -> String {
    let stream = content(title, lines);
    object(
        page,
        &format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_object} 0 R >>"
        ),
    ) + &object(
        content_object,
        &format!("<< /Length {} >>\nstream\n{stream}endstream", stream.len()),
    )
}

fn trailer(offsets: &[(u32, u64)], xref_at: u64) -> String {
    let size = offsets.iter().map(|(number, _)| *number).max().unwrap_or(0) + 1;
    let mut table = format!("xref\n0 {size}\n0000000000 65535 f \n");
    for number in 1..size {
        let offset = offsets
            .iter()
            .find(|(candidate, _)| *candidate == number)
            .map(|(_, offset)| *offset)
            .unwrap_or_default();
        table.push_str(&format!("{offset:010} 00000 n \n"));
    }
    table + &format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n")
}

fn catalog_objects(pages: &[u32]) -> (String, String) {
    let kids: Vec<String> = pages.iter().map(|page| format!("{page} 0 R")).collect();
    (
        object(1, "<< /Type /Attricat /Pages 2 0 R >>"),
        object(
            2,
            &format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                pages.len()
            ),
        ),
    )
}

/// A complete single-page document.
pub fn single_page(title: &str, lines: &[String]) -> Vec<u8> {
    let mut stream = StreamState::default();
    let mut bytes = stream.page(title, lines);
    bytes.extend(stream.finish());
    bytes
}

/// Checkpointed state of a multi-page PDF streamed across batches.
#[derive(Default, Deserialize, Serialize)]
pub struct StreamState {
    length: u64,
    offsets: Vec<(u32, u64)>,
    pages: Vec<u32>,
}

impl StreamState {
    /// Bytes for one more page. The first page also writes the header and
    /// the shared font; objects 1 and 2 are written by `finish`.
    pub fn page(&mut self, title: &str, lines: &[String]) -> Vec<u8> {
        let mut bytes = Vec::new();
        if self.length == 0 {
            bytes.extend_from_slice(HEADER);
            let font = object(3, FONT_OBJECT);
            self.offsets.push((3, bytes.len() as u64));
            bytes.extend_from_slice(font.as_bytes());
        }
        let page = 4 + 2 * self.pages.len() as u32;
        let objects = page_objects(page, page + 1, title, lines);
        let split = objects
            .find("endobj\n")
            .map(|at| at + 7)
            .unwrap_or_default();
        self.offsets.push((page, self.length + bytes.len() as u64));
        self.offsets
            .push((page + 1, self.length + (bytes.len() + split) as u64));
        bytes.extend_from_slice(objects.as_bytes());
        self.pages.push(page);
        self.length += bytes.len() as u64;
        bytes
    }

    /// The page tree, catalog, cross-reference table and trailer.
    pub fn finish(&mut self) -> Vec<u8> {
        let (catalog, pages) = catalog_objects(&self.pages);
        let mut bytes = String::new();
        self.offsets.push((2, self.length));
        bytes.push_str(&pages);
        self.offsets.push((1, self.length + bytes.len() as u64));
        bytes.push_str(&catalog);
        let xref_at = self.length + bytes.len() as u64;
        bytes.push_str(&trailer(&self.offsets, xref_at));
        self.length += bytes.len() as u64;
        bytes.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_offsets(bytes: &[u8], objects: usize) {
        let xref = bytes.windows(5).position(|w| w == b"xref\n").unwrap();
        let table = std::str::from_utf8(&bytes[xref..]).unwrap();
        for (index, line) in table.lines().skip(3).take(objects).enumerate() {
            let offset: usize = line[..10].parse().unwrap();
            let expected = format!("{} 0 obj", index + 1);
            assert!(
                bytes[offset..].starts_with(expected.as_bytes()),
                "{expected}"
            );
        }
        assert!(bytes.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn escapes_delimiters_and_non_ascii() {
        assert_eq!(escape("a(b)\\c é"), "a\\(b\\)\\\\c ?");
    }

    #[test]
    fn cross_reference_offsets_point_at_objects() {
        assert_offsets(&single_page("Title", &["code: value".into()]), 5);
    }

    #[test]
    fn streamed_pages_share_one_document() {
        let mut state = StreamState::default();
        let mut bytes = state.page("One", &[]);
        bytes.extend(state.page("Two", &[]));
        bytes.extend(state.finish());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("/Kids [4 0 R 6 0 R] /Count 2"));
        assert_offsets(&bytes, 7);
    }
}
