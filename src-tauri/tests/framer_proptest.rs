//! Property test: for ANY set of frames and ANY random partition into chunks,
//! framer output == input frames. This is the single highest-value test of the
//! protocol layer.

use prime_workbench_lib::agent::framer::{FrameEvent, LineFramer};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn roundtrip_any_frames_any_chunking(
        // Frames: arbitrary bytes except '\n' (the delimiter), non-whitespace-only.
        frames in prop::collection::vec(
            prop::collection::vec(any::<u8>().prop_filter("no LF", |b| *b != b'\n'), 1..200)
                .prop_filter("not whitespace-only / no trailing CR", |f| {
                    !f.iter().all(|b| b.is_ascii_whitespace()) && f.last() != Some(&b'\r')
                }),
            0..20
        ),
        chunk_sizes in prop::collection::vec(1usize..64, 0..400),
    ) {
        // Build the wire stream.
        let mut wire = Vec::new();
        for f in &frames {
            wire.extend_from_slice(f);
            wire.push(b'\n');
        }

        // Partition into chunks by the random size sequence (cycled).
        let mut framer = LineFramer::default();
        let mut got: Vec<Vec<u8>> = Vec::new();
        let mut pos = 0;
        let mut i = 0;
        while pos < wire.len() {
            let size = if chunk_sizes.is_empty() { 7 } else { chunk_sizes[i % chunk_sizes.len()] };
            let end = (pos + size).min(wire.len());
            framer.push(&wire[pos..end], |ev| {
                if let FrameEvent::Frame(f) = ev { got.push(f.to_vec()); }
            });
            pos = end;
            i += 1;
        }
        framer.finish(|ev| {
            if let FrameEvent::Frame(f) = ev { got.push(f.to_vec()); }
        });

        prop_assert_eq!(got, frames);
    }
}
