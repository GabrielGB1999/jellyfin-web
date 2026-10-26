#!/usr/bin/env bash
#
# Builds this jellyfin-web fork and makes an apt-installed Jellyfin server use it.
#
# The server package is left untouched: the built web client is installed to a
# separate directory and the server is pointed at it through JELLYFIN_WEB_DIR in
# /etc/default/jellyfin, so apt upgrades do not overwrite it.
#
# Usage:
#   ./install-on-server.sh              build and install the branch matching the server version
#   ./install-on-server.sh --uninstall  switch back to the stock web client from the package
#   ./install-on-server.sh --help       show all options
#
# Can be run straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/GabrielGB1999/jellyfin-web/ccr-8cd7234d-pogewb/install-on-server.sh | bash

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/GabrielGB1999/jellyfin-web.git}"
# Branch to build for each server version
BRANCH_10_11="pdf-reader-10.11.z"
BRANCH_12="pdf-reader-12.z"
BRANCH_13="ccr-8cd7234d-pogewb"

INSTALL_DIR="${INSTALL_DIR:-/opt/jellyfin-web-custom}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/jellyfin-web-build}"
DEFAULTS_FILE="${DEFAULTS_FILE:-/etc/default/jellyfin}"
STOCK_WEB_DIR="/usr/share/jellyfin/web"
SERVICE="jellyfin"
NVM_VERSION="v0.40.1"

BRANCH=""
UNINSTALL=0
SKIP_RESTART=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: install-on-server.sh [options]

Options:
  --branch NAME     Build this branch instead of picking one from the server version
  --install-dir DIR Where the built web client is installed (default: $INSTALL_DIR)
  --build-dir DIR   Where the repository is cloned and built (default: $BUILD_DIR)
  --no-restart      Do not restart the jellyfin service
  --uninstall       Point the server back at the stock web client ($STOCK_WEB_DIR)
  -h, --help        Show this help
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
            --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
            --build-dir) BUILD_DIR="${2:?--build-dir needs a value}"; shift 2 ;;
            --no-restart) SKIP_RESTART=1; shift ;;
            --uninstall) UNINSTALL=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) usage >&2; die "Unknown option: $1" ;;
        esac
    done
}

# Runs a command as root, using sudo when not already root
as_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

check_server_installed() {
    command -v dpkg-query >/dev/null || die "dpkg-query not found, this script supports Debian/Ubuntu apt installs only."
    dpkg-query -W -f='${Status}' jellyfin-server 2>/dev/null | grep -q 'install ok installed' \
        || die "The jellyfin-server package is not installed."
    command -v systemctl >/dev/null || die "systemctl not found, the jellyfin service must be managed by systemd."
}

server_version() {
    dpkg-query -W -f='${Version}' jellyfin-server
}

# Picks the branch whose jellyfin-web version matches the server version
pick_branch() {
    local version="$1"

    case "$version" in
        10.11.*) echo "$BRANCH_10_11" ;;
        12.*) echo "$BRANCH_12" ;;
        13.*) echo "$BRANCH_13" ;;
        *) die "No branch is known for jellyfin-server $version. Pass one with --branch." ;;
    esac
}

install_packages() {
    local missing=()
    local cmd
    for cmd in git rsync curl; do
        command -v "$cmd" >/dev/null || missing+=("$cmd")
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        log "Installing ${missing[*]}"
        as_root apt-get update -qq
        as_root apt-get install -y -qq "${missing[@]}"
    fi
}

checkout_repo() {
    local branch="$1"

    if [[ -d "$BUILD_DIR/.git" ]]; then
        log "Updating $BUILD_DIR to $branch"
        git -C "$BUILD_DIR" remote set-url origin "$REPO_URL"
        git -C "$BUILD_DIR" fetch --depth 1 origin "$branch"
        git -C "$BUILD_DIR" checkout -q -B "$branch" FETCH_HEAD
        git -C "$BUILD_DIR" reset -q --hard FETCH_HEAD
        git -C "$BUILD_DIR" clean -q -fdx -e node_modules
    else
        log "Cloning $REPO_URL ($branch) into $BUILD_DIR"
        mkdir -p "$(dirname "$BUILD_DIR")"
        git clone --depth 1 --branch "$branch" "$REPO_URL" "$BUILD_DIR"
    fi
}

