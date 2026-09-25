#!/usr/bin/env bash
#
# Diagnostico del panel: dice que funciona, que falta y como arreglarlo.
#
#   sudo ./deploy/comprobar.sh
set -uo pipefail

DESTINO="${DESTINO:-/opt/panel}"
[ -f "$DESTINO/.env" ] || DESTINO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$DESTINO/.env"

ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
mal()   { printf '  \033[31m✗\033[0m %s\n' "$*"; FALLOS=$((FALLOS + 1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
FALLOS=0

# Lee una variable del .env sin mostrar su valor.
valor() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }
definida() { [ -n "$(valor "$1")" ]; }

PUERTO="$(valor PORT)"; PUERTO="${PUERTO:-3000}"
APP_URL="$(valor APP_URL)"
SERVIDOR="${APP_URL#https://}"; SERVIDOR="${SERVIDOR#http://}"; SERVIDOR="${SERVIDOR%%/*}"
DOMINIO="${SERVIDOR%%:*}"   # sin el puerto, para consultar el DNS

titulo "Configuracion"
if [ -f "$ENV_FILE" ]; then ok "Fichero de configuracion: $ENV_FILE"; else mal "No encuentro $ENV_FILE"; fi
[ -n "$DOMINIO" ] && ok "Direccion del panel: $APP_URL" || mal "Falta APP_URL en el .env"
definida SESSION_SECRET && ok "SESSION_SECRET definido" || mal "Falta SESSION_SECRET (generalo con: openssl rand -hex 32)"

titulo "Servicios"
if command -v systemctl >/dev/null && systemctl is-system-running >/dev/null 2>&1; then
  systemctl is-active --quiet panel 2>/dev/null && ok "Servicio del panel activo" || mal "El panel esta parado (sudo systemctl start panel; journalctl -u panel -n 40)"
  systemctl is-active --quiet caddy 2>/dev/null && ok "Caddy activo" || mal "Caddy esta parado (sudo systemctl start caddy; journalctl -u caddy -n 40)"
  if systemctl is-active --quiet duckdns.timer 2>/dev/null; then
    ok "Actualizacion de IP de DuckDNS programada"
  else
    aviso "Sin temporizador de DuckDNS (solo hace falta si tu IP cambia)"
  fi
fi

if curl -sf --max-time 5 "http://127.0.0.1:$PUERTO/api/salud" >/dev/null; then
  ok "El panel responde en el puerto $PUERTO"
else
  mal "El panel no responde en 127.0.0.1:$PUERTO"
fi

titulo "Dominio y certificado"
if [ -n "$DOMINIO" ]; then
  IP_DOMINIO="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk '{print $1; exit}')"
  IP_PUBLICA="$(curl -sf --max-time 8 https://api.ipify.org 2>/dev/null || curl -sf --max-time 8 https://ifconfig.me 2>/dev/null || true)"

  if [ -z "$IP_DOMINIO" ]; then
    mal "$DOMINIO no resuelve. Crea el subdominio en duckdns.org y actualiza la IP: sudo systemctl start duckdns"
  elif [ -n "$IP_PUBLICA" ] && [ "$IP_DOMINIO" = "$IP_PUBLICA" ]; then
    ok "$DOMINIO apunta a este servidor ($IP_DOMINIO)"
  elif [ -n "$IP_PUBLICA" ]; then
    mal "$DOMINIO apunta a $IP_DOMINIO, pero la IP publica de este servidor es $IP_PUBLICA"
    echo "      Actualizala con: sudo systemctl start duckdns"
  else
    aviso "$DOMINIO resuelve a $IP_DOMINIO (no he podido averiguar la IP publica para compararla)"
  fi

  CODIGO="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$SERVIDOR/api/salud" 2>/dev/null)"
  if [ "$CODIGO" = "200" ]; then
    ok "HTTPS funcionando: https://$SERVIDOR responde con certificado valido"
  else
    mal "https://$SERVIDOR no responde correctamente (codigo: ${CODIGO:-sin respuesta})"
    echo "      · Comprueba que los puertos 80 y 443 del router llegan a este servidor."
    echo "      · Si estas en casa, esta prueba puede fallar aunque funcione bien desde fuera"
    echo "        (algunos routers no dejan salir y volver). Pruebalo desde el movil sin wifi."
    echo "      · Registro del certificado: sudo journalctl -u caddy -n 40"
  fi
fi

titulo "Puertos de entrada"
ESCUCHA=""
if command -v ss >/dev/null 2>&1; then ESCUCHA="$(ss -tln 2>/dev/null)"
elif command -v netstat >/dev/null 2>&1; then ESCUCHA="$(netstat -tln 2>/dev/null)"
fi
if [ -n "$ESCUCHA" ]; then
  for PUERTO_WEB in 80 443; do
    if echo "$ESCUCHA" | grep -qE "(^|[^0-9.]):$PUERTO_WEB[[:space:]]"; then
      ok "Caddy escucha en el puerto $PUERTO_WEB de esta maquina"
    else
      mal "Nadie escucha en el puerto $PUERTO_WEB (sudo systemctl status caddy)"
    fi
  done
else
  aviso "No puedo listar los puertos abiertos (instala iproute2 para verlo)"
fi

# El certificado solo se emite si Let's Encrypt logra entrar por el puerto 80
# desde fuera, asi que su presencia es la mejor prueba de que el puerto llega.
if [ -n "$DOMINIO" ] && [ -d /var/lib/caddy/.local/share/caddy/certificates ]; then
  if find /var/lib/caddy/.local/share/caddy/certificates -name "$DOMINIO.crt" 2>/dev/null | grep -q .; then
    ok "Certificado emitido para $DOMINIO (el puerto 80 llega desde internet)"
  else
    mal "Todavia no hay certificado para $DOMINIO"
    echo "      Let's Encrypt no ha podido entrar por el puerto 80 desde internet."
    echo "      Si esta maquina esta detras de un router, redirige los puertos 80 y 443"
    echo "      hacia su IP local: $(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "      Motivo exacto: sudo journalctl -u caddy -n 30 --no-pager | grep -i error"
  fi
fi

titulo "Cortafuegos"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then
  REGLAS="$(ufw status 2>/dev/null)"
  for PUERTO_WEB in 80 443; do
    if echo "$REGLAS" | grep -qE "(^|[[:space:]])$PUERTO_WEB(/tcp)?([[:space:]]|$)"; then
      ok "Puerto $PUERTO_WEB abierto en ufw"
    else
      mal "Puerto $PUERTO_WEB cerrado en ufw (abrelo con: sudo ufw allow $PUERTO_WEB/tcp)"
    fi
  done
else
  aviso "ufw no esta activo. Si tu proveedor de VPS tiene cortafuegos propio, abre ahi los puertos 80 y 443"
fi

titulo "Integraciones"
if definida STRIPE_SECRET_KEY; then ok "Clave de Stripe configurada"; else mal "Falta STRIPE_SECRET_KEY en el .env"; fi
if definida STRIPE_WEBHOOK_SECRET; then
  ok "Secreto del webhook de Stripe configurado"
  if [ -n "$DOMINIO" ]; then
    CODIGO="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
      -H 'content-type: application/json' -d '{}' "https://$SERVIDOR/webhooks/stripe" 2>/dev/null)"
    # 400 = ha llegado y ha rechazado la firma falsa, que es lo correcto.
    if [ "$CODIGO" = "400" ]; then
      ok "El webhook recibe peticiones y rechaza las firmas invalidas"
    else
      aviso "El webhook devolvio $CODIGO ante una peticion sin firma (se esperaba 400)"
    fi
  fi
