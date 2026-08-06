//! LF-only JSONL framing for the prime-agent RPC stream.
//!
//! Protocol contract (prime-agent rpc.md): records are delimited by `\n` ONLY.
//! An optional trailing `\r` is stripped (CRLF tolerance), but a bare `\r` — or
//! U+2028/U+2029 — inside a record is ordinary payload. This is exactly the rule
//! generic line readers get wrong, which is why this module exists and why it has
//! no dependencies: it must be trivially provable.
//!
//! This module MUST NOT depend on tauri or tokio.

/// Default cap. `agent_end.messages` can be multi-megabyte; 64 MiB is a
/// runaway-line backstop, not a working limit.
pub const DEFAULT_MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameEvent<'a> {
    /// One complete record, terminator (and one trailing `\r`, if any) stripped.
    Frame(&'a [u8]),
    /// An over-long line was discarded up to the next `\n`. The stream continues.
    Oversize { dropped_bytes: usize },
}

pub struct LineFramer {
    buf: Vec<u8>,
    /// Bytes before this offset have already been scanned for `\n`. Prevents
    /// O(n²) rescanning when a large frame arrives in many small chunks.
    scan_from: usize,
    max_frame: usize,
    discarding: bool,
    dropped: usize,
}

impl LineFramer {
    pub fn new(max_frame: usize) -> Self {
        Self {
            buf: Vec::new(),
            scan_from: 0,
            max_frame,
            discarding: false,
            dropped: 0,
        }
    }

    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    /// Feed a chunk of bytes; `sink` is called once per completed frame, in order.
    pub fn push(&mut self, chunk: &[u8], mut sink: impl FnMut(FrameEvent<'_>)) {
        self.buf.extend_from_slice(chunk);
        loop {
            if self.discarding {
                match find_lf(&self.buf, 0) {
                    Some(nl) => {
                        self.dropped += nl + 1;
                        self.buf.drain(..=nl);
                        self.scan_from = 0;
                        self.discarding = false;
                        sink(FrameEvent::Oversize {
                            dropped_bytes: self.dropped,
                        });
                        self.dropped = 0;
                        continue;
                    }
                    None => {
                        self.dropped += self.buf.len();
                        self.buf.clear();
                        self.scan_from = 0;
                        return;
                    }
                }
            }
            match find_lf(&self.buf, self.scan_from) {
                Some(nl) => {
                    if nl > self.max_frame {
                        // Complete line, but over the cap: same contract as the
                        // unterminated case — report and drop, never emit.
                        sink(FrameEvent::Oversize { dropped_bytes: nl + 1 });
                    } else {
                        let frame = trim_frame(&self.buf[..nl]);
                        if !frame.is_empty() {
                            sink(FrameEvent::Frame(frame));
                        }
                    }
                    self.buf.drain(..=nl);
                    self.scan_from = 0;
                }
                None => {
                    self.scan_from = self.buf.len();
                    if self.buf.len() > self.max_frame {
                        self.dropped = self.buf.len();
                        self.buf.clear();
                        self.scan_from = 0;
                        self.discarding = true;
                    }
                    return;
                }
            }
        }
    }

    /// Flush at EOF: a trailing record without a final `\n` is surfaced, not
    /// silently dropped.
    pub fn finish(&mut self, mut sink: impl FnMut(FrameEvent<'_>)) {
        if self.discarding {
            sink(FrameEvent::Oversize {
                dropped_bytes: self.dropped,
            });
        } else {
            let frame = trim_frame(&self.buf);
            if !frame.is_empty() {
                sink(FrameEvent::Frame(frame));
            }
        }
        self.buf.clear();
        self.scan_from = 0;
        self.dropped = 0;
        self.discarding = false;
    }
}

impl Default for LineFramer {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME)
    }
}

fn find_lf(buf: &[u8], from: usize) -> Option<usize> {
    buf[from..].iter().position(|&b| b == b'\n').map(|p| from + p)
}

