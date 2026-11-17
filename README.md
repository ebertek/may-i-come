# May I Come? 🏠

An extremely official visitor-permission website. Friends and family get a simple verdict. Residents control it with a **Home Assistant input_select**; nobody on the public site can change the answer. Home Assistant's existing `input_boolean.guest_mode` forces **NO** while the guest Wi-Fi is occupied.

| Guest mode | Home Assistant selection | Public verdict |
|---|---|---|
| Off | `Absolutely not` | **ABSOLUTELY NOT.** |
| Off | `Ask first` | **ASK FIRST.** |
| Off | `Visitors welcome` | **COME ON OVER!** |
| On, unknown, or unavailable | Any | **ABSOLUTELY NOT.** |

The default is **ABSOLUTELY NOT.** Startup, an absent or unreadable update token, an unreachable website API, a missing Home Assistant connection, or an expired heartbeat all result in **NO**. Visitor state lives only in memory; container restarts always reset the verdict to **NO**.

## Architecture

```text
Home Assistant helper (input_select.may_i_come)
    + existing guest Wi-Fi helper (input_boolean.guest_mode)
       │ either helper changes, HA restart, or every-minute heartbeat
       │ guest_mode != off → publish "Absolutely not"
       ▼
Home Assistant rest_command (HTTPS + Bearer token)
       │ POST /api/ha-update
       ▼
May I Come? (Node.js, no npm dependencies)
       │ in-memory status + last heartbeat (nothing written to disk)
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

The Compose file bind-mounts the **directory** `./secrets` read-only, publishes **no direct host port**, stores visitor status only in memory (no `/data` volume), and expects Traefik to serve HTTPS. The directory may be absent at first: Docker Compose creates it, and the app starts healthy with a **NO** verdict until you add a valid `secrets/update-token.txt` file. The token can be added later without restarting Node.js. The production `ygg-other/compose.yaml` instead uses `/volume2/docker/visit/update-token.txt` from its host directory. Keep both locations private and outside the public Git repository.

```bash
docker compose up -d --build
```

Point the DNS record or Cloudflare Tunnel route for `visit.ebi.nu` at the existing Traefik entrypoint. Follow your own Traefik TLS/certresolver conventions. Do not put a Cloudflare Access login in front of the *public* page if friends should visit it without accounts.

If your existing Traefik network has another name, update `networks.traefik` (or specify `name: actual-network-name`). The YAML is an **example**: it is not patched into any existing Compose repository.

## 3. Add Home Assistant helper and publisher

Copy/merge `home-assistant/configuration.yaml` into Home Assistant's `configuration.yaml` and `home-assistant/automation.yaml` into `automations.yaml`. If you already have `input_select:` or `rest_command:` sections, merge their entries under the existing sections. Do not define the same helper twice if you already created `input_select.may_i_come` in the UI. For the existing `input_boolean.guest_mode`, no additional helper configuration is required.

For the Pleiades deployment, Home Assistant stores its configuration under `/volume2/docker/hass/config`. Provision the optional update token in the host directory mounted into `visit` (the Node.js user needs read access):

```bash
sudo install -d -o root -g 1000 -m 0750 /volume2/docker/visit
sudo sh -c 'umask 027; test -e /volume2/docker/visit/update-token.txt || openssl rand -hex 32 > /volume2/docker/visit/update-token.txt'
sudo chown root:1000 /volume2/docker/visit/update-token.txt
sudo chmod 0640 /volume2/docker/visit/update-token.txt
```

This is a token for the visitor website, **not** a Home Assistant API token. The site works without it (with **NO** and disabled writes), and picks it up when added without a container restart. Do not put the token in Git, Compose environment variables, or this README.

In Home Assistant's `/volume2/docker/hass/config/secrets.yaml`, add a secret with the **entire Authorization header value**, using the **same** token as in `/volume2/docker/visit/update-token.txt`:

```yaml
may_i_come_authorization_header: "Bearer PUT_THE_64_CHARACTER_HEX_TOKEN_HERE"
```

Make sure the URL in the `rest_command` points to your actual HTTPS hostname. The visitor states are deliberately an exact, fixed set; rename them in both code and YAML if you want different names.

The automation uses the existing `input_boolean.guest_mode`; **do not create a second guest-mode helper**. When it is `on`, `unknown`, or `unavailable`, the automation publishes **Absolutely not**, even if the manual `input_select.may_i_come` says visitors are welcome. Switching guest mode back `off` republishes the manual selection. The manual choice itself is left unchanged. If the manual helper is missing or has an invalid state, the published result is also **Absolutely not**.

Restart Home Assistant (or reload the relevant YAML integrations and automations) to load the helper and REST command. Use the **May I Come?** dropdown to set a visitor status. You can add the helper to a dashboard as an Entities card, or control it from an HA automation/voice assistant. On startup, changes to **either helper**, and **every minute**, HA posts the effective (guest-mode-aware) status to the app. The app considers HA reachable only if the last heartbeat arrived **less than 180 seconds ago** (`STATUS_TTL_SECONDS`). After that, the public verdict automatically becomes **ABSOLUTELY NOT**, regardless of the previously saved value. The visitor page refreshes every 30 seconds while visible, and also switches to NO on browser fetch failures. A service restart clears the status immediately; it remains NO until HA republishes, normally within one minute. Because this is a push integration, it cannot detect a failure instantly: a disconnected HA may take up to three minutes (plus at most 30 seconds of browser polling) to be reflected. The helper explicitly starts at `Absolutely not` following each HA restart.

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

Once the test is finished, change either helper in HA so it publishes the actual intended state. To test the occupancy override, select `Visitors welcome`, verify the guest mode is `off` and the page says **COME ON OVER!**, switch `guest_mode` `on` and verify **ABSOLUTELY NOT**, then switch it `off` again to restore the manual choice. Avoid putting the secret in public issue trackers or client-side code. Also note that a shell variable or curl command can be visible in shell history or process listings; prefer keeping the token in HA and the read-only server token file for routine use.

## 4. Security and privacy

- Only the public read-only status endpoint and assets need to be accessible to guests.
- Writes to `/api/ha-update` require a 32+ character Bearer token, checked with a timing-safe comparison. Missing, short, or unreadable tokens disable writes (`503`) without crashing the website.
- The visitor verdict immediately becomes **NO** when the token is missing, unreadable, or rotated. The token is reread on each API request, so provisioning it later does not require an app restart. After token replacement, a new authenticated Home Assistant update is required to display anything other than **NO**.
- The app requires HTTPS at the reverse proxy. The public endpoint does **not** expose anyone's address, HA hostname, HA API token, or schedule.
- If the app has never received an update, it shows **ABSOLUTELY NOT**, as it also does when the last heartbeat is stale or the status endpoint cannot be reached.
- Each HA update is a heartbeat; by default it expires after 180 seconds. Tune `STATUS_TTL_SECONDS` to adjust the offline detection threshold.
- The HA visitor-selection helper starts at **Absolutely not** on HA restart, rather than restoring a previously permissive selection.
- While `input_boolean.guest_mode` is `on`, `unknown`, or `unavailable`, the automation always publishes **Absolutely not**. Home Assistant can republish the manual choice once guest mode is explicitly `off`.
- Visitor status is held only in process memory. Every container restart starts from **NO** until Home Assistant sends another authenticated update. No `/data` volume or writable filesystem is needed.
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