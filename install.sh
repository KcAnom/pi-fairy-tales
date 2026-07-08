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

echo ""
echo "✦ Fairy Tales installed."
echo "  plain harness:  pi"
echo "  full enchantment:  ftales"
echo "  configure models/roles/rules:  ~/.pi/agent/fairy-tales.json (see README)"