# Prints the minimum Node.js major version from the engines field of package.json
required_node_major() {
    local engine
    engine=$(sed -n 's/.*"node": *"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$BUILD_DIR/package.json" | head -n 1)
    echo "${engine:-20}"
}

node_major() {
    command -v node >/dev/null || { echo 0; return; }
    node --version | sed 's/^v\([0-9]*\).*/\1/'
}

# Makes a Node.js version satisfying package.json available, installing it with nvm if needed
ensure_node() {
    local required
    required=$(required_node_major)

    if [[ $(node_major) -ge $required ]]; then
        log "Using Node.js $(node --version)"
        return
    fi

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        log "Installing nvm $NVM_VERSION to $NVM_DIR (Node.js $required+ is required)"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
    fi

    # nvm.sh is not compatible with nounset
    set +u
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    log "Installing Node.js $required with nvm"
    nvm install "$required" >/dev/null
    nvm use "$required" >/dev/null
    set -u

    [[ $(node_major) -ge $required ]] || die "Could not set up Node.js $required."
    log "Using Node.js $(node --version)"
}

build_web() {
    log "Installing dependencies (this can take a few minutes)"
    (cd "$BUILD_DIR" && npm ci --no-audit --no-fund)

    log "Building the web client"
    (cd "$BUILD_DIR" && npm run build:production)

    [[ -f "$BUILD_DIR/dist/index.html" ]] || die "The build did not produce dist/index.html."
}

install_web() {
    log "Installing the web client to $INSTALL_DIR"
    as_root mkdir -p "$INSTALL_DIR"
    as_root rsync -a --delete "$BUILD_DIR/dist/" "$INSTALL_DIR/"
    as_root chmod -R a+rX "$INSTALL_DIR"
}

# Sets KEY="VALUE" in the defaults file, replacing an existing (possibly commented out) line
set_default() {
    local key="$1"
    local value="$2"
    local file="$DEFAULTS_FILE"

    if as_root grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$file"; then
        as_root sed -i -E "0,/^[[:space:]]*#?[[:space:]]*${key}=.*/s||${key}=\"${value}\"|" "$file"
    else
        printf '%s="%s"\n' "$key" "$value" | as_root tee -a "$file" >/dev/null
    fi
}

configure_web_dir() {
    local web_dir="$1"
    local file="$DEFAULTS_FILE"

    if [[ ! -f "$file" ]]; then
        log "Creating $file"
        as_root touch "$file"
    elif [[ ! -f "$file.before-custom-web" ]]; then
        log "Backing up $file to $file.before-custom-web"
        as_root cp -p "$file" "$file.before-custom-web"
    fi

    log "Pointing the server at $web_dir"
    set_default JELLYFIN_WEB_DIR "$web_dir"

    # Older packages pass the web directory as a command line option, which takes precedence
    if as_root grep -qE '^[[:space:]]*JELLYFIN_WEB_OPT=' "$file"; then
        set_default JELLYFIN_WEB_OPT "--webdir=$web_dir"
    fi
}

check_service_config() {
    local unit
    unit=$(systemctl cat "$SERVICE" 2>/dev/null || true)

    if ! grep -q "EnvironmentFile=.*$DEFAULTS_FILE" <<<"$unit"; then
        warn "The $SERVICE service does not load $DEFAULTS_FILE, the web directory setting may be ignored."
        warn "Check it with: systemctl cat $SERVICE"
    fi

    if grep -qE 'ExecStart=.*--webdir[= ]+/' <<<"$unit"; then
        warn "The $SERVICE service sets --webdir directly in ExecStart, which overrides $DEFAULTS_FILE."
        warn "Change it with: sudo systemctl edit --full $SERVICE"
    fi
}

restart_server() {
    if [[ $SKIP_RESTART -eq 1 ]]; then
        log "Skipping restart, run: sudo systemctl restart $SERVICE"
        return
    fi

    log "Restarting $SERVICE"
    as_root systemctl restart "$SERVICE"

    for _ in $(seq 1 30); do
        if curl -fsS -o /dev/null "http://localhost:8096/web/index.html" 2>/dev/null; then
            log "Jellyfin is serving the web client on port 8096"
            return
        fi
        sleep 2
    done

    systemctl is-active --quiet "$SERVICE" \
        || die "$SERVICE did not start, check: journalctl -u $SERVICE -e"
    warn "Jellyfin is running but did not answer on http://localhost:8096/web/ (maybe it uses another port)."
}

main() {
    parse_args "$@"
    check_server_installed

    if [[ $UNINSTALL -eq 1 ]]; then
        configure_web_dir "$STOCK_WEB_DIR"
        restart_server
        log "Done. The server uses the stock web client again ($INSTALL_DIR was left in place)."
        return
    fi

    local version
    version=$(server_version)
    log "Found jellyfin-server $version"

    [[ -n "$BRANCH" ]] || BRANCH=$(pick_branch "$version")
    log "Using branch $BRANCH"

    install_packages
    checkout_repo "$BRANCH"
    ensure_node
    build_web
    install_web
    configure_web_dir "$INSTALL_DIR"
    check_service_config
    restart_server

    log "Done. Reload Jellyfin in your browser with Ctrl+Shift+R to load the new web client."
    log "To switch back to the stock web client run: $BUILD_DIR/install-on-server.sh --uninstall"
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
    main "$@"
fi
