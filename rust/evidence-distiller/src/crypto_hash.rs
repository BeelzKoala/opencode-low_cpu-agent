use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

const FILE_BUFFER_BYTES: usize = 64 * 1024;

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for value in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{value:02x}").expect("write to String cannot fail");
    }
    out
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; FILE_BUFFER_BYTES];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex_digest(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        hint::black_box,
        path::PathBuf,
        process::Command,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    fn temp_file(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "opencode-{label}-{}-{nonce}.bin",
            std::process::id()
        ))
    }

    fn deterministic_payload(bytes: usize) -> Vec<u8> {
        (0..bytes)
            .map(|index| ((index.wrapping_mul(31).wrapping_add(17)) & 0xff) as u8)
            .collect()
    }

    fn sha256sum_file(path: &Path) -> String {
        let output = Command::new("sha256sum")
            .arg(path)
            .output()
            .expect("sha256sum is required only for the manual benchmark");
        assert!(output.status.success(), "sha256sum failed");
        let stdout = String::from_utf8(output.stdout).expect("sha256sum output must be UTF-8");
        let digest = stdout
            .split_whitespace()
            .next()
            .expect("sha256sum digest missing");
        assert_eq!(digest.len(), 64, "sha256sum digest length");
        digest.to_ascii_lowercase()
    }

    fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (*value >= min) && (*value <= max))
            .unwrap_or(default)
    }

    fn median(mut values: Vec<f64>) -> f64 {
        values.sort_by(|a, b| a.total_cmp(b));
        values[values.len() / 2]
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn binary_digest_is_deterministic() {
        let bytes = deterministic_payload(4097);
        assert_eq!(sha256_bytes(&bytes), sha256_bytes(&bytes));
        assert_ne!(sha256_bytes(&bytes), sha256_bytes(&bytes[..4096]));
    }

    #[test]
    fn file_digest_matches_byte_digest() {
        let path = temp_file("sha2-equivalence");
        let bytes = deterministic_payload(128 * 1024 + 17);
        fs::write(&path, &bytes).expect("write fixture");
        let actual = sha256_file(&path).expect("hash fixture");
        let _ = fs::remove_file(&path);
        assert_eq!(actual, sha256_bytes(&bytes));
    }

    #[test]
    #[ignore = "manual release-mode performance evidence; no CI speed threshold"]
    fn benchmark_sha2_file_vs_sha256sum_process() {
        let iterations = env_usize("OPENCODE_SHA_BENCH_ITERS", 250, 10, 20_000);
        let rounds = env_usize("OPENCODE_SHA_BENCH_ROUNDS", 5, 3, 21);
        let file_bytes = env_usize("OPENCODE_SHA_BENCH_BYTES", 64 * 1024, 1, 16 * 1024 * 1024);

        let path = temp_file("sha-bench");
        let bytes = deterministic_payload(file_bytes);
        fs::write(&path, &bytes).expect("write benchmark fixture");

        let expected = sha256_bytes(&bytes);
        assert_eq!(sha256_file(&path).expect("sha2 file digest"), expected);
        assert_eq!(sha256sum_file(&path), expected);

        for _ in 0..8 {
            black_box(sha256_file(&path).expect("sha2 warmup"));
            black_box(sha256sum_file(&path));
        }

        let mut sha2_us = Vec::with_capacity(rounds);
        let mut process_us = Vec::with_capacity(rounds);

        for _ in 0..rounds {
            let started = Instant::now();
            for _ in 0..iterations {
                black_box(sha256_file(&path).expect("sha2 benchmark"));
            }
            sha2_us.push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64);

            let started = Instant::now();
            for _ in 0..iterations {
                black_box(sha256sum_file(&path));
            }
            process_us.push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64);
        }

        let sha2_median = median(sha2_us);
        let process_median = median(process_us);
        let speedup = process_median / sha2_median;
        let saved = process_median - sha2_median;

        println!(
            "SHA256_BENCH file_bytes={file_bytes} iterations={iterations} rounds={rounds} \
sha2_median_us_per_hash={sha2_median:.3} \
sha256sum_process_median_us_per_hash={process_median:.3} \
saved_us_per_hash={saved:.3} speedup={speedup:.2}x"
        );

        let _ = fs::remove_file(&path);
    }
}
