#!/usr/bin/env bash
# shellcheck shell=bash
#
# Sohwe installer. Target: a fresh Ubuntu 22.04 or 24.04 VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/Sohwe/sohwe/main/scripts/install.sh | bash
#
# Optional environment variables (or pass as `KEY=value bash install.sh`):
#
#   SOHWE_VERSION        image tag to install (default: latest)
#   SOHWE_HOST           public hostname for the dashboard (e.g. sohwe.example.com)
#   SOHWE_ACME_EMAIL     contact email for Let's Encrypt (required with SOHWE_HOST)
#   SOHWE_CHANNEL        branch to fetch compose files from (default: main)
#   SOHWE_NONINTERACTIVE 1 = never prompt; fail if required input is missing
#
# The script is idempotent. Re-running it upgrades compose files and the
# `sohwe` wrapper without touching secrets in /etc/sohwe/sohwe.env.

set -euo pipefail

#-----------------------------------------------------------------------------#
# Cosmetics
#-----------------------------------------------------------------------------#

readonly C_RESET='\033[0m'
readonly C_BOLD='\033[1m'
readonly C_GREEN='\033[32m'
readonly C_YELLOW='\033[33m'
readonly C_RED='\033[31m'
readonly C_BLUE='\033[34m'

log()   { printf '%b==>%b %s\n'   "${C_BLUE}"   "${C_RESET}" "$*"; }
ok()    { printf '%b ok%b %s\n'   "${C_GREEN}"  "${C_RESET}" "$*"; }
warn()  { printf '%bwarn%b %s\n'  "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
fail()  { printf '%berr%b %s\n'   "${C_RED}"    "${C_RESET}" "$*" >&2; exit 1; }

#-----------------------------------------------------------------------------#
# Configuration
#-----------------------------------------------------------------------------#

# Source-repo path (mixed case, used for raw.githubusercontent URLs).
readonly REPO="Sohwe/sohwe"
# Image namespace — GHCR lowercases the owner segment.
readonly IMAGE_NS="sohwe/sohwe"
readonly CHANNEL="${SOHWE_CHANNEL:-main}"
readonly RAW_BASE="https://raw.githubusercontent.com/${REPO}/${CHANNEL}"
readonly DATA_DIR="/etc/sohwe"
readonly ENV_FILE="${DATA_DIR}/sohwe.env"
readonly COMPOSE_BASE="${DATA_DIR}/docker-compose.prod.yml"
readonly COMPOSE_HTTPS="${DATA_DIR}/docker-compose.https.yml"
readonly WRAPPER="/usr/local/bin/sohwe"

SOHWE_VERSION="${SOHWE_VERSION:-latest}"
SOHWE_HOST_INPUT="${SOHWE_HOST:-}"
SOHWE_ACME_EMAIL_INPUT="${SOHWE_ACME_EMAIL:-}"
NONINTERACTIVE="${SOHWE_NONINTERACTIVE:-0}"

#-----------------------------------------------------------------------------#
# Privileges
#-----------------------------------------------------------------------------#
#
# Re-exec as root if we aren't already. This is subtle because of `curl | bash`:
# when piped into bash, `$0` is the interpreter ("bash" or "/usr/bin/bash"),
# not a readable path to this script. Re-running `sudo bash "$0"` in that case
# hands bash its own binary as a script and blows up with:
#
#   /usr/bin/bash: /usr/bin/bash: cannot execute binary file
#
# So if `$0` doesn't point at a readable file, we fetch ourselves to a temp
# file first and sudo-exec that. Uses the same URL as everything else so a
# mismatched installer/compose version is impossible.

if [[ $EUID -ne 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
        fail "Run as root (or install sudo)."
    fi

    if [[ -f "$0" && -r "$0" ]]; then
        # Invoked as a real file (e.g. bash ./install.sh). Normal re-exec.
        exec sudo -E bash "$0" "$@"
    fi

    # Piped case: materialize ourselves to disk, then re-exec. Preserves env
    # so SOHWE_VERSION, SOHWE_HOST, etc. carry through the sudo boundary.
    tmp_self="$(mktemp -t sohwe-install.XXXXXX.sh)"
    if ! curl -fsSL "${RAW_BASE}/scripts/install.sh" -o "${tmp_self}"; then
        rm -f "${tmp_self}"
        fail "Failed to re-download installer from ${RAW_BASE}/scripts/install.sh"
    fi
    chmod +x "${tmp_self}"
    # shellcheck disable=SC2093  # exec replaces this shell; nothing after runs.
    exec sudo -E bash "${tmp_self}" "$@"
fi

#-----------------------------------------------------------------------------#
# OS detection — Ubuntu 22.04 / 24.04 only for v0.2
#-----------------------------------------------------------------------------#

detect_os() {
    [[ -r /etc/os-release ]] || fail "/etc/os-release not found; cannot detect distro."
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}:${VERSION_ID:-}" in
        ubuntu:22.04|ubuntu:24.04) : ;;
        debian:12) warn "Debian 12 is untested but close enough — continuing." ;;
        *)
            fail "Unsupported OS: ${ID:-unknown} ${VERSION_ID:-unknown}. Sohwe supports Ubuntu 22.04 and 24.04."
            ;;
    esac
    ok "OS ${PRETTY_NAME:-$ID}"
}

