{
  description = "osrs-browser dev shell (Node + Playwright browsers for NixOS)";
  inputs.nixpkgs.url = "nixpkgs";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
          # npm's @playwright/test must match this version (see package.json).
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          # Nix-built Firefox only finds a WebGL driver through libglvnd plus the system's driver dir.
          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.libglvnd}/lib:/run/opengl-driver/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            export __EGL_VENDOR_LIBRARY_DIRS=/run/opengl-driver/share/glvnd/egl_vendor.d
          '';
        };
      });
    };
}
