//! PCM on stdin -> streaming transcript as JSONL on stdout.
//!
//! Exists to answer whether transcribe-cpp streams from a process spawned by
//! something else (a Node server), rather than in-process as Handy uses it. If it
//! does, the engine can live on the T3 server and serve every client.
//!
//! Input: raw 16 kHz mono f32 little-endian, read continuously until EOF.
//! Output: one JSON object per line, {committed, tentative, ms} while streaming,
//! then a final {type: "final"} after finalize.

use std::io::{self, Read, Write};
use std::time::Instant;

use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, StreamOptions};

/// 16 kHz mono f32 — 100ms per chunk, matching a typical capture cadence.
const FRAME_SAMPLES: usize = 1600;

fn emit(value: serde_json::Value) {
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
    let _ = stdout.flush();
}

fn main() {
    let model_path = match std::env::args().nth(1) {
        Some(path) => path,
        None => {
            eprintln!("usage: parakeet-sidecar <model.gguf>");
            std::process::exit(2);
        }
    };

    transcribe_cpp::init_logging();
    if let Err(error) = transcribe_cpp::init_backends_default() {
        eprintln!("init_backends_default failed: {error}");
    }

    // --cpu forces the ggml CPU path, which is the same code a GPU-less Linux
    // server would run. Comparing against Metal gives the GPU speedup factor and
    // says whether a server can keep up with live audio (RTF must stay under 1.0).
    let force_cpu = std::env::args().any(|arg| arg == "--cpu");
    let model_options = if force_cpu {
        ModelOptions {
            backend: Backend::Cpu,
            // gpu_device is a GPU-backend registry index; CPU ignores it but
            // rejects out-of-range values, so it must be 0 rather than -1.
            gpu_device: 0,
        }
    } else {
        ModelOptions::default()
    };

    let load_started = Instant::now();
    let model = match Model::load_with(&model_path, &model_options) {
        Ok(model) => model,
        Err(error) => {
            eprintln!("failed to load model: {error}");
            std::process::exit(1);
        }
    };
    let backend = model.backend();
    let mut session = match model.session() {
        Ok(session) => session,
        Err(error) => {
            eprintln!("failed to create session: {error}");
            std::process::exit(1);
        }
    };
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let capabilities = session.model().capabilities();
    emit(serde_json::json!({
        "type": "ready",
        "backend": format!("{backend:?}"),
        "loadMs": load_ms,
        "supportsStreaming": capabilities.supports_streaming,
    }));

    let run_options = RunOptions::default();
    let mut stream = match session.stream(&run_options, &StreamOptions::default()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("failed to begin stream: {error}");
            std::process::exit(1);
        }
    };

    let stream_started = Instant::now();
    let mut stdin = io::stdin().lock();
    let mut bytes = vec![0u8; FRAME_SAMPLES * 4];
    let mut samples = vec![0f32; FRAME_SAMPLES];
    let mut fed_samples: u64 = 0;
    let mut first_text_ms: Option<f64> = None;

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
                if update.committed_changed || update.tentative_changed {
                    let text = stream.text();
                    let elapsed = stream_started.elapsed().as_secs_f64() * 1000.0;
                    if first_text_ms.is_none() {
                        first_text_ms = Some(elapsed);
                    }
                    emit(serde_json::json!({
                        "type": "update",
                        "committed": text.committed,
                        "tentative": text.tentative,
                        "ms": elapsed,
                        "feedMs": feed_started.elapsed().as_secs_f64() * 1000.0,
                        "audioMs": fed_samples as f64 / 16.0,
                    }));
                }
            }
            Err(error) => eprintln!("feed failed: {error}"),
        }
    }

    let finalize_started = Instant::now();
    match stream.finalize() {
        Ok(_) => {
            let text = stream.text();
            emit(serde_json::json!({
                "type": "final",
                "text": format!("{}{}", text.committed, text.tentative),
                "finalizeMs": finalize_started.elapsed().as_secs_f64() * 1000.0,
                "totalMs": stream_started.elapsed().as_secs_f64() * 1000.0,
                "firstTextMs": first_text_ms,
                "audioMs": fed_samples as f64 / 16.0,
            }));
        }
        Err(error) => eprintln!("finalize failed: {error}"),
    }
}
