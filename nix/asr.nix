# Parakeet TDT 0.6B v3 speech-to-text, packaged for the `asr` extension.
#
# The runtime is nixpkgs' sherpa-onnx (ONNX Runtime, CPU) running our own
# `pi_asr.py`; the model is NVIDIA's parakeet-tdt-0.6b-v3 (CC-BY-4.0) exported
# to ONNX and int8-quantized for sherpa-onnx by csukuangfj. Pinned to one
# Hugging Face commit and built as fixed-output derivations, so a device gets
# ~640 MB in the store and never touches the network at inference time — the
# same choice `nixos-config` makes for the parakeet-typing dictation engine.
#
# Why segment: the encoder attends over its whole input, so a 36-minute
# meeting is tens of GB of attention and a single slow decode. `pi_asr.py`
# cuts at silence with silero VAD (also pinned here) and decodes ~30 s spans.
#
# Why not the NeMo/PyTorch route: 2 GB of torch for a 0.6B model at 35-40x
# realtime on int8 is all this task needs.
{
  lib,
  stdenv,
  makeWrapper,
  fetchurl,
  runCommand,
  python313,
  ffmpeg,
}:

let
  hf = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78";

  encoder = fetchurl {
    url = "${hf}/encoder.int8.onnx";
    hash = "sha256-rPwrRFY3fhXQTwJDr1QLf+fJkvjYmNdRzxNMOlX9Ikc=";
  };
  decoder = fetchurl {
    url = "${hf}/decoder.int8.onnx";
    hash = "sha256-F55QxD0aneeciiQUmi+brG61mBgj8qLtiNZVskJI204=";
  };
  joiner = fetchurl {
    url = "${hf}/joiner.int8.onnx";
    hash = "sha256-MWTBP8KCEAlEDSD8tf3Hi/8otNsvjQ8LMpEBcZwJSLM=";
  };
  tokens = fetchurl {
    url = "${hf}/tokens.txt";
    hash = "sha256-1YVEZ56kvGrFY9H1Ret9R0vWz6Rn8KbiwdwcfTfjw10=";
  };
  # Endpoint model for the silence cuts: MIT, 644 kB.
  sileroVad = fetchurl {
    url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
    hash = "sha256-niRJ4Qh0ltjUyrqQfyPgvT942R+lUkebucI6wJy7H9Y=";
  };

  model = runCommand "parakeet-tdt-0.6b-v3-int8" { } ''
    runHook preInstall
    mkdir -p "$out"
    cp ${encoder} "$out/encoder.int8.onnx"
    cp ${decoder} "$out/decoder.int8.onnx"
    cp ${joiner} "$out/joiner.int8.onnx"
    cp ${tokens} "$out/tokens.txt"
    cp ${sileroVad} "$out/silero_vad.onnx"
    runHook postInstall
  '';

  py = python313.withPackages (ps: with ps; [
    sherpa-onnx
    numpy
  ]);
in
stdenv.mkDerivation {
  pname = "pi-asr";
  version = "0.1.0";

  src = ./asr;

  nativeBuildInputs = [ makeWrapper ];
  # Nothing to compile: the CLI is one Python file over sherpa-onnx.
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/pi-asr
    cp pi_asr.py $out/share/pi-asr/
    makeWrapper ${py}/bin/python3 $out/bin/pi-asr \
      --add-flags "$out/share/pi-asr/pi_asr.py" \
      --prefix PATH : "${lib.makeBinPath [ ffmpeg ]}" \
      --set PARAKEET_ASR_MODEL_DIR "${model}"
    runHook postInstall
  '';

  meta = {
    description = "Offline speech-to-text with NVIDIA Parakeet TDT 0.6B v3 (ONNX, CPU)";
    homepage = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3";
    license = lib.licenses.cc-by-40;
    mainProgram = "pi-asr";
  };
}
