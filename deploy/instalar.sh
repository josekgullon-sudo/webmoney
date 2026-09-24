#!/usr/bin/env bash
#
# Instalador del panel de cobros en un servidor Debian/Ubuntu con systemd.
# Deja funcionando: el panel, HTTPS automatico con Caddy y la actualizacion
# de la IP en DuckDNS.
#
#   sudo ./deploy/instalar.sh
#
# Se puede volver a ejecutar sin miedo: no pisa el .env ni la base de datos
# que ya existan.
#
# Para instalarlo sin preguntas, define antes estas variables:
#   DUCKDNS_DOMAIN  DUCKDNS_TOKEN  CORREO_TLS
#   STRIPE_SECRET_KEY  STRIPE_WEBHOOK_SECRET
#   TELEGRAM_BOT_TOKEN  TELEGRAM_ADMIN_CHAT_ID
set -euo pipefail

DESTINO="${DESTINO:-/opt/panel}"
USUARIO_SISTEMA="${USUARIO_SISTEMA:-panel}"
PUERTO="${PUERTO:-3000}"
ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
abortar() { rojo "✗ $*"; exit 1; }

# ─── Comprobaciones previas ───────────────────────────────────────────────────
paso "Comprobando el servidor"

[ "$(id -u)" -eq 0 ] || abortar "Ejecutalo con sudo: sudo ./deploy/instalar.sh"
command -v apt-get >/dev/null || abortar "Este instalador es para Debian o Ubuntu. En otro sistema, sigue los pasos del README a mano."
command -v systemctl >/dev/null || abortar "No hay systemd en esta maquina. Sigue los pasos del README a mano."
[ -f "$ORIGEN/package.json" ] || abortar "No encuentro el proyecto en $ORIGEN"

echo "  Sistema:  $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  Destino:  $DESTINO"

# ─── Datos de configuracion ───────────────────────────────────────────────────
paso "Datos de configuracion"

# Quita espacios y tabuladores de los extremos: al pegar una clave es facil
# que se cuele uno, y eso bastaba para dejar la configuracion invalida.
limpiar() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

preguntar() {            # preguntar VARIABLE "Texto" ["valor por defecto"]
  local nombre="$1" texto="$2" defecto="${3:-}" valor
  valor="$(limpiar "${!1:-}")"
  if [ -n "$valor" ]; then echo "  $texto: (ya definido)"; printf -v "$nombre" '%s' "$valor"; return; fi
  if [ -n "$defecto" ]; then read -r -p "  $texto [$defecto]: " valor || true
  else read -r -p "  $texto: " valor || true; fi
  valor="$(limpiar "${valor:-}")"
  printf -v "$nombre" '%s' "${valor:-$defecto}"
}

preguntar_secreto() {    # igual, pero sin mostrar lo que se teclea
  local nombre="$1" texto="$2" valor
  valor="$(limpiar "${!1:-}")"
  if [ -n "$valor" ]; then echo "  $texto: (ya definido)"; printf -v "$nombre" '%s' "$valor"; return; fi
  read -r -s -p "  $texto: " valor || true; echo
  printf -v "$nombre" '%s' "$(limpiar "${valor:-}")"
}

echo "Deja en blanco lo que todavia no tengas: se puede anadir despues al fichero .env"
echo
preguntar DUCKDNS_DOMAIN "Subdominio de DuckDNS (sin .duckdns.org)"
[ -n "${DUCKDNS_DOMAIN:-}" ] || abortar "El subdominio de DuckDNS es imprescindible."
DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN%%.duckdns.org}"
DOMINIO="${DUCKDNS_DOMAIN}.duckdns.org"

preguntar_secreto DUCKDNS_TOKEN "Token de DuckDNS"
preguntar CORREO_TLS "Correo para los avisos del certificado" "admin@${DOMINIO}"
preguntar_secreto STRIPE_SECRET_KEY "Clave secreta de Stripe (sk_...)"
preguntar_secreto STRIPE_WEBHOOK_SECRET "Secreto del webhook de Stripe (whsec_...)"
preguntar_secreto TELEGRAM_BOT_TOKEN "Token del bot de Telegram"
preguntar TELEGRAM_ADMIN_CHAT_ID "Tu chat ID de Telegram"

# ─── Dependencias del sistema ─────────────────────────────────────────────────
paso "Instalando dependencias"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

version_node() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(version_node)" -lt 20 ]; then
  echo "  Instalando Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  Node.js $(node -v)"

if ! command -v caddy >/dev/null; then
  echo "  Instalando Caddy..."
  if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
fi
echo "  Caddy $(caddy version | head -1)"

# ─── Copia del proyecto ───────────────────────────────────────────────────────
paso "Instalando el panel en $DESTINO"

id -u "$USUARIO_SISTEMA" >/dev/null 2>&1 || \
  useradd --system --home "$DESTINO" --shell /usr/sbin/nologin "$USUARIO_SISTEMA"

