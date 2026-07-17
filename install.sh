#!/usr/bin/env bash
# Yana CLI installer
# Downloads the latest yana binary from GitHub Releases
# and installs it to ~/.yana/bin/
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JetBrains/junie-live-fake/main/install.sh | bash
#
# For private repositories, set GITHUB_TOKEN first:
#   export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
#   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" https://raw.githubusercontent.com/JetBrains/junie-live-fake/main/install.sh | bash

set -euo pipefail

REPO="JetBrains/junie-live-fake"
BINARY_NAME="yana"
INSTALL_DIR="$HOME/.yana/bin"

# --- Helpers ---

info()  { printf '\033[1;34m%s\033[0m\n' "$*" >&2; }
error() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) error "Unsupported operating system: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64" ;;
    arm64|aarch64)  echo "arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac
}

# Build auth header for curl/wget when GITHUB_TOKEN is set
auth_header() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "Authorization: token ${GITHUB_TOKEN}"
  fi
}

# Fetch JSON from a GitHub API URL
api_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    local h; h=$(auth_header)
    curl -fsSL ${h:+-H "$h"} "$url"
  elif command -v wget >/dev/null 2>&1; then
    local h; h=$(auth_header)
    wget -qO- ${h:+--header="$h"} "$url"
  else
    error "Neither curl nor wget found. Please install one of them."
  fi
}