else
  mal "Falta STRIPE_WEBHOOK_SECRET: sin el, Stripe no puede entregar los cobros"
  [ -n "$DOMINIO" ] && echo "      Crea el endpoint en Stripe apuntando a https://$SERVIDOR/webhooks/stripe"
fi

if definida TELEGRAM_BOT_TOKEN; then ok "Bot de Telegram configurado"; else aviso "Sin bot de Telegram: no habra avisos"; fi
if definida TELEGRAM_ADMIN_CHAT_ID; then ok "Chat de administrador configurado"; else aviso "Falta TELEGRAM_ADMIN_CHAT_ID"; fi

MODO="$(valor KRAKEN_MODE)"
if [ "$MODO" = "live" ]; then
  if definida KRAKEN_API_KEY && definida KRAKEN_API_SECRET; then
    ok "Kraken en modo real con credenciales"
  else
    mal "KRAKEN_MODE=live pero faltan las credenciales de Kraken"
  fi
else
  aviso "Kraken en modo simulacion: los pagos se registran pero no mueven dinero real"
fi

titulo "Resumen"
if [ "$FALLOS" -eq 0 ]; then
  printf '  \033[32mTodo correcto.\033[0m Entra en %s\n\n' "${APP_URL:-el panel}"
else
  printf '  \033[31m%s cosa(s) por resolver\033[0m (arriba tienes el detalle)\n\n' "$FALLOS"
fi
exit 0