/// Strip exactly one trailing `\r` (CRLF tolerance), then treat all-whitespace
/// frames as empty. Interior `\r` bytes are untouched — they are payload.
fn trim_frame(mut frame: &[u8]) -> &[u8] {
    if frame.last() == Some(&b'\r') {
        frame = &frame[..frame.len() - 1];
    }
    if frame.iter().all(|b| b.is_ascii_whitespace()) {
        &[]
    } else {
        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(framer: &mut LineFramer, chunks: &[&[u8]]) -> (Vec<Vec<u8>>, usize) {
        let mut frames = Vec::new();
        let mut oversize = 0;
        for chunk in chunks {
            framer.push(chunk, |ev| match ev {
                FrameEvent::Frame(f) => frames.push(f.to_vec()),
                FrameEvent::Oversize { .. } => oversize += 1,
            });
        }
        (frames, oversize)
    }

    #[test]
    fn split_mid_json_across_chunks() {
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"{\"type\":\"age", b"nt_start\"}\n{\"a\":1}\n"]);
        assert_eq!(frames, vec![b"{\"type\":\"agent_start\"}".to_vec(), b"{\"a\":1}".to_vec()]);
    }

    #[test]
    fn bare_cr_inside_payload_is_one_frame() {
        // The exact defect in generic line readers: \r must NOT split a record.
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"{\"text\":\"a\rb\"}\n"]);
        assert_eq!(frames, vec![b"{\"text\":\"a\rb\"}".to_vec()]);
    }

    #[test]
    fn crlf_terminator_strips_exactly_one_cr() {
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"{\"a\":1}\r\n{\"b\":2}\r\r\n"]);
        assert_eq!(frames, vec![b"{\"a\":1}".to_vec(), b"{\"b\":2}\r".to_vec()]);
    }

    #[test]
    fn split_lands_between_cr_and_lf() {
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"{\"a\":1}\r", b"\n{\"b\":2}\n"]);
        assert_eq!(frames, vec![b"{\"a\":1}".to_vec(), b"{\"b\":2}".to_vec()]);
    }

    #[test]
    fn empty_and_whitespace_lines_skipped() {
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"\n  \n\t\r\n{\"a\":1}\n\n"]);
        assert_eq!(frames, vec![b"{\"a\":1}".to_vec()]);
    }

    #[test]
    fn byte_at_a_time_large_frame() {
        let payload = format!("{{\"data\":\"{}\"}}", "x".repeat(100_000));
        let mut input = payload.clone().into_bytes();
        input.push(b'\n');
        let mut f = LineFramer::default();
        let mut frames = Vec::new();
        for b in &input {
            f.push(std::slice::from_ref(b), |ev| {
                if let FrameEvent::Frame(fr) = ev {
                    frames.push(fr.to_vec());
                }
            });
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], payload.as_bytes());
    }

    #[test]
    fn oversize_resyncs_at_next_lf() {
        let mut f = LineFramer::new(16);
        let (frames, oversize) = collect(
            &mut f,
            &[b"{\"way_too_long_for_the_cap\":123456}\n{\"ok\":1}\n"],
        );
        assert_eq!(oversize, 1);
        assert_eq!(frames, vec![b"{\"ok\":1}".to_vec()]);
    }

    #[test]
    fn trailing_partial_surfaced_by_finish() {
        let mut f = LineFramer::default();
        let (frames, _) = collect(&mut f, &[b"{\"a\":1}\n{\"trailing\":true}"]);
        assert_eq!(frames.len(), 1);
        let mut tail = Vec::new();
        f.finish(|ev| {
            if let FrameEvent::Frame(fr) = ev {
                tail.push(fr.to_vec());
            }
        });
        assert_eq!(tail, vec![b"{\"trailing\":true}".to_vec()]);
        assert_eq!(f.pending_bytes(), 0);
    }
}
