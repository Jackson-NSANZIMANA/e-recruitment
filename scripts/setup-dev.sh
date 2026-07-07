#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# USRP — One-Command Development Environment Setup
# Run from: /home/uruti/Documents/projects/usrp/
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${CYAN}[USRP]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  USRP — Unified Security Recruitment Portal            ${NC}"
echo -e "${BOLD}  Development Environment Bootstrap                     ${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────
log "Checking prerequisites..."

node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ "$node_version" -lt 24 ]] || [[ "$node_version" -gt 25 ]]; then
  error "Node.js 24.x required. Found: $(node --version)"
fi
success "Node.js $(node --version)"

if ! command -v pnpm &> /dev/null; then
  error "pnpm not found. Install: npm install -g pnpm@9.15.0"
fi
success "pnpm $(pnpm --version)"

if ! docker info &>/dev/null; then
  error "Docker daemon not running. Run: sudo systemctl start docker"
fi
success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# ── 2. Environment File ───────────────────────────────────────────
if [[ ! -f ".env" ]]; then
  log "Creating .env from .env.example..."
  cp .env.example .env
  success ".env created — review and update CHANGE_ME values"
else
  warn ".env already exists — skipping"
fi

# ── 3. Install Dependencies ───────────────────────────────────────
log "Installing workspace dependencies..."
pnpm install
success "Dependencies installed"

# ── 4. Start Tier 1 Infrastructure ───────────────────────────────
log "Starting Tier 1 infrastructure (PG, Redis, MinIO, Kong, Mocks)..."
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d --build

log "Waiting for PostgreSQL to be healthy..."
max_attempts=30
attempt=0
until docker exec usrp-postgres pg_isready -U "${POSTGRES_USER:-usrp_admin}" &>/dev/null; do
  attempt=$((attempt + 1))
  if [[ $attempt -ge $max_attempts ]]; then
    error "PostgreSQL failed to start after ${max_attempts} attempts"
  fi
  sleep 2
done
success "PostgreSQL is ready"

log "Waiting for Redis..."
until docker exec usrp-redis redis-cli --auth "${REDIS_PASSWORD:-usrp_redis_dev}" ping &>/dev/null; do
  sleep 1
done
success "Redis is ready"

# ── 5. Build Shared Packages ──────────────────────────────────────
log "Building shared packages..."
pnpm --filter @usrp/shared-types build
success "Shared packages built"

# ── 6. Verify Stack ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Stack Status                                           ${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"

services=(
  "usrp-postgres:PostgreSQL:5432"
  "usrp-redis:Redis:6379"
  "usrp-minio:MinIO:9000"
  "usrp-kong:Kong Gateway:8000"
  "usrp-nida-mock:NIDA Mock:3100"
  "usrp-nesa-mock:NESA Mock:3101"
  "usrp-rib-mock:RIB Mock:3102"
)

for entry in "${services[@]}"; do
  IFS=: read -r container name port <<< "$entry"
  if docker ps --filter "name=${container}" --filter "status=running" | grep -q "${container}"; then
    echo -e "  ${GREEN}●${NC} ${name} (port ${port})"
  else
    echo -e "  ${RED}●${NC} ${name} — NOT RUNNING"
  fi
done

echo ""
echo -e "${BOLD}  Management UIs${NC}"
echo -e "  MinIO Console:  ${CYAN}http://localhost:9001${NC}"
echo -e "  Kong Admin:     ${CYAN}http://localhost:8001${NC}"
echo ""
echo -e "${BOLD}  Tier 2 (Kafka) — start when needed:${NC}"
echo -e "  ${CYAN}pnpm infra:up:tier2${NC}"
echo ""
echo -e "${GREEN}${BOLD}  ✓ USRP development environment ready${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""