mkdir -p "$DESTINO"
if [ "$ORIGEN" != "$DESTINO" ]; then
  tar -C "$ORIGEN" --exclude=.git --exclude=node_modules --exclude=data -cf - . | tar -C "$DESTINO" -xf -
fi
mkdir -p "$DESTINO/data"
chown -R "$USUARIO_SISTEMA:$USUARIO_SISTEMA" "$DESTINO"

echo "  Instalando dependencias de Node..."
sudo -u "$USUARIO_SISTEMA" env HOME="$DESTINO" npm ci --omit=dev --no-audit --no-fund --prefix "$DESTINO" >/dev/null

# ─── Fichero .env ─────────────────────────────────────────────────────────────
paso "Configuracion del panel (.env)"

# Anade una clave al .env si viene con valor y alli esta vacia. Asi, al volver
# a ejecutar el instalador, se pueden completar las claves que quedaron en blanco
# (tipicamente el whsec_... de Stripe, que solo existe tras crear el webhook).
fijar_env() {
  local clave="$1" valor="$2" actual
  [ -n "$valor" ] || return 0
  actual="$(sed -n "s/^$clave=//p" "$DESTINO/.env" | head -1)"
  [ -z "$actual" ] || return 0
  if grep -q "^$clave=" "$DESTINO/.env"; then
    sed -i "s|^$clave=.*|$clave=$valor|" "$DESTINO/.env"
  else
    printf '%s=%s\n' "$clave" "$valor" >> "$DESTINO/.env"
  fi
  verde "  Anadido $clave"
}

if [ -f "$DESTINO/.env" ]; then
  echo "  Ya existe $DESTINO/.env: se conserva."
  fijar_env STRIPE_SECRET_KEY "${STRIPE_SECRET_KEY:-}"
  fijar_env STRIPE_WEBHOOK_SECRET "${STRIPE_WEBHOOK_SECRET:-}"
  fijar_env TELEGRAM_BOT_TOKEN "${TELEGRAM_BOT_TOKEN:-}"
  fijar_env TELEGRAM_ADMIN_CHAT_ID "${TELEGRAM_ADMIN_CHAT_ID:-}"
  echo "  (si cambias algo a mano, reinicia con: systemctl restart panel)"
else
  umask 077
  cat > "$DESTINO/.env" <<EOF
NODE_ENV=production
PORT=$PUERTO
HOST=127.0.0.1
APP_URL=https://$DOMINIO
TRUST_PROXY=true
SESSION_SECRET=$(openssl rand -hex 32)
DB_PATH=$DESTINO/data/panel.db
PLATFORM_CURRENCY=EUR
DEFAULT_FEE_PCT=0

STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-}

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ADMIN_CHAT_ID=${TELEGRAM_ADMIN_CHAT_ID:-}

KRAKEN_API_KEY=
KRAKEN_API_SECRET=
# Empieza en simulacion: los pagos se registran pero no mueven dinero real.
KRAKEN_MODE=simulate
KRAKEN_TRADE_BEFORE_WITHDRAW=true

PAYOUT_AUTO=true
PAYOUT_CRON=30 23 * * *
PAYOUT_TIMEZONE=Europe/Madrid
PAYOUT_MIN_AMOUNT=25

LOG_LEVEL=info
EOF
  chown "$USUARIO_SISTEMA:$USUARIO_SISTEMA" "$DESTINO/.env"
  chmod 600 "$DESTINO/.env"
  verde "  Creado $DESTINO/.env"
fi

# ─── DuckDNS ──────────────────────────────────────────────────────────────────
paso "DuckDNS ($DOMINIO)"

if [ -n "${DUCKDNS_TOKEN:-}" ]; then
  umask 077
  printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" > /etc/duckdns.conf
  chmod 600 /etc/duckdns.conf

  sed "s|/opt/panel|$DESTINO|g" "$DESTINO/deploy/duckdns.service" > /etc/systemd/system/duckdns.service
  cp "$DESTINO/deploy/duckdns.timer" /etc/systemd/system/duckdns.timer
  systemctl daemon-reload
  systemctl enable --now duckdns.timer >/dev/null

  if systemctl start duckdns.service; then
    verde "  IP actualizada en DuckDNS"
  else
    rojo "  No se pudo actualizar la IP. Revisa el subdominio y el token: journalctl -u duckdns"
  fi
else
  IP_PUBLICA="$(curl -sf --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  IP_DOMINIO="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk '{print $1; exit}' || true)"
  echo "  Sin token: me salto la actualizacion automatica de IP."
  if [ -n "$IP_PUBLICA" ] && [ -n "$IP_DOMINIO" ] && [ "$IP_PUBLICA" != "$IP_DOMINIO" ]; then
    rojo "  ATENCION: $DOMINIO apunta a $IP_DOMINIO y este servidor es $IP_PUBLICA."
    rojo "  Mientras no coincidan, no se podra emitir el certificado HTTPS."
    echo "  Arreglalo de una de estas dos formas:"
    echo "    a) en duckdns.org, escribe $IP_PUBLICA en 'current ip' y pulsa 'update ip'"
    echo "    b) vuelve a ejecutar este instalador y pega el token cuando te lo pida"
  elif [ -n "$IP_PUBLICA" ] && [ "$IP_PUBLICA" = "$IP_DOMINIO" ]; then
    verde "  $DOMINIO ya apunta a este servidor ($IP_PUBLICA)"
  fi
