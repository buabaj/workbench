//! PCM handling: resampling to 16 kHz mono and WAV encoding.
//!
//! Capture happens at the device's native rate (usually 48 kHz) and is
//! resampled here rather than in the browser: Safari's support for a non-default
//! AudioContext sampleRate is inconsistent, and doing it in Rust makes the byte
//! stream deterministic and unit-testable.

pub const TARGET_RATE: u32 = 16_000;

/// Box-filter decimation to `TARGET_RATE`.
///
/// Averaging over each source window is a crude low-pass, which is what keeps
/// decimation from aliasing — plain sample-dropping would fold high frequencies
/// down into the speech band. Handles non-integer ratios (44.1k → 16k) too.
pub fn resample_to_16k(input: &[i16], src_rate: u32) -> Vec<i16> {
    if src_rate == TARGET_RATE || input.is_empty() {
        return input.to_vec();
    }
    if src_rate < TARGET_RATE {
        // Upsampling by linear interpolation; unusual but must not corrupt.
        let ratio = TARGET_RATE as f64 / src_rate as f64;
        let out_len = (input.len() as f64 * ratio) as usize;
        return (0..out_len)
            .map(|i| {
                let pos = i as f64 / ratio;
                let a = pos.floor() as usize;
                let b = (a + 1).min(input.len() - 1);
                let frac = pos - a as f64;
                (input[a] as f64 * (1.0 - frac) + input[b] as f64 * frac) as i16
            })
            .collect();
    }

    let ratio = src_rate as f64 / TARGET_RATE as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = (((i + 1) as f64 * ratio) as usize).min(input.len()).max(start + 1);
        let sum: i64 = input[start..end].iter().map(|&s| s as i64).sum();
        out.push((sum / (end - start) as i64) as i16);
    }
    out
}

/// Root-mean-square amplitude, 0.0–1.0. Used to reject silent recordings before
/// spending a paid API call on them.
pub fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64).powi(2)).sum();
    ((sum / samples.len() as f64).sqrt() / i16::MAX as f64) as f32
}

/// 16-bit mono WAV in memory.
pub fn encode_wav(samples: &[i16], rate: u32) -> Result<Vec<u8>, hound::Error> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut buf, spec)?;
        for &s in samples {
            writer.write_sample(s)?;
        }
        writer.finalize()?;
    }
    Ok(buf.into_inner())
}

/// Little-endian i16 bytes → samples. The wire format from the AudioWorklet.
pub fn bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1 kHz sine at `rate`, `ms` long.
    fn tone(rate: u32, ms: u32, amplitude: f32) -> Vec<i16> {
        let n = (rate * ms / 1000) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / rate as f32;
                ((t * 1000.0 * std::f32::consts::TAU).sin() * amplitude * i16::MAX as f32) as i16
            })
            .collect()
    }

    #[test]
    fn resamples_48k_to_16k_with_expected_length() {
        let input = tone(48_000, 1000, 0.5);
        let out = resample_to_16k(&input, 48_000);
        assert_eq!(out.len(), 16_000, "one second must yield 16k samples");
        // Signal preserved, not silence.
        assert!(rms(&out) > 0.2, "resampling destroyed the signal");
    }

    #[test]
    fn resamples_44100_to_16k() {
        let input = tone(44_100, 500, 0.5);
        let out = resample_to_16k(&input, 44_100);
        assert!(
            (out.len() as i64 - 8_000).abs() < 50,
            "expected ~8000 samples, got {}",
            out.len()
        );
        assert!(rms(&out) > 0.2);
    }

    #[test]
    fn passthrough_when_already_16k() {
        let input = tone(16_000, 100, 0.4);
        assert_eq!(resample_to_16k(&input, 16_000), input);
    }

    #[test]
    fn empty_input_never_panics() {
        assert!(resample_to_16k(&[], 48_000).is_empty());
        assert_eq!(rms(&[]), 0.0);
    }

    #[test]
    fn rms_separates_silence_from_speech_level() {
        let silence = vec![0i16; 16_000];
        assert!(rms(&silence) < 0.001);
        let loud = tone(16_000, 1000, 0.5);
        assert!(rms(&loud) > 0.2);
    }

    #[test]
    fn wav_roundtrips_through_hound() {
        let samples = tone(16_000, 250, 0.5);
        let wav = encode_wav(&samples, 16_000).unwrap();
        // RIFF header present and parseable.
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let mut reader = hound::WavReader::new(std::io::Cursor::new(&wav)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().channels, 1);
        let decoded: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(decoded, samples);
    }

    #[test]
    fn le_bytes_convert_to_samples() {
        let samples: Vec<i16> = vec![0, 1, -1, i16::MAX, i16::MIN];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(bytes_to_samples(&bytes), samples);
        // A trailing odd byte is ignored rather than panicking.
        let mut odd = bytes.clone();
        odd.push(0x7f);
        assert_eq!(bytes_to_samples(&odd), samples);
    }
}
