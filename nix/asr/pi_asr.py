"""pi-asr — NVIDIA Parakeet TDT 0.6B v3 speech-to-text, locally.

Decodes any format ffmpeg understands to 16 kHz mono, cuts the audio at
silence with silero VAD, and runs a NeMo transducer through sherpa-onnx
(CPU, int8). The model is NVIDIA's parakeet-tdt-0.6b-v3 (CC-BY-4.0),
exported and quantized for sherpa-onnx by csukuangfj, pinned in `asr.nix`.

Why segment before decoding: the encoder attends over the whole input, so a
36-minute meeting is quadratic memory (tens of GB) and a slow single decode.
Cutting at silence keeps each chunk under `--chunk-seconds` (default 30) and
matches how the model is meant to be used.

Output is one line per utterance (NeMo transducers emit no punctuation).
`--json` adds segment start/end times, `--timestamps` prefixes each line.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SAMPLE_RATE = 16000
MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
VAD_FILE = "silero_vad.onnx"


class AsrError(RuntimeError):
    """A failure the caller can act on; the message names the fix."""


def model_dir() -> Path:
    value = os.environ.get("PARAKEET_ASR_MODEL_DIR")
    if not value:
        raise AsrError(
            "PARAKEET_ASR_MODEL_DIR is not set — run the packaged binary "
            "(`nix profile install ~/dev/pi-setup#asr`), not this script"
        )
    path = Path(value)
    missing = [name for name in (*MODEL_FILES, VAD_FILE) if not (path / name).is_file()]
    if missing:
        raise AsrError(f"model files missing in {path}: {', '.join(missing)}")
    return path


def decode_audio(path: Path) -> "object":
    """Any audio/video file -> float32 mono 16 kHz, via ffmpeg."""
    import numpy as np

    if not path.is_file():
        raise AsrError(f"no such file: {path}")
    proc = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error",
            "-i", str(path),
            "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise AsrError(f"ffmpeg could not decode {path}: {' '.join(detail)}")
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    if samples.size == 0:
        raise AsrError(f"{path} holds no audio")
    return samples


def speech_chunks(samples, chunk_seconds: float, model_path: Path):
    """Group VAD speech segments into chunks of at most `chunk_seconds`."""
    import numpy as np
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(model_path / VAD_FILE)
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_silence_duration = 0.5
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = chunk_seconds
    cfg.sample_rate = SAMPLE_RATE
    cfg.num_threads = 1
    cfg.provider = "cpu"

    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=600)
    spans = []
    step = SAMPLE_RATE  # 1 s frames: accept_waveform wants 512-sample alignments anyway
    for start in range(0, samples.size, step):
        vad.accept_waveform(np.ascontiguousarray(samples[start:start + step]))
        while not vad.empty():
            segment = vad.front
            spans.append((segment.start, segment.start + len(segment.samples)))
            vad.pop()
    vad.flush()
    while not vad.empty():
        segment = vad.front
        spans.append((segment.start, segment.start + len(segment.samples)))
        vad.pop()
    if not spans:
        return []

    # Pad each utterance a little so the first and last phoneme survive.
    pad = int(0.2 * SAMPLE_RATE)
    limit = int(chunk_seconds * SAMPLE_RATE)
    chunks = []
    for begin, end in spans:
        begin = max(0, begin - pad)
        end = min(samples.size, end + pad)
        if chunks and end - chunks[-1][0] <= limit and begin - chunks[-1][1] <= pad:
            chunks[-1][1] = end
        else:
            chunks.append([begin, end])
    # A span can still exceed the limit when VAD merges long speech.
    out = []
    for begin, end in chunks:
        while end - begin > limit:
            out.append((begin, begin + limit))
            begin += limit
        out.append((begin, end))
    return out


def build_recognizer(model_path: Path, threads: int):
    import sherpa_onnx

    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model_path / "encoder.int8.onnx"),
        decoder=str(model_path / "decoder.int8.onnx"),
        joiner=str(model_path / "joiner.int8.onnx"),
        tokens=str(model_path / "tokens.txt"),
        model_type="nemo_transducer",
        decoding_method="greedy_search",
        num_threads=threads,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        provider="cpu",
    )


def transcribe(samples, chunk_seconds: float, threads: int, verbose: bool):
    import numpy as np

    model_path = model_dir()
    started = time.monotonic()
    recognizer = build_recognizer(model_path, threads)
    if verbose:
        print(f"pi-asr: model loaded in {time.monotonic() - started:.1f} s", file=sys.stderr)

    duration = samples.size / SAMPLE_RATE
    if duration <= chunk_seconds:
        chunks = [(0, samples.size)]
    else:
        chunks = speech_chunks(samples, chunk_seconds, model_path)
        if not chunks:
            raise AsrError(f"no speech found in {duration:.0f} s of audio")

    segments = []
    decoded = time.monotonic()
    for index, (begin, end) in enumerate(chunks, 1):
        audio = np.ascontiguousarray(samples[begin:end])
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        recognizer.decode_stream(stream)
        result = stream.result
        text = (result.text or "").strip()
        if not text:
            continue
        times = list(getattr(result, "timestamps", []) or [])
        chunk_start = begin / SAMPLE_RATE
        segments.append(
            {
                "start": round(chunk_start + (times[0] if times else 0.0), 2),
                "end": round(chunk_start + (times[-1] if times else (end - begin) / SAMPLE_RATE), 2),
                "text": text,
            }
        )
        if verbose:
            print(f"pi-asr: {index}/{len(chunks)} chunks, {len(segments)} with speech", file=sys.stderr)

    if not segments:
        raise AsrError(f"no speech recognised in {duration:.0f} s of audio")
    return segments, duration, time.monotonic() - decoded


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="pi-asr",
        description="Transcribe an audio or video file with Parakeet TDT 0.6B v3 (CPU, offline).",
    )
    parser.add_argument("path", help="audio or video file (anything ffmpeg reads)")
    parser.add_argument("--json", action="store_true", help="JSON: text, duration, segment start/end")
    parser.add_argument("--timestamps", action="store_true", help="prefix each line with its start time")
    parser.add_argument("--chunk-seconds", type=float, default=30.0,
                        help="cut the audio at silence into chunks of at most this many seconds (default 30)")
    parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 4),
                        help="encoder threads (default: cores, capped at 8)")
    parser.add_argument("--verbose", action="store_true", help="progress on stderr")
    args = parser.parse_args(argv)

    try:
        path = Path(args.path).expanduser()
        samples = decode_audio(path)
        segments, duration, elapsed = transcribe(samples, args.chunk_seconds, args.threads, args.verbose)
    except AsrError as err:
        print(f"pi-asr: {err}", file=sys.stderr)
        return 1

    text = " ".join(segment["text"] for segment in segments)
    if args.json:
        print(
            json.dumps(
                {
                    "path": str(path),
                    "duration": round(duration, 2),
                    "text": text,
                    "segments": segments,
                    "elapsed": round(elapsed, 2),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    for segment in segments:
        if args.timestamps:
            print(f"[{segment['start']:7.1f}] {segment['text']}")
        else:
            print(segment["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