#-----------------------------------------------------------------------------#
# Docker install (idempotent)
#-----------------------------------------------------------------------------#

ensure_docker() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        ok "Docker + compose plugin already installed ($(docker --version | awk '{print $3}' | tr -d ,))."
        return
    fi

    log "Installing Docker Engine + compose plugin from Docker's apt repo…"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg lsb-release

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    local codename
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    systemctl enable --now docker
    ok "Docker installed."
}

#-----------------------------------------------------------------------------#
# Collect host/email
#-----------------------------------------------------------------------------#

prompt_if_interactive() {
    local var_name="$1" message="$2" default="${3:-}" answer
    local current_value="${!var_name-}"

    if [[ -n "${current_value}" ]]; then
        return 0
    fi
    if [[ "${NONINTERACTIVE}" == "1" ]]; then
        return 0
    fi
    if [[ ! -t 0 ]]; then
        # Being run via `curl | bash` so /dev/stdin is the script body.
        # Read from the controlling TTY directly if we have one.
        if [[ -r /dev/tty ]]; then
            printf '%s' "${message}" > /dev/tty
            read -r answer < /dev/tty
        else
            return 0
        fi
    else
        printf '%s' "${message}"
        read -r answer
    fi
    printf -v "${var_name}" '%s' "${answer:-${default}}"
}

collect_inputs() {
    cat <<EOF

${C_BOLD}Sohwe setup${C_RESET}
You can skip the domain for now and reach the dashboard via the server's IP
address (HTTP only). Set a domain later with:  sohwe enable-https <host> <email>

EOF
    prompt_if_interactive SOHWE_HOST_INPUT       "Public domain for the dashboard (blank = HTTP only): "
    if [[ -n "${SOHWE_HOST_INPUT}" ]]; then
        prompt_if_interactive SOHWE_ACME_EMAIL_INPUT "Contact email for Let's Encrypt: "
        [[ -n "${SOHWE_ACME_EMAIL_INPUT}" ]] \
            || fail "An email is required when a domain is configured (Let's Encrypt needs it)."
    fi
}

#-----------------------------------------------------------------------------#
# Environment file
#-----------------------------------------------------------------------------#

