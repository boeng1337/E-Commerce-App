# AliExpress Listing Manager

Desktop app (Tauri + React) for managing AliExpress listings alongside manually-added listings.

## Local setup (Linux)

**Arch:**
```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg
```

**Debian/Ubuntu:**
```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf build-essential curl wget file libssl-dev
```

Then, either distro:

```bash
# Rust (if you don't already have it — rustup is also on the AUR)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node deps
npm install

# Run in dev mode (hot reload)
npm run tauri dev
```

Note: on Arch, `libappindicator-gtk3` may need to come from the AUR
(`yay -S libappindicator-gtk3`) if it's not in your enabled repos.

## Regenerate full icon set

The repo ships with placeholder PNG icons only. Before building for Windows/macOS,
generate the full icon set (ico/icns included) from a source PNG:

```bash
npm run tauri icon path/to/your/logo.png
```

## Wiring up the AliExpress API

Edit `src-tauri/src/lib.rs`, function `sync_aliexpress`. That's the one place
you need to touch to:
1. Load your AliExpress App Key / App Secret / access token (env vars or a
   local config file — never commit credentials).
2. Sign and send the request per AliExpress Open Platform's signing spec.
3. Parse the response into `Listing` structs and return them.

Store secrets as GitHub Actions repository secrets if you want CI to have
access to them (see `.github/workflows/release.yml`).

## Building locally

```bash
npm run tauri build
```

Output binaries land in `src-tauri/target/release/bundle/`.

## Releasing via GitHub Actions

Push a tag matching `v*`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers `.github/workflows/release.yml`, which builds Linux (AppImage +
deb), Windows (msi/exe), and macOS (universal dmg) binaries and attaches them
as a **draft** GitHub Release. Review and publish it manually.

Every push/PR to `main` also runs `.github/workflows/ci.yml`, a fast
Linux-only check that just makes sure the frontend type-checks and the Rust
backend compiles — it doesn't produce release artifacts.
