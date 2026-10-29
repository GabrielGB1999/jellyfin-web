#!/usr/bin/env bash
#
# Builds this jellyfin-web checkout and makes an apt-installed Jellyfin server use it.
#
# The server package is left untouched: the built web client is installed to a
# separate directory and a systemd drop-in mounts it over the packaged web client
# for the jellyfin service only. This works however the package passes the web
# directory to the server, and apt upgrades do not undo it.
#
# Usage, from your clone of this repository:
#   ./install-on-server.sh              build this checkout and install it
#   ./install-on-server.sh --uninstall  switch back to the stock web client from the package
#   ./install-on-server.sh --help       show all options
#
# Run it as your normal user, it asks for sudo when it needs it.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/GabrielGB1999/jellyfin-web.git}"
# Branch to build for each server version
BRANCH_10_11="pdf-reader-10.11.z"
BRANCH_12="pdf-reader-12.z"
BRANCH_13="ccr-8cd7234d-pogewb"

DEFAULT_INSTALL_DIR="/opt/jellyfin-web-custom"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
# Only used when the script is not run from a checkout of this repository
CLONE_DIR="${CLONE_DIR:-$HOME/.cache/jellyfin-web-build}"
DEFAULTS_FILE="${DEFAULTS_FILE:-/etc/default/jellyfin}"
DROPIN_DIR="${DROPIN_DIR:-/etc/systemd/system/jellyfin.service.d}"
DROPIN_FILE="$DROPIN_DIR/custom-web.conf"
JELLYFIN_CONFIG_DIR="${JELLYFIN_CONFIG_DIR:-/etc/jellyfin}"
FALLBACK_WEB_DIR="/usr/share/jellyfin/web"
SERVICE="jellyfin"
NVM_VERSION="v0.40.1"
# File that only exists in checkouts containing the new PDF reader
READER_MARKER="src/plugins/pdfPlayer/PdfControls.tsx"

BRANCH=""
UNINSTALL=0
SKIP_RESTART=0
SKIP_UPDATE=0
SKIP_VERSION_CHECK=0
REPO_DIR=""
REMOTE=""
RESTART_TIME=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: install-on-server.sh [options]

Builds the jellyfin-web checkout the script is run from (or the current directory)
and makes the apt-installed Jellyfin server use it.

Options:
  --branch NAME     Build this branch instead of the one matching the server version
  --no-update       Build the checkout as it is, without switching branch or pulling
  --skip-version-check
                    Build even when the web client version does not match the server version
  --install-dir DIR Where the built web client is installed (default: $INSTALL_DIR)
  --build-dir DIR   Where to clone the repository when not run from a checkout (default: $CLONE_DIR)
  --no-restart      Do not restart the jellyfin service
  --uninstall       Switch back to the stock web client from the jellyfin-web package
  -h, --help        Show this help
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
            --no-update) SKIP_UPDATE=1; shift ;;
            --skip-version-check) SKIP_VERSION_CHECK=1; shift ;;
            --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
            --build-dir) CLONE_DIR="${2:?--build-dir needs a value}"; shift 2 ;;
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

check_user() {
    # Building with sudo would leave root owned files in the checkout
    if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]]; then
        die "Run this script as $SUDO_USER without sudo, it asks for sudo itself when needed."
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

