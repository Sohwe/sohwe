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
#   SOHWE_HTTP_PORT      host port published for Traefik HTTP (default: 8080)
#   SOHWE_SETUP_PASSWORD installer password for first dashboard access (min 8 chars)
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
readonly DEFAULT_HTTP_PORT="${DEFAULT_HTTP_PORT:-8080}"

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
You can skip the domain and use http://<this-host>:${SOHWE_HTTP_PORT} only, or add
a DNS name later. Set HTTPS later with:  sohwe enable-https <host> <email>

EOF
    prompt_if_interactive SOHWE_HOST_INPUT       "Public domain for the dashboard (blank = HTTP only): "
    if [[ -n "${SOHWE_HOST_INPUT}" ]]; then
        prompt_if_interactive SOHWE_ACME_EMAIL_INPUT "Contact email for Let's Encrypt: "
        [[ -n "${SOHWE_ACME_EMAIL_INPUT}" ]] \
            || fail "An email is required when a domain is configured (Let's Encrypt needs it)."
    fi
}

#-----------------------------------------------------------------------------#
# Host port + installer password
#-----------------------------------------------------------------------------#

# Exit 0 if something is listening on TCP host port $1.
host_port_in_use() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] || return 2
    (( port >= 1 && port <= 65535 )) || return 2

    if command -v ss >/dev/null 2>&1; then
        if ss -tln 2>/dev/null | awk -v p="$port" 'BEGIN { found = 0 } NR > 1 && $4 ~ ":"p"$" { found = 1 } END { exit !found }'; then
            return 0
        fi
    fi

    if command -v lsof >/dev/null 2>&1; then
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            return 0
        fi
    fi

    if timeout 0.25 bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null; then
        return 0
    fi

    return 1
}

quote_env_append() {
    local key="$1" val="$2"
    local escaped="${val//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    printf '%s="%s"\n' "$key" "$escaped" >> "${ENV_FILE}"
}

collect_http_port() {
    SOHWE_HTTP_PORT="${SOHWE_HTTP_PORT:-}"

    if [[ "${NONINTERACTIVE}" == "1" ]]; then
        [[ -n "${SOHWE_HTTP_PORT}" ]] \
            || fail "SOHWE_HTTP_PORT is required when SOHWE_NONINTERACTIVE=1."
    else
        while true; do
            local answer=""
            if [[ ! -t 0 ]] && [[ -r /dev/tty ]]; then
                printf '%s' "HTTP port for the dashboard [${DEFAULT_HTTP_PORT}]: " > /dev/tty
                read -r answer < /dev/tty
            else
                printf '%s' "HTTP port for the dashboard [${DEFAULT_HTTP_PORT}]: "
                read -r answer
            fi
            [[ -z "${answer}" ]] && answer="${DEFAULT_HTTP_PORT}"
            if ! [[ "${answer}" =~ ^[0-9]+$ ]] || (( answer < 1 || answer > 65535 )); then
                warn "Enter an integer between 1 and 65535."
                continue
            fi
            if host_port_in_use "${answer}"; then
                warn "Port ${answer} is already in use on this host. Choose another."
                continue
            fi
            SOHWE_HTTP_PORT="${answer}"
            break
        done
    fi

    if ! [[ "${SOHWE_HTTP_PORT}" =~ ^[0-9]+$ ]] || (( SOHWE_HTTP_PORT < 1 || SOHWE_HTTP_PORT > 65535 )); then
        fail "Invalid SOHWE_HTTP_PORT: ${SOHWE_HTTP_PORT}"
    fi
    if host_port_in_use "${SOHWE_HTTP_PORT}"; then
        fail "Port ${SOHWE_HTTP_PORT} is already in use on this host."
    fi

    ok "Dashboard HTTP traffic will use host port ${SOHWE_HTTP_PORT}."
}

