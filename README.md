# Panel de cobros — Stripe · Telegram · Kraken

Panel web que recoge automáticamente los cobros de **Stripe**, los muestra en tiempo real,
avisa por un **bot de Telegram** y envía cada día a cada usuario lo que ha generado
a **su cartera de criptomonedas** a través de **Kraken**.

Cada usuario entra con un usuario y contraseña que le das tú, ve sus cobros y configura
la dirección donde quiere recibir el dinero.

```
Cliente paga ──▶ Stripe ──webhook──▶ Panel ──▶ aviso de Telegram
                                       │
                                       └── cada día ──▶ Kraken (compra + retirada) ──▶ cartera del usuario
```

## Qué hace exactamente

- **Cobros automáticos.** Stripe envía cada pago al webhook del panel. El cobro aparece en
  pantalla al instante (sin recargar) y queda guardado con su importe, comisión y neto.
- **Avisos por Telegram.** Cada cobro, cada pago enviado y cada cartera pendiente de aprobar
  genera un mensaje al administrador y, si lo tiene configurado, al usuario implicado.
- **Usuarios con acceso propio.** Tú creas cada usuario desde el panel; se genera una
  contraseña provisional que le pasas y que él debe cambiar al entrar por primera vez.
- **Cartera de cada usuario.** El usuario indica su criptomoneda, su red y su dirección.
  Tú la revisas y la apruebas antes de que reciba nada.
- **Pago diario automático.** A la hora que configures, el panel suma lo generado por cada
  usuario, compra la criptomoneda en Kraken y la envía a su dirección.
- **Comisión por usuario.** Puedes quedarte un porcentaje de cada cobro (0 % por defecto).

## Dos cosas importantes antes de empezar

1. **El dinero de Stripe no llega solo a Kraken.** Stripe ingresa en tu cuenta bancaria con
   unos días de retraso. El panel lleva la contabilidad de lo que le corresponde a cada
   usuario y ejecuta el envío **con el saldo que tú mantengas en tu cuenta de Kraken**. En la
   práctica: mantén en Kraken saldo suficiente para cubrir los pagos diarios y repóntelo con
   las transferencias que te vaya haciendo Stripe.
2. **Kraken solo retira a direcciones de su lista blanca.** Su API no permite enviar a una
   dirección cualquiera. Por eso, cuando un usuario registra su cartera, tú debes darla de
   alta en Kraken (*Funding → Withdraw → Add address*, con 2FA) y escribir en el panel el
   nombre exacto que le hayas puesto. Ese nombre es lo que el panel usa para retirar.

Empieza siempre con `KRAKEN_MODE=simulate`: el panel recorre todo el proceso y lo registra,
pero no mueve dinero real. Cuando lo veas funcionar, cámbialo a `live`.

## Probarlo sin conectar nada

La forma más rápida de verlo funcionando: no hace falta cuenta de Stripe, ni bot de Telegram,
ni claves de Kraken.

```bash
npm install
npm run demo -- --yes     # rellena el panel con datos de ejemplo
npm start                 # http://localhost:3000
```

Entra con **admin / demo-panel-2026** (o con **juan / demo-panel-2026** para ver la pantalla
tal y como la ve un usuario normal). Tendrás 35 cobros repartidos en 14 días, tres usuarios,
carteras en distintos estados y dos pagos ya enviados en modo simulación.

Dentro puedes probar el circuito completo:

- **Cobros → Cobro de prueba** crea un cobro y lo verás aparecer en el resumen **sin recargar
  la página** (es lo mismo que ocurre cuando entra un pago real de Stripe).
- **Carteras** aprueba la cartera pendiente de Lucía.
- **Enviar pagos → Pagar ahora** ejecuta un envío completo en modo simulación: calcula la
  cantidad de criptomoneda al precio de mercado y registra la retirada, sin mover dinero.
- Si pones el token del bot en `TELEGRAM_BOT_TOKEN` y tu chat ID en `TELEGRAM_ADMIN_CHAT_ID`,
  esos mismos avisos te llegarán al móvil.

`npm run demo` se niega a tocar una base de datos que ya tenga cobros reales.

### Probar los webhooks de Stripe de verdad, en local

