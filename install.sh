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
cat > "$HOME/bin/ftales" <<'FTALES_LAUNCHER'
#!/bin/sh
# Fairy Tales — branded pi launcher (lives in ~/bin, survives Node upgrades)
export FTALES=1

# Terminal.app can't copy-on-select. If iTerm2 is installed, hand this session
# to a new iTerm2 window (via a self-deleting .command file — no automation
# permissions needed) so drag-select → release → clipboard just works.
# Opt out: FTALES_NO_ITERM=1. Skipped when args are given.
if [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ] && [ -d "/Applications/iTerm.app" ] \
  && [ -z "${FTALES_NO_ITERM:-}" ] && [ $# -eq 0 ] && [ -t 1 ]; then
  PI_BIN="$(command -v pi)" || PI_BIN=""
  if [ -n "$PI_BIN" ]; then
    # Single-quote a string for safe embedding in a generated sh script.
    sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
    HANDOFF="${TMPDIR:-/tmp}/ftales-handoff-$$.command"
    {
      printf '#!/bin/sh\n'
      printf 'rm -f "$0"\n'
      printf 'cd %s || exit 1\n' "$(sq "$PWD")"
      printf 'FTALES=1 exec %s\n' "$(sq "$PI_BIN")"
    } > "$HANDOFF"
    chmod +x "$HANDOFF"
    echo "✦ Reopening in iTerm2 (copy-on-select works there). FTALES_NO_ITERM=1 to stay here."
    exec open -a iTerm "$HANDOFF"
  fi
fi

exec pi "$@"
FTALES_LAUNCHER
chmod +x "$HOME/bin/ftales"

case ":$PATH:" in
  *":$HOME/bin:"*) ;;
  *) echo 'NOTE: add ~/bin to your PATH, e.g.:  echo '\''export PATH="$HOME/bin:$PATH"'\'' >> ~/.zshrc' ;;
esac

# macOS Terminal.app can't copy-on-select (drag text → released → clipboard).
# Offer iTerm2 — strictly opt-in, only interactively, and only when brew exists.
if [ "$(uname)" = "Darwin" ] && [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ] \
  && [ ! -d "/Applications/iTerm.app" ] && command -v brew >/dev/null 2>&1 && [ -t 0 ]; then
  printf "\nTerminal.app cannot auto-copy mouse selections. Install iTerm2 (drag-select copies on release)? [y/N] "
  read -r _ft_ans
  case "$_ft_ans" in
    y|Y)
      brew install --cask iterm2
      defaults write com.googlecode.iterm2 CopySelection -bool true
      echo "✓ iTerm2 installed with copy-on-select enabled — run ftales inside iTerm2."
      ;;
    *) echo "Skipped. Later:  brew install --cask iterm2  (copy-on-select is on by default)" ;;
  esac
fi

echo ""
echo "✦ Fairy Tales installed."
echo "  plain harness:  pi"
echo "  full enchantment:  ftales"
echo "  configure models/roles/rules:  ~/.pi/agent/fairy-tales.json (see README)"
