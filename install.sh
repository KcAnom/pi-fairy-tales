#!/bin/sh
# Fairy Tales setup: installs the package into pi and creates the `ftales` launcher.
# Safe to re-run. Requires pi (npm i -g @earendil-works/pi-coding-agent).
set -e

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not installed. Run:  npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

# Install this package into pi (from wherever this script lives).
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
pi install "$PKG_DIR"

# Create the branded launcher in ~/bin (survives Node upgrades).
mkdir -p "$HOME/bin"
printf '#!/bin/sh\n# Fairy Tales — branded pi launcher\nexport FTALES=1\nexec pi "$@"\n' > "$HOME/bin/ftales"
chmod +x "$HOME/bin/ftales"

case ":$PATH:" in
  *":$HOME/bin:"*) ;;
  *) echo 'NOTE: add ~/bin to your PATH, e.g.:  echo '\''export PATH="$HOME/bin:$PATH"'\'' >> ~/.zshrc' ;;
esac

# macOS: create ~/Applications/ftales.app so Spotlight (Cmd+Space → "ftales")
# launches Fairy Tales directly in a terminal window (iTerm2 if present,
# otherwise Terminal.app).
if [ "$(uname)" = "Darwin" ]; then
  APP="$HOME/Applications/ftales.app"
  mkdir -p "$APP/Contents/MacOS"
  cat > "$APP/Contents/Info.plist" <<'FTALES_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ftales</string>
  <key>CFBundleDisplayName</key><string>ftales</string>
  <key>CFBundleIdentifier</key><string>dev.pi.fairy-tales.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>ftales</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
FTALES_PLIST
  cat > "$APP/Contents/MacOS/ftales" <<'FTALES_APP'
#!/bin/sh
# ftales.app — launch Fairy Tales in a terminal window from Spotlight/Dock.
# GUI apps get a minimal PATH, so resolve pi explicitly.
PI_BIN="$(command -v pi 2>/dev/null)"
[ -z "$PI_BIN" ] && PI_BIN="$(ls -t "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | head -1)"
if [ -z "$PI_BIN" ]; then
  for p in /opt/homebrew/bin/pi /usr/local/bin/pi; do
    [ -x "$p" ] && PI_BIN="$p" && break
  done
fi
if [ -z "$PI_BIN" ]; then
  osascript -e 'display alert "ftales" message "pi is not installed (npm i -g @earendil-works/pi-coding-agent)"' >/dev/null 2>&1
  exit 1
fi
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
HANDOFF="${TMPDIR:-/tmp}/ftales-app-$$.command"
{
  printf '#!/bin/sh\n'
  # Some terminals run .command files with stdout piped, which kills a TUI —
  # rebind to the tty (no-op when already attached). Self-delete is delayed
  # because the file is read incrementally.
  printf 'exec > "$(tty)" 2>&1\n'
  printf '( sleep 5; rm -f "$0" ) &\n'
  printf 'cd %s || exit 1\n' "$(sq "$HOME")"
  printf 'FTALES=1 exec %s\n' "$(sq "$PI_BIN")"
} > "$HANDOFF"
chmod +x "$HANDOFF"
if [ -d "/Applications/iTerm.app" ]; then
  exec open -a iTerm "$HANDOFF"
fi
exec open -a Terminal "$HANDOFF"
FTALES_APP
  chmod +x "$APP/Contents/MacOS/ftales"
  echo "✦ ftales.app created — launch from Spotlight: Cmd+Space, type \"ftales\""
fi

echo ""
echo "✦ Fairy Tales installed."
echo "  plain harness:  pi"
echo "  full enchantment:  ftales"
echo "  configure models/roles/rules:  ~/.pi/agent/fairy-tales.json (see README)"