# Prints the release line of a version: "10.11" for 10.x versions, the major version from 12 on
release_line() {
    local version="$1"
    local major="${version%%.*}"
    local rest="${version#*.}"
    if [[ $major -lt 12 ]]; then
        echo "$major.${rest%%[.+~-]*}"
    else
        echo "$major"
    fi
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

# The directory the jellyfin-web package installed the stock web client to
stock_web_dir() {
    local index
    index=$(dpkg-query -L jellyfin-web 2>/dev/null | grep -m 1 '/index\.html$' || true)
    if [[ -n "$index" ]]; then
        dirname "$index"
    else
        echo "$FALLBACK_WEB_DIR"
    fi
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

is_web_checkout() {
    [[ -f "$1/package.json" && -e "$1/.git" ]] && grep -q '"name": *"jellyfin-web"' "$1/package.json"
}

# Uses the checkout containing this script or the current directory, and only clones
# when neither is a jellyfin-web checkout (e.g. when the script is piped from curl)
find_repo() {
    local script_dir=""
    if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
        script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    fi

    if [[ -n "$script_dir" ]] && is_web_checkout "$script_dir"; then
        REPO_DIR="$script_dir"
    elif is_web_checkout "$PWD"; then
        REPO_DIR="$PWD"
    elif [[ -d "$CLONE_DIR/.git" ]]; then
        REPO_DIR="$CLONE_DIR"
    else
        log "No jellyfin-web checkout found here, cloning $REPO_URL into $CLONE_DIR"
        mkdir -p "$(dirname "$CLONE_DIR")"
        git clone "$REPO_URL" "$CLONE_DIR"
        REPO_DIR="$CLONE_DIR"
    fi

    log "Using the checkout in $REPO_DIR"
}

repo_git() {
    git -C "$REPO_DIR" "$@"
}

# Sets REMOTE to the checkout's remote for REPO_URL (https or ssh), adding one if there is none
find_remote() {
    local want name url
    want=$(normalize_repo_url "$REPO_URL")
    for name in $(repo_git remote); do
        url=$(normalize_repo_url "$(repo_git remote get-url "$name")")
        if [[ "$url" == "$want" ]]; then
            REMOTE="$name"
            return
        fi
    done

    REMOTE="pdf-reader"
    log "Adding remote $REMOTE for $REPO_URL"
    repo_git remote add "$REMOTE" "$REPO_URL" \
        || die "Could not add remote $REMOTE for $REPO_URL. If a remote with that name points elsewhere, rename or remove it."
}

# Reduces a git URL to "host/owner/repo" so https and ssh URLs compare equal
normalize_repo_url() {
    local url="${1%.git}"
    url="${url#*://}"
    url="${url#*@}"
    url="${url/://}"
    echo "${url,,}"
}

# Fetches the branch from REMOTE and makes the local branch track it
track_branch() {
    local branch="$1"

    # single-branch clones (e.g. git clone --depth 1) only fetch their default branch
    if ! repo_git config --get-all "remote.$REMOTE.fetch" | grep -qF 'refs/heads/*'; then
        repo_git remote set-branches --add "$REMOTE" "$branch"
    fi
    repo_git fetch "$REMOTE" "$branch" \
        || die "Could not fetch $branch from $(repo_git remote get-url "$REMOTE")."

    if repo_git show-ref --verify --quiet "refs/heads/$branch"; then
        repo_git branch -q --set-upstream-to="$REMOTE/$branch" "$branch"
    else
        repo_git branch -q --track "$branch" "$REMOTE/$branch"
    fi
}

# Switches the checkout to the wanted branch and pulls it, never touching local changes
prepare_repo() {
    local branch="$1"
    local current
    current=$(repo_git rev-parse --abbrev-ref HEAD)

    if [[ $SKIP_UPDATE -eq 1 ]]; then
        log "Building $current as it is (--no-update)"
        return
    fi

    if [[ "$current" != "$branch" ]]; then
        # untracked files count too, git refuses to switch when the branch tracks them
        if [[ -n "$(repo_git status --porcelain)" ]]; then
            die "The checkout is on $current with local changes or untracked files, but this server needs $branch. Commit, stash or remove them, or rerun with --no-update to build $current anyway."
        fi
        find_remote
        track_branch "$branch"
        log "Switching the checkout from $current to $branch"
        repo_git checkout -q "$branch"
    elif [[ -n "$(repo_git status --porcelain --untracked-files=no)" ]]; then
        warn "The checkout has uncommitted changes, building them without pulling."
        return
    else
        find_remote
        # e.g. clones made by the previous version of this script have no upstream
        track_branch "$branch"
    fi

    log "Pulling the latest $branch"
    local output
    if ! output=$(repo_git -c advice.diverging=false pull -q --ff-only 2>&1); then
        warn "Could not update $branch, building the local version: ${output##*$'\n'}"
    fi
}

check_checkout() {
    local version="$1"
    local web_version

    [[ -f "$REPO_DIR/$READER_MARKER" ]] \
        || die "The checked out branch ($(repo_git rev-parse --abbrev-ref HEAD)) does not contain the new PDF reader."

    web_version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -n 1)
    if [[ "$(release_line "$web_version")" != "$(release_line "$version")" ]]; then
        if [[ $SKIP_VERSION_CHECK -eq 0 ]]; then
            die "The checkout is jellyfin-web $web_version but the server is $version, they must match. Run without --no-update, pass the right --branch or pass --skip-version-check."
        fi
        warn "Building jellyfin-web $web_version for jellyfin-server $version, this combination is not supported and some features may not work."
    fi
    log "Building jellyfin-web $web_version for jellyfin-server $version"
}

# Prints the minimum Node.js major version from the engines field of package.json
required_node_major() {
    local engine
    engine=$(sed -n 's/.*"node": *"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$REPO_DIR/package.json" | head -n 1)
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

    if [[ $(node_major) -ge $required ]] && command -v npm >/dev/null; then
        log "Using Node.js $(node --version)"
        return
    fi

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        log "Installing nvm $NVM_VERSION to $NVM_DIR (Node.js $required+ is required, found $(node --version 2>/dev/null || echo none))"
        # cloned instead of using the nvm installer, which tries to edit the shell profile
        git clone -q --depth 1 --branch "$NVM_VERSION" https://github.com/nvm-sh/nvm.git "$NVM_DIR" 2>/dev/null \
            || die "Could not install nvm to $NVM_DIR. Install Node.js $required or newer yourself and run this script again."
    fi

    # nvm.sh returns non-zero statuses in normal operation and uses unset variables,
    # so it must run without errexit and nounset
    local status=0
    set +eu
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" --no-use
    log "Installing Node.js $required with nvm"
    nvm install "$required" || status=$?
    [[ $status -eq 0 ]] && { nvm use "$required" >/dev/null || status=$?; }
    set -eu

    [[ $status -eq 0 ]] || die "nvm could not install Node.js $required (exit status $status)."
    [[ $(node_major) -ge $required ]] || die "Could not set up Node.js $required."
    command -v npm >/dev/null || die "nvm set up Node.js $required without npm."
    log "Using Node.js $(node --version)"
}

build_web() {
    log "Installing dependencies (this can take a few minutes)"
    (cd "$REPO_DIR" && npm ci --no-audit --no-fund)

    log "Building the web client"
    (cd "$REPO_DIR" && npm run build:production)

    [[ -f "$REPO_DIR/dist/index.html" ]] || die "The build did not produce dist/index.html."
}

install_web() {
    log "Installing the web client to $INSTALL_DIR"
    as_root mkdir -p "$INSTALL_DIR"
    as_root rsync -a --delete "$REPO_DIR/dist/" "$INSTALL_DIR/"
    as_root chmod -R a+rX "$INSTALL_DIR"
}

# Undoes the /etc/default/jellyfin change made by earlier versions of this script
restore_defaults_file() {
    local stock="$1"
    local file="$DEFAULTS_FILE"
    local key

    [[ -f "$file" ]] || return 0

    local line value
    for key in JELLYFIN_WEB_DIR JELLYFIN_WEB_OPT; do
        line=$(as_root grep -m 1 "^${key}=" "$file" || true)
        [[ -n "$line" && ( "$line" == *"$INSTALL_DIR"* || "$line" == *"$DEFAULT_INSTALL_DIR"* ) ]] || continue

        log "Restoring $key in $file"
        value="$stock"
        [[ $key == JELLYFIN_WEB_OPT ]] && value="--webdir=$stock"
        # escape characters that are special in a sed replacement
        value=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
        as_root sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$file"
    done
}

# Mounts the custom web client over the stock one for the jellyfin service only
configure_service() {
    local stock="$1"

    log "Mounting $INSTALL_DIR over $stock for the $SERVICE service"
    as_root mkdir -p "$DROPIN_DIR"
    printf '%s\n' \
        '# Added by install-on-server.sh from jellyfin-web, remove this file to use the stock web client' \
        '[Service]' \
        "BindReadOnlyPaths=$INSTALL_DIR:$stock" \
        | as_root tee "$DROPIN_FILE" >/dev/null
    as_root systemctl daemon-reload
}

unconfigure_service() {
    if [[ -f "$DROPIN_FILE" ]]; then
        log "Removing $DROPIN_FILE"
        as_root rm -f "$DROPIN_FILE"
        as_root systemctl daemon-reload
    fi
}

# Reads a value like <InternalHttpPort>8096</InternalHttpPort> from network.xml
network_setting() {
    local name="$1"
    local default="$2"
    local value
    value=$(as_root cat "$JELLYFIN_CONFIG_DIR/network.xml" 2>/dev/null \
        | sed -n "s|.*<$name>\(.*\)</$name>.*|\1|p" | head -n 1 || true)
    echo "${value:-$default}"
}

web_url() {
    local port base
    port=$(network_setting InternalHttpPort 8096)
    base=$(network_setting BaseUrl "")
    base="${base%/}"
    [[ -z "$base" || "$base" == /* ]] || base="/$base"
    echo "http://localhost:$port$base/web/index.html"
}

restart_server() {
    log "Restarting $SERVICE"
    RESTART_TIME=$(date '+%Y-%m-%d %H:%M:%S')
    as_root systemctl restart "$SERVICE"
}

# Waits for the server and prints the index.html it serves
fetch_served_index() {
    local url="$1"
    local _
    for _ in $(seq 1 45); do
        if curl -fsS --connect-timeout 5 --max-time 15 "$url" 2>/dev/null; then
            return 0
        fi
        sleep 2
    done
    return 1
}

print_diagnostics() {
    local web_path
    web_path=$(as_root journalctl -u "$SERVICE" --since "$RESTART_TIME" --no-pager 2>/dev/null \
        | grep -o 'Web resources path: .*' | tail -n 1 || true)

    echo >&2
    echo "Diagnostics:" >&2
    echo "  Server log: ${web_path:-no 'Web resources path' line found since the restart}" >&2
    echo "  Mount:      $(systemctl show "$SERVICE" -p BindReadOnlyPaths --value 2>/dev/null || true)" >&2
    echo "  Drop-ins:   $(systemctl show "$SERVICE" -p DropInPaths --value 2>/dev/null || true)" >&2
    echo "  Service:    $(systemctl is-active "$SERVICE" 2>/dev/null || true)" >&2
    echo "  Logs:       journalctl -u $SERVICE -e" >&2
}

# Checks that the running server serves the given index.html
verify_served() {
    local expected="$1"
    local url served
    url=$(web_url)

    log "Checking what the server serves at $url"
    if ! served=$(fetch_served_index "$url"); then
        systemctl is-active --quiet "$SERVICE" || { print_diagnostics; die "$SERVICE is not running."; }
        warn "$SERVICE is running but did not answer on $url (it may only listen on another address or HTTPS)."
        warn "Could not check which web client it serves, open Jellyfin to check."
        return 0
    fi

    if [[ "$served" == "$(cat "$expected")" ]]; then
        return 0
    fi

    print_diagnostics
    die "The server is not serving the expected web client ($expected)."
}

main() {
    parse_args "$@"
    check_user
    check_server_installed

    local stock
    stock=$(stock_web_dir)

    if [[ $UNINSTALL -eq 1 ]]; then
        restore_defaults_file "$stock"
        unconfigure_service
        [[ $SKIP_RESTART -eq 1 ]] && { log "Done, restart $SERVICE to apply."; return; }
        restart_server
        verify_served "$stock/index.html"
        log "Done. The server uses the stock web client again ($INSTALL_DIR was left in place)."
        return
    fi

    local version
    version=$(server_version)
    log "Found jellyfin-server $version"

    [[ -n "$BRANCH" ]] || BRANCH=$(pick_branch "$version")

    install_packages
    find_repo
    prepare_repo "$BRANCH"
    check_checkout "$version"
    ensure_node
    build_web
    install_web
    restore_defaults_file "$stock"
    configure_service "$stock"

    if [[ $SKIP_RESTART -eq 1 ]]; then
        log "Done, run 'sudo systemctl restart $SERVICE' to apply."
        return
    fi

    restart_server
    verify_served "$INSTALL_DIR/index.html"

    log "Done. The server now serves the web client built from $REPO_DIR."
    log "Reload Jellyfin in your browser with Ctrl+Shift+R (in apps, log out and back in) to load it."
    log "To switch back to the stock web client run: $REPO_DIR/install-on-server.sh --uninstall"
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
    # exit on the same line so bash never reads this file again after a branch switch changed it
    main "$@"; exit $?
fi