# Resolve the latest release tag WITHOUT the GitHub API.
# The /releases/latest web URL 302-redirects to /releases/tag/<tag>; following
# that redirect and reading the final URL avoids api.github.com entirely, so it
# is not subject to the 60-req/hour unauthenticated rate limit (HTTP 403).
latest_tag_via_redirect() {
  local url="https://github.com/${REPO}/releases/latest"
  local effective="" tag=""
  if command -v curl >/dev/null 2>&1; then
    local h; h=$(auth_header)
    effective=$(curl -fsSLI -o /dev/null -w '%{url_effective}' ${h:+-H "$h"} "$url" 2>/dev/null) || return 1
  elif command -v wget >/dev/null 2>&1; then
    local h; h=$(auth_header)
    effective=$(wget -S --max-redirect=10 -O /dev/null ${h:+--header="$h"} "$url" 2>&1 \
      | grep -i '^[[:space:]]*Location:' | tail -1 | sed 's/.*Location:[[:space:]]*//' | tr -d '\r') || return 1
  else
    return 1
  fi
  # Final URL looks like https://github.com/<repo>/releases/tag/<tag>
  case "$effective" in
    */releases/tag/*) tag="${effective##*/releases/tag/}"; tag="${tag%%/*}" ;;
    *) return 1 ;;
  esac
  [ -n "$tag" ] || return 1
  echo "$tag"
}

# Fetch the tag name of the latest GitHub release
latest_tag() {
  info "Fetching latest release for ${REPO}..."
  local tag
  # Prefer the API-free redirect (no rate limit). Fall back to the API
  # (needed for private repos, where the web redirect requires a session).
  tag=$(latest_tag_via_redirect) || tag=""
  if [ -z "$tag" ]; then
    local url="https://api.github.com/repos/${REPO}/releases/latest"
    local json
    json=$(api_get "$url") || error "Could not fetch latest release. Check https://github.com/${REPO}/releases"
    tag=$(echo "$json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  fi
  [ -n "$tag" ] || error "Could not determine latest release tag. Check https://github.com/${REPO}/releases"
  info "Latest release: ${tag}"
  echo "$tag"
}

# Find the API download URL for a release asset by name
# For private repos, assets must be downloaded via the API with Accept: application/octet-stream
asset_download_url() {
  local tag="$1" asset_name="$2"
  # Public repos: download directly from the release download URL — no
  # api.github.com call, so this is not subject to the unauthenticated
  # rate limit (HTTP 403). Only consult the API for private repos, where
  # the asset must be fetched via its API url with Accept: octet-stream.
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "https://github.com/${REPO}/releases/download/${tag}/${asset_name}"
    return 0
  fi
  local url="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
  info "Fetching release assets for ${tag}..."
  local json asset_url
  json=$(api_get "$url") || error "Could not fetch release info for ${tag}"
  # Extract the asset's api url (browser_download_url won't work for private repos)
  asset_url=$(echo "$json" | grep -B5 "\"name\": \"${asset_name}\"" | grep '"url"' | tail -1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  if [ -n "$asset_url" ]; then
    echo "$asset_url"
  else
    # Fallback to browser download URL (works for public repos)
    echo "https://github.com/${REPO}/releases/download/${tag}/${asset_name}"
  fi
}

download() {
  local url="$1" dest="$2"
  info "  GET ${url}"
  # Download to a temporary sibling file and atomically move it into place.
  # Overwriting an existing code-signed Mach-O *in place* (same inode) breaks
  # macOS: the kernel still has the previous binary's code-signature pages
  # cached for that vnode, so the new bytes fail validation
  # ("load code signature error 2" / "rejecting invalid page") and the process
  # is SIGKILL'd ("zsh: killed yana") even though the binary is perfectly valid.
  # A fresh temp file + rename gives a new inode, so no stale signature is cached.
  local tmp="${dest}.download.$$"
  if command -v curl >/dev/null 2>&1; then
    local h; h=$(auth_header)
    # API asset URLs require Accept header to get the binary instead of JSON metadata
    if echo "$url" | grep -q 'api.github.com.*assets'; then
      curl -fsSL ${h:+-H "$h"} -H "Accept: application/octet-stream" -o "$tmp" "$url"
    else
      curl -fsSL ${h:+-H "$h"} -o "$tmp" "$url"
    fi
  elif command -v wget >/dev/null 2>&1; then
    local h; h=$(auth_header)
    if echo "$url" | grep -q 'api.github.com.*assets'; then
      wget -qO "$tmp" ${h:+--header="$h"} --header="Accept: application/octet-stream" "$url"
    else
      wget -qO "$tmp" ${h:+--header="$h"} "$url"
    fi
  fi
  chmod +x "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$dest"
  info "  Saved to ${dest} ($(wc -c < "$dest" | tr -d ' ') bytes)"
}

# --- Main ---

main() {
  local os arch tag asset_name download_url

  os=$(detect_os)
  arch=$(detect_arch)
  info "Detected platform: ${os}/${arch}"

  tag=$(latest_tag)

  info "Installing yana ${tag} (${os}/${arch})..."

  asset_name="${BINARY_NAME}-${os}-${arch}"
  if [ "$os" = "windows" ]; then
    asset_name="${asset_name}.exe"
  fi

  download_url=$(asset_download_url "$tag" "$asset_name")

  mkdir -p "$INSTALL_DIR"

  local dest="${INSTALL_DIR}/${BINARY_NAME}"
  if [ "$os" = "windows" ]; then
    dest="${dest}.exe"
  fi

  info "Downloading ${download_url}..."
  download "$download_url" "$dest" || error "Download failed. Check that a release exists at https://github.com/${REPO}/releases"

  chmod +x "$dest"

  info "Installed to ${dest}"

  # Add to PATH if not already there
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    local shell_name
    shell_name=$(basename "${SHELL:-/bin/bash}")
    local profile=""
    case "$shell_name" in
      zsh)  profile="$HOME/.zshrc" ;;
      bash)
        if [ -f "$HOME/.bash_profile" ]; then
          profile="$HOME/.bash_profile"
        else
          profile="$HOME/.bashrc"
        fi
        ;;
      fish) profile="$HOME/.config/fish/config.fish" ;;
    esac

    local export_line="export PATH=\"${INSTALL_DIR}:\$PATH\""
    if [ "$shell_name" = "fish" ]; then
      export_line="set -gx PATH ${INSTALL_DIR} \$PATH"
    fi

    if [ -n "$profile" ]; then
      if ! grep -qF "$INSTALL_DIR" "$profile" 2>/dev/null; then
        printf '\n# Yana CLI\n%s\n' "$export_line" >> "$profile"
        info "Added ${INSTALL_DIR} to PATH in ${profile}"
        info "Run 'source ${profile}' or open a new terminal to use yana."
      fi
    else
      info "Add the following to your shell profile:"
      info "  ${export_line}"
    fi
  fi

  info ""
  info "Done! Run 'yana --help' to get started."
}

main "$@"