collect_setup_password() {
    SOHWE_SETUP_PASSWORD="${SOHWE_SETUP_PASSWORD:-}"

    if [[ -n "${SOHWE_SETUP_PASSWORD}" ]]; then
        ((${#SOHWE_SETUP_PASSWORD} >= 8)) \
            || fail "SOHWE_SETUP_PASSWORD must be at least 8 characters."
        [[ "${SOHWE_SETUP_PASSWORD}" != *$'\n'* ]] \
            || fail "SOHWE_SETUP_PASSWORD cannot contain newlines."
        return
    fi

    if [[ "${NONINTERACTIVE}" == "1" ]]; then
        fail "SOHWE_SETUP_PASSWORD is required when SOHWE_NONINTERACTIVE=1."
    fi

    local pw1 pw2
    while true; do
        if [[ ! -t 0 ]] && [[ -r /dev/tty ]]; then
            printf '%s' "Choose an installer password for first dashboard access (min 8 chars): " > /dev/tty
            read -rs pw1 < /dev/tty
            printf '\n' > /dev/tty
            printf '%s' "Confirm installer password: " > /dev/tty
            read -rs pw2 < /dev/tty
            printf '\n' > /dev/tty
        else
            printf '%s' "Choose an installer password for first dashboard access (min 8 chars): "
            read -rs pw1
            printf '\n'
            printf '%s' "Confirm installer password: "
            read -rs pw2
            printf '\n'
        fi
        if ((${#pw1} < 8)); then
            warn "Password must be at least 8 characters."
            continue
        fi
        if [[ "${pw1}" != "${pw2}" ]]; then
            warn "Passwords did not match."
            continue
        fi
        SOHWE_SETUP_PASSWORD="${pw1}"
        break
    done
}

warn_standard_ports() {
    if host_port_in_use 443; then
        warn "Port 443 is already in use — Traefik may fail to bind until it is free."
    fi
    if [[ -n "${SOHWE_HOST_INPUT}" ]] && host_port_in_use 80; then
        warn "Port 80 is already in use — Let's Encrypt for ${SOHWE_HOST_INPUT} may fail until HTTP is reachable on port 80."
    fi
    if [[ -n "${SOHWE_HOST_INPUT}" && "${SOHWE_HTTP_PORT}" == "80" ]]; then
        warn "SOHWE_HTTP_PORT=80 plus HTTPS can duplicate Docker's host port 80 mapping; prefer 8080 for http://IP access (compose adds :80 for Let's Encrypt)."
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
        warn "To change domain, email, port (SOHWE_HTTP_PORT), installer password (SOHWE_SETUP_PASSWORD), or version: edit ${ENV_FILE} then run \`sohwe restart\`."
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
SOHWE_HTTP_PORT=${SOHWE_HTTP_PORT}
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
    quote_env_append SOHWE_SETUP_PASSWORD "${SOHWE_SETUP_PASSWORD}"
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
    local ip_hint http_url http_port
    http_port="${SOHWE_HTTP_PORT:-}"
    if [[ -z "${http_port}" ]] && [[ -f "${ENV_FILE}" ]]; then
        http_port="$(grep -E '^SOHWE_HTTP_PORT=' "${ENV_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)"
    fi
    http_port="${http_port:-8080}"
    ip_hint="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -z "${ip_hint}" ]] && ip_hint="<server-ip>"
    http_url="http://${ip_hint}:${http_port}"

    cat <<EOF

${C_GREEN}${C_BOLD}Sohwe is up.${C_RESET}

EOF
    if [[ -n "${SOHWE_HOST_INPUT}" ]]; then
        cat <<EOF
  Dashboard (HTTPS):  ${C_BOLD}https://${SOHWE_HOST_INPUT}${C_RESET}
  Dashboard (HTTP):   ${C_BOLD}${http_url}${C_RESET}
EOF
    else
        cat <<EOF
  Dashboard:  ${C_BOLD}${http_url}${C_RESET}
EOF
    fi

    cat <<EOF
  Data dir:   ${DATA_DIR}
  CLI:        sohwe --help

Unlock first-run setup with your installer password, then create the owner account.

EOF
}

#-----------------------------------------------------------------------------#
# Main
#-----------------------------------------------------------------------------#

main() {
    log "Sohwe installer (${SOHWE_VERSION}, channel=${CHANNEL})"
    detect_os
    ensure_docker
    collect_http_port
    collect_inputs
    warn_standard_ports
    collect_setup_password
    fetch_assets
    write_env_file
    boot_stack
    print_banner
}

main "$@"