fi

# ─── Servicio del panel ───────────────────────────────────────────────────────
paso "Arrancando el panel"

sed "s|/opt/panel|$DESTINO|g; s|^User=panel|User=$USUARIO_SISTEMA|; s|^Group=panel|Group=$USUARIO_SISTEMA|" \
  "$DESTINO/deploy/panel.service" > /etc/systemd/system/panel.service
systemctl daemon-reload
systemctl enable panel >/dev/null
systemctl restart panel

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PUERTO/api/salud" >/dev/null && break
  sleep 1
done
if curl -sf "http://127.0.0.1:$PUERTO/api/salud" >/dev/null; then
  verde "  El panel responde en el puerto $PUERTO"
else
  rojo "  El panel no arranca. Mira el motivo con: journalctl -u panel -n 40"
  exit 1
fi

# ─── Caddy (HTTPS) ────────────────────────────────────────────────────────────
paso "Configurando HTTPS con Caddy"

mkdir -p /var/log/caddy /etc/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true

NUEVO_CADDY="$(mktemp)"
sed "s|TU-SUBDOMINIO.duckdns.org|$DOMINIO|; s|127.0.0.1:3000|127.0.0.1:$PUERTO|" \
  "$DESTINO/deploy/Caddyfile" > "$NUEVO_CADDY"

if [ -n "${CORREO_TLS:-}" ]; then
  sed -i "s|tu-correo@ejemplo.com|$CORREO_TLS|" "$NUEVO_CADDY"
else
  # Sin correo se quita la linea entera: "tls" a secas no es valido, y el
  # certificado se emite igual (solo se pierden los avisos de caducidad).
  sed -i "/tu-correo@ejemplo.com/d" "$NUEVO_CADDY"
fi

if caddy validate --config "$NUEVO_CADDY" --adapter caddyfile >/dev/null 2>&1; then
  install -m 644 "$NUEVO_CADDY" /etc/caddy/Caddyfile
  rm -f "$NUEVO_CADDY"
  systemctl enable caddy >/dev/null 2>&1 || true
  if systemctl restart caddy; then
    verde "  Caddy configurado para $DOMINIO"
  else
    rojo "  Caddy no arranca. Ultimas lineas del registro:"
    journalctl -u caddy -n 20 --no-pager >&2 || true
  fi
else
  rojo "  La configuracion de Caddy no es valida. Esto es lo que dice Caddy:"
  caddy validate --config "$NUEVO_CADDY" --adapter caddyfile 2>&1 \
    | grep -v '"level":"info"' | tail -5 >&2
  echo "  (la configuracion anterior se ha dejado intacta: $NUEVO_CADDY)" >&2
  abortar "No se ha podido configurar el HTTPS."
fi

# ─── Administrador ────────────────────────────────────────────────────────────
paso "Usuario administrador"

hay_admin() {
  ( cd "$DESTINO" && sudo -u "$USUARIO_SISTEMA" env DB_PATH="$DESTINO/data/panel.db" node --input-type=module -e \
      "const db = (await import('./src/lib/db.js')).default;
       process.exit(db.prepare(\"SELECT COUNT(*) AS n FROM users WHERE role = 'admin'\").get().n > 0 ? 0 : 1);" ) 2>/dev/null
}

if hay_admin; then
  echo "  Ya existe un administrador. Para cambiarle la contrasena:"
  echo "    cd $DESTINO && sudo -u $USUARIO_SISTEMA node scripts/create-admin.js --user admin"
else
  ( cd "$DESTINO" && sudo -u "$USUARIO_SISTEMA" env DB_PATH="$DESTINO/data/panel.db" node scripts/create-admin.js --user admin )
fi

# ─── Comprobacion final ───────────────────────────────────────────────────────
paso "Comprobacion final"
bash "$DESTINO/deploy/comprobar.sh" || true

cat <<EOF

────────────────────────────────────────────────────────────────
  Panel instalado:  https://$DOMINIO
────────────────────────────────────────────────────────────────

Siguiente paso en Stripe (Desarrolladores → Webhooks → Anadir endpoint):

  URL      https://$DOMINIO/webhooks/stripe
  Eventos  payment_intent.succeeded, checkout.session.completed,
           charge.refunded, charge.dispute.created

Copia el "whsec_..." que te de Stripe, ponlo en $DESTINO/.env
y reinicia con:  sudo systemctl restart panel

Ordenes utiles:
  sudo systemctl status panel        estado del panel
  sudo journalctl -u panel -f        registro en vivo
  sudo $DESTINO/deploy/comprobar.sh  diagnostico completo
EOF
