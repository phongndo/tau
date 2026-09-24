{
  description = "Tau Terminal — A super-performant terminal emulator with Ghostty WASM";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        linuxElectronRuntimeLibs = pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
          alsa-lib
          atk
          at-spi2-atk
          cairo
          cups
          dbus
          expat
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libglvnd
          libgbm
          libxkbcommon
          mesa
          nspr
          nss
          pango
          udev
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
        ]);
        linuxElectronLibraryPath = pkgs.lib.makeLibraryPath linuxElectronRuntimeLibs;
        linuxElectronMesa = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.mesa}";
        # Keep package.json, CI and the dev shell on the same Bun release without
        # updating unrelated nixpkgs packages. Update these hashes when bumping Bun.
        bunVersion = pkgs.lib.removePrefix "bun@" (builtins.fromJSON (builtins.readFile ./package.json)).packageManager;
        bunTargets = {
          aarch64-darwin = { target = "darwin-aarch64"; hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8="; };
          x86_64-darwin = { target = "darwin-x64-baseline"; hash = "sha256-utW71s8U0JgNEV9ZVMn/kE32GdXplNLaH/zNPzFjALA="; };
          aarch64-linux = { target = "linux-aarch64"; hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac="; };
          x86_64-linux = { target = "linux-x64"; hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM="; };
        };
        bun = pkgs.bun.overrideAttrs (_: {
          version = bunVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${bunTargets.${system}.target}.zip";
            inherit (bunTargets.${system}) hash;
          };
        });
      in
      {
        # ── Dev shell (nix develop) ──
        devShells.default = pkgs.mkShell {
          name = "tau";

          # Build-time dependencies
          nativeBuildInputs = (with pkgs; [
            nodejs_24 # LTS compatibility for third-party Node shebangs, not Tau's script runtime
            nixd # Nix language server
            bun # Package manager, TypeScript runtime, test runner and benchmark bundler
            unzip # Electron's installer extracts its downloaded runtime with unzip
            zig_0_16 # taud daemon + pinned Ghostty native/WASM builds
            zls_0_16 # Zig language server matching Zig 0.16.x
            nixpkgs-fmt # nix fmt / CI format check
          ]) ++ pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
            patchelf # Repair npm Electron's Linux interpreter in the dev shell
          ]);

          # Runtime dependencies for Electron
          # Linux-specific; macOS uses system frameworks.
          buildInputs = linuxElectronRuntimeLibs;

          shellHook = ''
            if [ "$(uname -s)" = "Linux" ]; then
              # VS Code and some tooling set this for extension hosts. It makes
              # Electron behave like Node, which breaks the app main process.
              unset ELECTRON_RUN_AS_NODE

              electron_append_path_without_nix_glibc() {
                local current_path="''${1:-}"
                local next_path=""
                local entry=""
                while [ -n "$current_path" ]; do
                  entry="''${current_path%%:*}"
                  if [ "$entry" = "$current_path" ]; then
                    current_path=""
                  else
                    current_path="''${current_path#*:}"
                  fi
                  case "$entry" in
                    *-glibc-*/lib|*-glibc-*/lib64) ;;
                    *) next_path="''${next_path:+$next_path:}$entry" ;;
                  esac
                done
                printf '%s' "$next_path"
              }

              electron_gl_lib_path=""
              for path in /run/opengl-driver/lib /run/opengl-driver-32/lib; do
                if [ -d "$path" ]; then
                  electron_gl_lib_path="''${electron_gl_lib_path:+$electron_gl_lib_path:}$path"
                fi
              done
              electron_inherited_ld_library_path="$(electron_append_path_without_nix_glibc "''${LD_LIBRARY_PATH:-}")"
              export LD_LIBRARY_PATH="${linuxElectronLibraryPath}''${electron_gl_lib_path:+:$electron_gl_lib_path}''${electron_inherited_ld_library_path:+:$electron_inherited_ld_library_path}"

              electron_egl_vendor_dirs=""
              for path in /run/opengl-driver/share/glvnd/egl_vendor.d /run/opengl-driver-32/share/glvnd/egl_vendor.d ${linuxElectronMesa}/share/glvnd/egl_vendor.d; do
                if [ -d "$path" ]; then
                  electron_egl_vendor_dirs="''${electron_egl_vendor_dirs:+$electron_egl_vendor_dirs:}$path"
                fi
              done
              export __EGL_VENDOR_LIBRARY_DIRS="$electron_egl_vendor_dirs''${__EGL_VENDOR_LIBRARY_DIRS:+:$__EGL_VENDOR_LIBRARY_DIRS}''${EGL_VENDOR_LIBRARY_DIRS:+:$EGL_VENDOR_LIBRARY_DIRS}"
              export LIBGL_DRIVERS_PATH="${linuxElectronMesa}/lib/dri''${LIBGL_DRIVERS_PATH:+:$LIBGL_DRIVERS_PATH}"
            fi

            echo "🖥  Tau Terminal dev shell"
            echo "   node:  $(node --version)"
            echo "   bun:   $(bun --version)"
            echo "   zig:   $(zig version)"
            echo "   zls:   $(zls --version)"
            echo ""
            echo "   bun install && bun run dev"
            echo "   bun run check        # TS + Zig lint/format/type/test checks"
            echo "   bun run zig:lsp      # verify Zig language server availability"
            echo "   TypeScript LSP: ./node_modules/.bin/tsc --lsp --stdio (after bun install)"
            echo ""
          '';
        };

        checks.bun-runtime = pkgs.runCommand "tau-bun-runtime" { } ''
          export HOME="$TMPDIR"
          test "$(${bun}/bin/bun --version)" = '${bunVersion}'
          ${bun}/bin/bun -e 'const version: string = Bun.version; if (version !== "${bunVersion}") process.exit(1)'
          touch $out
        '';

        # ── Formatter (nix fmt) ──
        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
