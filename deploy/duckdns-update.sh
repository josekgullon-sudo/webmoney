#!/bin/sh
# Mantiene actualizada la IP del subdominio de DuckDNS.
# Configuracion en /etc/duckdns.conf (permisos 600):
#   DUCKDNS_DOMAIN=misubdominio      <- sin ".duckdns.org"
#   DUCKDNS_TOKEN=xxxxxxxx-xxxx-...  <- el token de tu cuenta
set -eu

CONF="${DUCKDNS_CONF:-/etc/duckdns.conf}"
[ -r "$CONF" ] || { echo "No se puede leer $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"

: "${DUCKDNS_DOMAIN:?falta DUCKDNS_DOMAIN en $CONF}"
: "${DUCKDNS_TOKEN:?falta DUCKDNS_TOKEN en $CONF}"

# Con ip vacio, DuckDNS toma la IP publica desde la que se hace la peticion.
RESPUESTA=$(curl -fsS --max-time 20 \
  "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")

if [ "$RESPUESTA" = "OK" ]; then
  echo "duckdns: ${DUCKDNS_DOMAIN}.duckdns.org actualizado"
else
  echo "duckdns: fallo al actualizar (respuesta: ${RESPUESTA:-vacia}). Revisa dominio y token." >&2
  exit 1
fi
