# May I Come? 🏠

An extremely official visitor-permission website. Friends and family get a simple verdict. Residents control it with a **Home Assistant input_select**; nobody on the public site can change the answer.

| Home Assistant selection | Public verdict |
|---|---|
| `Absolutely not` | **ABSOLUTELY NOT.** |
| `Ask first` | **ASK FIRST.** |
| `Visitors welcome` | **COME ON OVER!** |

The default is **ABSOLUTELY NOT.** Startup, an absent or unreadable update token, a missing saved-state file, an unreachable website API, a missing Home Assistant connection, or an expired heartbeat all result in **NO**. Neither a prior approval nor persisted state can override this safety fallback.

## Architecture

```text
Home Assistant helper (input_select.may_i_come)
       │ state change, HA restart, or every-minute heartbeat
       ▼
Home Assistant rest_command (HTTPS + Bearer token)
       │ POST /api/ha-update
       ▼
May I Come? (Node.js, no npm dependencies)
       │ atomic save to /data/status.json (status, lastSeenAt)
       ▼
GET /api/status  ← public read-only browser page
```

**Important:** The website does **not** require a Home Assistant long-lived access token. It only accepts updates authenticated with its *own* secret. The token must be stored server-side and in Home Assistant's `secrets.yaml`, never in public JavaScript.

## 1. Try it locally

Requires Node.js 22+.

```bash
npm run demo
# Open http://localhost:3000
```

Demo mode adds a small control panel under the site so you can preview all three verdicts. **Do not deploy with `DEMO_MODE=true`**; it is only for previews.

## 2. Deploy behind Traefik

The included `compose.yaml` uses `visit.ebi.nu` as an **example hostname** and a Docker network called `traefik`. Change these for your actual Traefik setup.

Generate the token once (save it in a safe place):

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/update-token.txt
chmod 600 secrets/update-token.txt
```

The Compose file bind-mounts the **directory** `./secrets` read-only, publishes **no direct host port**, keeps the saved status in an auto-created named volume, and expects Traefik to serve HTTPS. The directory may be absent at first: Docker Compose creates it, and the app starts healthy with a **NO** verdict until you add a valid `secrets/update-token.txt` file. The token can be added later without restarting Node.js. The production `ygg-other/compose.yaml` instead uses `/volume2/docker/visit/update-token.txt` from its host directory. Keep both locations private and outside the public Git repository.

```bash
docker compose up -d --build
```

Point the DNS record or Cloudflare Tunnel route for `visit.ebi.nu` at the existing Traefik entrypoint. Follow your own Traefik TLS/certresolver conventions. Do not put a Cloudflare Access login in front of the *public* page if friends should visit it without accounts.

If your existing Traefik network has another name, update `networks.traefik` (or specify `name: actual-network-name`). The YAML is an **example**: it is not patched into any existing Compose repository.

## 3. Add Home Assistant helper and publisher

Copy/merge `home-assistant/configuration.yaml` into Home Assistant's `configuration.yaml` and `home-assistant/automation.yaml` into `automations.yaml`. If you already have `input_select:` or `rest_command:` sections, merge their entries under the existing sections.

In Home Assistant's `secrets.yaml`, add a secret with the **entire Authorization header value**, using the **same** token as step 2:

```yaml
may_i_come_authorization_header: "Bearer PUT_THE_64_CHARACTER_HEX_TOKEN_HERE"
```

Make sure the URL in the `rest_command` points to your actual HTTPS hostname. The visitor states are deliberately an exact, fixed set; rename them in both code and YAML if you want different names.

Restart Home Assistant (or reload the relevant YAML integrations and automations) to load the helper and REST command. Use the **May I Come?** dropdown to set a visitor status. You can add the helper to a dashboard as an Entities card, or control it from an HA automation/voice assistant. On startup, every change, and **every minute**, HA posts the current status to the app. The app considers HA reachable only if the last heartbeat arrived **less than 180 seconds ago** (`STATUS_TTL_SECONDS`). After that, the public verdict automatically becomes **ABSOLUTELY NOT**, regardless of the previously saved value. The visitor page refreshes every 30 seconds while visible, and also switches to NO on browser fetch failures. Because this is a push integration, it cannot detect a failure instantly: a disconnected HA may take up to three minutes (plus at most 30 seconds of browser polling) to be reflected. The helper explicitly starts at `Absolutely not` following each HA restart.

If Home Assistant can't reach the website, check the REST command logs. The previously published state may remain visible **only until the heartbeat deadline**; after that, it becomes NO. The page shows when the decision last changed (heartbeats don't reset that timestamp).

### Test the publisher manually

You can test from your workstation with the same secret:

```bash
TOKEN="$(cat secrets/update-token.txt)"
curl -i --fail-with-body -X POST 'https://visit.ebi.nu/api/ha-update' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"status":"Ask first"}'

curl -s 'https://visit.ebi.nu/api/status'
```

Once the test is finished, change the helper in HA so it publishes the actual intended state. Avoid putting the secret in public issue trackers or client-side code. Also note that a shell variable or curl command can be visible in shell history or process listings; prefer keeping the token in HA and the read-only server token file for routine use.

## 4. Security and privacy

- Only the public read-only status endpoint and assets need to be accessible to guests.
- Writes to `/api/ha-update` require a 32+ character Bearer token, checked with a timing-safe comparison. Missing, short, or unreadable tokens disable writes (`503`) without crashing the website.
- The visitor verdict immediately becomes **NO** when the token is missing or unreadable, even if a previously saved **YES** has a still-fresh heartbeat. An updated token is reread on each API request so it can be provisioned at runtime.
- The app requires HTTPS at the reverse proxy. The public endpoint does **not** expose anyone's address, HA hostname, HA API token, or schedule.
- If the app has never received an update, it shows **ABSOLUTELY NOT**, as it also does when the last heartbeat is stale or the status endpoint cannot be reached.
- Each HA update is a heartbeat; by default it expires after 180 seconds. Tune `STATUS_TTL_SECONDS` to adjust the offline detection threshold.
- The HA helper starts at **Absolutely not** on HA restart, rather than restoring a previously permissive selection.
- Changes are stored atomically in `/data/status.json` and survive app restarts. A failed write does not update the visible status.
- There is no browser-based admin login. Configure the selection only in Home Assistant.
- Don't expose Home Assistant publicly solely for this integration. Home Assistant just needs outbound access to the app's HTTPS URL.
- In this deliberately small app, the public website displays a visit policy, which may convey household availability. Don't publish anything there that you wouldn't want anyone on the internet to see.

## Endpoints

| Route | Method | Description |
|---|---|---|
| `/` | GET | Visitor page |
| `/api/status` | GET | `{status, updatedAt, connected, demo}`; `Cache-Control: no-store` |
| `/api/ha-update` | POST | Authenticated Home Assistant update |
| `/healthz` | GET | Container health |

Run tests with `npm test`. There are no runtime npm packages to install.

## What to customize

The exact visitor copy is in `public/app.js`; colors and layout are in `public/style.css`. The page never makes a real booking or sends a message, so it does not pretend that someone has approved a visit just because the **Check Again** button was clicked.

Made with love, boundaries, and no surprise visits.