Con la [CLI de Stripe](https://stripe.com/docs/stripe-cli) no necesitas ni dominio ni
despliegue: reenvía los eventos de tu cuenta de pruebas a tu ordenador.

```bash
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
# copia el whsec_... que imprime a STRIPE_WEBHOOK_SECRET y reinicia el panel

stripe trigger payment_intent.succeeded
```

El cobro aparecerá en el panel igual que lo hará en producción.

## Puesta en marcha en tu ordenador

Necesitas Node.js 20 o superior.

```bash
npm install
cp .env.example .env          # rellena lo que tengas; con lo básico ya arranca
npm run create-admin -- --user admin
npm start                     # http://localhost:3000
```

El comando `create-admin` imprime una contraseña generada al azar: guárdala, no se vuelve a mostrar.

Para probar el circuito completo sin cobrar de verdad: entra en **Cobros → Cobro de prueba**.
Verás aparecer el cobro en el panel y llegar el aviso a Telegram.

## Despliegue con DuckDNS y HTTPS

[DuckDNS](https://www.duckdns.org/) te da gratis un subdominio del tipo `misubdominio.duckdns.org`
apuntando a tu IP. Con eso más [Caddy](https://caddyserver.com/) tienes HTTPS automático, que es
justo lo que Stripe exige para enviar los webhooks.

**1. Crea el subdominio.** Entra en duckdns.org, inicia sesión, crea tu subdominio y copia el *token*.

**2. Abre los puertos.** En tu router, redirige los puertos **80** y **443** a la IP local del
servidor. Si usas un VPS, abre esos puertos en su cortafuegos. Los dos son necesarios: el 80
para que Let's Encrypt valide el dominio y el 443 para el tráfico del panel.

**3. Instala el panel** en el servidor:

```bash
sudo useradd --system --home /opt/panel --shell /usr/sbin/nologin panel
sudo git clone <url-de-este-repositorio> /opt/panel
cd /opt/panel
sudo -u panel npm ci --omit=dev
sudo -u panel cp .env.example .env
sudo -u panel nano .env        # ver la tabla de variables más abajo
sudo chown -R panel:panel /opt/panel
```

En el `.env`, como mínimo:

```ini
NODE_ENV=production
HOST=127.0.0.1
APP_URL=https://misubdominio.duckdns.org
TRUST_PROXY=true
SESSION_SECRET=<pega aquí el resultado de: openssl rand -hex 32>
```

**4. Mantén la IP actualizada** (necesario si tu conexión no tiene IP fija):

```bash
sudo tee /etc/duckdns.conf >/dev/null <<'EOF'
DUCKDNS_DOMAIN=misubdominio
DUCKDNS_TOKEN=tu-token-de-duckdns
EOF
sudo chmod 600 /etc/duckdns.conf

sudo cp deploy/duckdns.service deploy/duckdns.timer /etc/systemd/system/
sudo systemctl enable --now duckdns.timer
sudo systemctl start duckdns.service       # primera actualización
journalctl -u duckdns.service -n 5         # debe decir "actualizado"
```

**5. Arranca el panel como servicio:**

```bash
sudo cp deploy/panel.service /etc/systemd/system/
sudo systemctl enable --now panel
sudo systemctl status panel
```

**6. Pon Caddy delante** (obtiene y renueva el certificado él solo):

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # cambia TU-SUBDOMINIO y el correo
sudo systemctl reload caddy
```

Entra en `https://misubdominio.duckdns.org`: ya tienes el panel con certificado válido.

**7. Crea el administrador:**

```bash
cd /opt/panel && sudo -u panel node scripts/create-admin.js --user admin
```

> Si tu operador bloquea el puerto 80 (algo habitual en fibra doméstica con CG-NAT), Caddy no
> podrá validar el dominio por HTTP. En ese caso la alternativa es un VPS barato, o compilar
> Caddy con el módulo DNS de DuckDNS para validar por DNS.

## Conectar Stripe

1. En el panel de Stripe → **Desarrolladores → Claves de API**, copia la clave secreta
   (`sk_live_…`) y ponla en `STRIPE_SECRET_KEY`.
2. En **Desarrolladores → Webhooks → Añadir endpoint**:
   - URL: `https://misubdominio.duckdns.org/webhooks/stripe`
   - Eventos: `payment_intent.succeeded`, `checkout.session.completed`,
     `charge.refunded` y `charge.dispute.created`.
3. Copia el secreto de firma (`whsec_…`) a `STRIPE_WEBHOOK_SECRET` y reinicia el panel.

**Para que cada cobro se asigne solo al usuario correcto**, añade en Stripe un dato de
`metadata` al crear el pago (o al Payment Link / Checkout Session):

| clave | valor |
|---|---|
| `panel_user` | el nombre de usuario del panel, p. ej. `juan` |

También vale `panel_user_id` con el número de usuario. Si no hay metadata y solo tienes un
usuario dado de alta, el cobro se le asigna a él. Si no, queda **sin asignar** y lo asignas a
mano desde **Cobros** (el panel te avisa en la pantalla de Estado).

El webhook está protegido contra los dos problemas típicos: verifica la firma de Stripe y
descarta los eventos repetidos, así que un reintento de Stripe nunca duplica un ingreso.

## Conectar Telegram

1. Habla con [@BotFather](https://t.me/BotFather), envía `/newbot` y copia el token
   a `TELEGRAM_BOT_TOKEN`.
2. Escríbele algo a tu bot (si no, no puede contestarte) y averigua tu chat ID con
   [@userinfobot](https://t.me/userinfobot). Ponlo en `TELEGRAM_ADMIN_CHAT_ID`.
3. Comprueba que funciona en **Estado → Probar Telegram**.

Cada usuario puede poner su propio chat ID en **Mi perfil** para recibir sus avisos.

## Conectar Kraken

1. En Kraken → **Settings → API → Create API key**, con permisos de *Query Funds*,
   *Create & Modify Orders* y *Withdraw Funds*. Cópialos a `KRAKEN_API_KEY` y `KRAKEN_API_SECRET`.
2. Da de alta la dirección de cada usuario en **Funding → Withdraw → Add address** y anota el
   nombre que le pongas.
3. En el panel, **Carteras** → aprueba la cartera del usuario escribiendo ese mismo nombre.
4. Cuando todo esté probado, cambia `KRAKEN_MODE=simulate` por `KRAKEN_MODE=live`.

Criptomonedas admitidas: BTC, ETH, USDT, USDC, SOL y LTC.

## Uso diario

| Acción | Dónde |
|---|---|
| Crear un usuario y obtener su contraseña | **Usuarios → Crear usuario** |
| Cambiar la comisión de un usuario | **Usuarios**, columna Comisión |
| Aprobar la cartera de un usuario | **Carteras** |
| Ver y asignar cobros | **Cobros** |
| Enviar pagos a mano | **Enviar pagos** |
| Ver si Stripe, Telegram y Kraken responden | **Estado** |

Los pagos automáticos salen según `PAYOUT_CRON` (por defecto, todos los días a las 23:30 hora
de Madrid) para los usuarios con cartera aprobada y saldo por encima de `PAYOUT_MIN_AMOUNT`.
Si un envío falla, el saldo **no se pierde**: vuelve a quedar pendiente y se reintenta en la
siguiente tanda, y te llega un aviso por Telegram.

## Variables de configuración

Todas están comentadas en `.env.example`. Las que más importan:

| Variable | Para qué sirve |
|---|---|
| `APP_URL` | URL pública del panel; se usa en los enlaces de Telegram |
| `SESSION_SECRET` | Obligatoria en producción (`openssl rand -hex 32`) |
| `TRUST_PROXY` | `true` si el panel va detrás de Caddy o nginx |
| `DEFAULT_FEE_PCT` | Comisión por defecto de la plataforma |
| `KRAKEN_MODE` | `simulate` (sin dinero real) o `live` |
| `KRAKEN_TRADE_BEFORE_WITHDRAW` | `false` si ya tienes la cripto comprada en Kraken |
| `PAYOUT_CRON` / `PAYOUT_TIMEZONE` | Cuándo se lanzan los pagos diarios |
| `PAYOUT_MIN_AMOUNT` | Importe mínimo para enviar un pago |

## Comandos

```bash
npm start                                          # arrancar el panel
npm test                                           # pruebas automáticas
npm run create-admin -- --user admin               # crear o reestablecer el administrador
npm run create-user  -- --user juan --fee 10       # crear un usuario desde consola
npm run demo -- --yes                              # rellenar el panel con datos de ejemplo
npm run payout:run                                 # lanzar la tanda de pagos a mano
```

## Seguridad

- Contraseñas guardadas con bcrypt; contraseña provisional de un solo uso y cambio obligatorio.
- Sesiones en cookie `httpOnly` + `secure` en producción, guardadas en la base de datos.
- Protección CSRF en todos los formularios y límite de intentos de acceso.
- Cabeceras de seguridad y política de contenido restrictiva (helmet).
- Registro de actividad: accesos, cambios de cartera, aprobaciones y pagos.
- Toda cartera nueva o modificada vuelve a quedar pendiente de aprobación.

Recomendaciones: haz copia de seguridad de `data/panel.db` (contiene toda la contabilidad),
no compartas el `.env` y limita los permisos de la clave de Kraken a lo imprescindible.

Ten en cuenta además que cobrar por Stripe y repartir en criptomonedas a terceros tiene
implicaciones fiscales y de prevención de blanqueo según el país. Consúltalo con un asesor
antes de operar con dinero real.

## Estructura del proyecto

```
src/
  server.js            arranque, middlewares y tarea programada
  config.js            configuración leída del entorno
  lib/                 base de datos, dinero, sesiones, CSRF, eventos, criptomonedas
  services/            stripe (cobros), kraken, telegram, pagos diarios
  routes/              webhook, acceso, panel del usuario, administración, API
  views/               plantillas de las pantallas
public/                estilos y JavaScript del navegador
scripts/               utilidades de consola
deploy/                DuckDNS, systemd y Caddy
tests/                 pruebas automáticas
```

## Base de datos

SQLite (`data/panel.db`), sin servidor aparte. Los importes se guardan en céntimos como
números enteros para que no haya errores de redondeo. Tablas: `users`, `wallets`, `payments`,
`payouts`, `webhook_events`, `notifications`, `audit_log` y `sessions`.
