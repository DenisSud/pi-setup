# Indra OCR, packaged from source against nixpkgs' Python.
#
# Why not PyPI: indra-ocr depends on opencv-python-headless, which has no
# usable wheel here and would download its own OpenCV anyway. The package is
# pure Python around onnxruntime, so nixpkgs' onnxruntime + opencv4 +
# pypdfium2 are enough — the whole CLI is the upstream `indra_ocr` directory
# placed on PYTHONPATH, with the model files fetched from Hugging Face on the
# first run (~76 MB, cached in $XDG_CACHE_HOME/huggingface).
{
  lib,
  stdenv,
  makeWrapper,
  python313,
  src,
}:
let
  py = python313.withPackages (
    ps: with ps; [
      onnxruntime
      opencv4
      pypdfium2
      numpy
      huggingface-hub
    ]
  );
in
stdenv.mkDerivation {
  pname = "indra-ocr";
  version = "1.1.2";

  inherit src;

  nativeBuildInputs = [ makeWrapper ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/indra-ocr $out/bin
    cp -r indra_ocr $out/share/indra-ocr/
    makeWrapper ${py}/bin/python $out/bin/indra-ocr \
      --add-flags "-c 'import sys; from indra_ocr.cli import main; sys.exit(main())'" \
      --prefix PYTHONPATH : "$out/share/indra-ocr"
    runHook postInstall
  '';

  meta = {
    description = "Fast CPU OCR (ONNX) for PDFs and images, from datalab-to/indra";
    homepage = "https://github.com/datalab-to/indra";
    license = lib.licenses.asl20;
    mainProgram = "indra-ocr";
  };
}
