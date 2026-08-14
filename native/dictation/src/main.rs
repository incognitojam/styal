//! t3-dictation: streaming speech-to-text sidecar.
//!
//! Raw 16 kHz mono f32 little-endian PCM on stdin; JSONL events on stdout:
//!
//!   {"type":"ready", "backend", "loadMs", "supportsStreaming"}
//!   {"type":"update", "committed", "tentative", "audioMs", "rtf"}
//!   {"type":"final", "text", "audioMs", "rtf", "finalizeMs"}
//!   {"type":"fatal", "message"}            (on stderr-worthy errors, then exit 1)
//!
//! One process handles one utterance: the parent holds a warm process per
//! session and replaces it after finalize. Model load is ~0.5-0.7s warm from
//! page cache, ~10s on first cold read (spike finding 17).
//!
//! `rtf` is compute-seconds per audio-second, cumulative. The parent should
//! surface a warning as it approaches 1.0 — that is the engine falling behind
//! live speech, which the user otherwise experiences as silent lag. CPU-only
//! measured 0.39 single-stream; ~3 concurrent streams saturate a 12-core CPU.
//!
//! Usage: t3-dictation <model.gguf> [--cpu]

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, StreamOptions};

/// 100ms of 16 kHz mono f32 — matches a typical capture cadence.
const FRAME_SAMPLES: usize = 1600;
const SAMPLES_PER_MS: f64 = 16.0;

fn emit(value: serde_json::Value) {
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn fatal(message: String) -> ! {
    emit(serde_json::json!({ "type": "fatal", "message": message }));
    eprintln!("{message}");
    std::process::exit(1);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let model_path = match args.next() {
        Some(path) if !path.starts_with("--") => path,
        _ => fatal("usage: t3-dictation <model.gguf> [--cpu]".into()),
    };
    let force_cpu = std::env::args().any(|arg| arg == "--cpu");

    transcribe_cpp::init_logging();
    if let Err(error) = transcribe_cpp::init_backends_default() {
        eprintln!("init_backends_default failed: {error}");
    }

    let model_options = if force_cpu {
        ModelOptions {
            backend: Backend::Cpu,
            // A GPU-backend registry index; CPU ignores it but rejects
            // out-of-range values, so it must be 0 rather than -1.
            gpu_device: 0,
        }
    } else {
        ModelOptions::default()
    };

    let load_started = Instant::now();
    let model = match Model::load_with(&model_path, &model_options) {
        Ok(model) => model,
        Err(error) => fatal(format!("failed to load model {model_path}: {error}")),
    };
    let backend = model.backend();
    let mut session = match model.session() {
        Ok(session) => session,
        Err(error) => fatal(format!("failed to create session: {error}")),
    };

    let capabilities = session.model().capabilities();
    emit(serde_json::json!({
        "type": "ready",
        "backend": format!("{backend:?}"),
        "loadMs": load_started.elapsed().as_secs_f64() * 1000.0,
        "supportsStreaming": capabilities.supports_streaming,
    }));

    let run_options = RunOptions::default();
    let mut stream = match session.stream(&run_options, &StreamOptions::default()) {
        Ok(stream) => stream,
        Err(error) => fatal(format!("failed to begin stream: {error}")),
    };

    let mut stdin = io::stdin().lock();
    let mut bytes = vec![0u8; FRAME_SAMPLES * 4];
    let mut samples = vec![0f32; FRAME_SAMPLES];
    let mut fed_samples: u64 = 0;
    let mut compute = Duration::ZERO;

    let rtf = |compute: Duration, fed_samples: u64| -> f64 {
        let audio_seconds = fed_samples as f64 / (SAMPLES_PER_MS * 1000.0);
        if audio_seconds > 0.0 {
            compute.as_secs_f64() / audio_seconds
        } else {
            0.0
        }
    };

    loop {
        match stdin.read_exact(&mut bytes) {
            Ok(()) => {}
            // A partial or absent frame means the client stopped talking.
            Err(ref error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                eprintln!("stdin read failed: {error}");
                break;
            }
        }

        for (index, chunk) in bytes.chunks_exact(4).enumerate() {
            samples[index] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        fed_samples += samples.len() as u64;

        let feed_started = Instant::now();
        match stream.feed(&samples) {
            Ok(update) => {
                compute += feed_started.elapsed();
                if update.committed_changed || update.tentative_changed {
                    let text = stream.text();
                    emit(serde_json::json!({
                        "type": "update",
                        "committed": text.committed,
                        "tentative": text.tentative,
                        "audioMs": fed_samples as f64 / SAMPLES_PER_MS,
                        "rtf": rtf(compute, fed_samples),
                    }));
                }
            }
            Err(error) => {
                compute += feed_started.elapsed();
                eprintln!("feed failed: {error}");
            }
        }
    }

    let finalize_started = Instant::now();
    match stream.finalize() {
        Ok(_) => {
            compute += finalize_started.elapsed();
            let text = stream.text();
            emit(serde_json::json!({
                "type": "final",
                "text": format!("{}{}", text.committed, text.tentative),
                "audioMs": fed_samples as f64 / SAMPLES_PER_MS,
                "rtf": rtf(compute, fed_samples),
                "finalizeMs": finalize_started.elapsed().as_secs_f64() * 1000.0,
            }));
        }
        Err(error) => fatal(format!("finalize failed: {error}")),
    }
}
