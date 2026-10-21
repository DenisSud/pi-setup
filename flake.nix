{
  description = "Local model binaries for pi-setup (Indra OCR; Parakeet ASR next)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  # Pinned by tag, and by flake.lock's rev. Bump both together.
  inputs.indra = {
    url = "github:datalab-to/indra/v1.1.2";
    flake = false;
  };

  outputs = { self, nixpkgs, indra }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAll (pkgs: {
        indra-ocr = pkgs.callPackage ./nix/indra-ocr.nix { src = indra; };
        default = self.packages.${pkgs.system}.indra-ocr;
      });

      apps = forAll (pkgs: {
        indra-ocr = {
          type = "app";
          program = "${self.packages.${pkgs.system}.indra-ocr}/bin/indra-ocr";
        };
        default = self.apps.${pkgs.system}.indra-ocr;
      });
    };
}