random_hex() {
    # 32 bytes of entropy -> 64 hex chars. Works without openssl on some minis
    # by falling back to /dev/urandom + xxd.
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    elif command -v xxd >/dev/null 2>&1; then
        head -c 32 /dev/urandom | xxd -p -c 64
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

random_password() {
    # Base64 URL-safe, 32 bytes. No trailing = or special chars the compose
    # variable interpolation might balk at.
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 32 | tr -d '=+/\n' | cut -c1-32
    else
        head -c 32 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-32
    fi
}

write_env_file() {
    mkdir -p "${DATA_DIR}"
    chmod 750 "${DATA_DIR}"

    local overlays="" https_enabled="false"
    if [[ -n "${SOHWE_HOST_INPUT}" ]]; then
        overlays="${COMPOSE_HTTPS}"
        https_enabled="true"
    fi

    if [[ -f "${ENV_FILE}" ]]; then
        ok "Existing ${ENV_FILE} kept as-is (secrets and settings preserved)."
        warn "To change domain, email, or version: edit ${ENV_FILE} then run \`sohwe restart\`."
        return
    fi

    local session_secret encryption_key pg_password
    session_secret="$(random_hex)"
    encryption_key="$(random_hex)"
    pg_password="$(random_password)"

    cat > "${ENV_FILE}" <<ENV
# Sohwe runtime environment. Generated by install.sh — keep secret.
# Safe to edit by hand; \`sohwe update\` preserves this file.

SOHWE_VERSION=${SOHWE_VERSION}
SOHWE_IMAGE_API=ghcr.io/${IMAGE_NS}-api:${SOHWE_VERSION}
SOHWE_IMAGE_WORKER=ghcr.io/${IMAGE_NS}-worker:${SOHWE_VERSION}
SOHWE_IMAGE_DASHBOARD=ghcr.io/${IMAGE_NS}-dashboard:${SOHWE_VERSION}

# Public-facing
SOHWE_HOST=${SOHWE_HOST_INPUT}
SOHWE_ACME_EMAIL=${SOHWE_ACME_EMAIL_INPUT}
SOHWE_HTTPS_ENABLED=${https_enabled}
SOHWE_COMPOSE_OVERLAYS=${overlays}
TRAEFIK_LOG_LEVEL=INFO

# Postgres (inside the compose network only)
POSTGRES_DB=sohwe
POSTGRES_USER=sohwe
POSTGRES_PASSWORD=${pg_password}
DATABASE_URL=postgresql://sohwe:${pg_password}@postgres:5432/sohwe?schema=public

# Redis
REDIS_URL=redis://redis:6379

# Secrets — regenerating these invalidates logins and encrypted env vars.
SESSION_SECRET=${session_secret}
SOHWE_ENCRYPTION_KEY=${encryption_key}
ENV
    chmod 600 "${ENV_FILE}"
    ok "Generated ${ENV_FILE} (0600)."
}

#-----------------------------------------------------------------------------#
# Fetch compose files + wrapper
#-----------------------------------------------------------------------------#

fetch() {
    local src="$1" dest="$2"
    local tmp
    tmp="$(mktemp)"
    if ! curl -fsSL "${src}" -o "${tmp}"; then
        rm -f "${tmp}"
        fail "Failed to download ${src}"
    fi
    mv "${tmp}" "${dest}"
}

fetch_assets() {
    # Ensure the data dir exists before anything tries to drop a file here.
    # write_env_file also mkdirs this (idempotent), but fetch_assets runs first
    # and would otherwise explode with "No such file or directory" on the mv.
    mkdir -p "${DATA_DIR}"
    chmod 750 "${DATA_DIR}"

    log "Fetching compose files from ${RAW_BASE}…"
    fetch "${RAW_BASE}/docker-compose.prod.yml"  "${COMPOSE_BASE}"
    fetch "${RAW_BASE}/docker-compose.https.yml" "${COMPOSE_HTTPS}"
    chmod 644 "${COMPOSE_BASE}" "${COMPOSE_HTTPS}"
    ok "Compose files installed in ${DATA_DIR}."

    log "Installing \`sohwe\` CLI wrapper to ${WRAPPER}…"
    fetch "${RAW_BASE}/scripts/sohwe" "${WRAPPER}"
    chmod 755 "${WRAPPER}"
    ok "${WRAPPER} installed."
}

#-----------------------------------------------------------------------------#
# Boot
#-----------------------------------------------------------------------------#

boot_stack() {
    log "Pulling images (this is most of the wait time)…"
    "${WRAPPER}" pull

    log "Starting Sohwe…"
    "${WRAPPER}" up

    log "Applying database schema…"
    # Retry a few times while Postgres finishes warming up on slower hosts.
    # 5 * 3s = 15s is plenty; the postgres healthcheck already gates `up`.
    for i in 1 2 3 4 5; do
        if "${WRAPPER}" migrate; then break; fi
        [[ $i -eq 5 ]] && fail "Database migration failed after 5 attempts."
        sleep 3
    done
}

#-----------------------------------------------------------------------------#
# Done banner
#-----------------------------------------------------------------------------#

print_banner() {
    local public_url
    if [[ -n "${SOHWE_HOST_INPUT}" ]]; then
        public_url="https://${SOHWE_HOST_INPUT}"
    else
        public_url="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
        [[ "${public_url}" == "http://" ]] && public_url="http://<server-ip>"
    fi

    cat <<EOF

${C_GREEN}${C_BOLD}Sohwe is up.${C_RESET}

  Dashboard:  ${C_BOLD}${public_url}${C_RESET}
  Data dir:   ${DATA_DIR}
  CLI:        sohwe --help

First-run setup (create the owner account) is in the dashboard.

EOF
}

#-----------------------------------------------------------------------------#
# Main
#-----------------------------------------------------------------------------#

main() {
    log "Sohwe installer (${SOHWE_VERSION}, channel=${CHANNEL})"
    detect_os
    ensure_docker
    collect_inputs
    fetch_assets
    write_env_file
    boot_stack
    print_banner
}

main "$@"
