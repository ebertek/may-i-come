# May I Come? 🏠

A small, public visitor-permission page controlled from Home Assistant. Visitors see one of three answers; only your Home Assistant setup can change the answer.

| Home Assistant choice | Visitor page |
|---|---|
| `Absolutely not` | **ABSOLUTELY NOT.** |
| `Ask first` | **ASK FIRST.** |
| `Visitors welcome` | **COME ON OVER!** |

The included Home Assistant automation also checks `input_boolean.guest_mode`. When guest mode is on, unknown, or unavailable, the visitor page always says **ABSOLUTELY NOT**, without changing your manual choice.

## Try it locally

Requires Node.js 22 or newer.

```bash
npm run demo
```

Open [http://localhost:3000](http://localhost:3000). Demo mode lets you preview all three answers. It does not accept Home Assistant updates.

## Deploy with Docker Compose

The included [`compose.yaml`](compose.yaml) is an example using Traefik and the reserved hostname `visit.example.com`. Set your actual hostname and external proxy network before starting it. Configure HTTPS at your reverse proxy.

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/update-token.txt
chmod 600 secrets/update-token.txt
docker compose up -d --build
```

The token in `secrets/update-token.txt` authenticates Home Assistant's updates. The container user must be able to read it. The directory is bind-mounted read-only, so the token can also be added after startup without restarting the application.

The token is optional for starting the website: without a readable token, the page stays at **ABSOLUTELY NOT** and authenticated updates are unavailable. No persistent data volume is needed.

## Connect Home Assistant

Example files are provided in [`home-assistant/`](home-assistant/):

- Merge the `input_select` and `rest_command` entries from [`configuration.yaml`](home-assistant/configuration.yaml) into your Home Assistant configuration. If your visitor-choice helper already exists, don't create a duplicate.
- Add the automation from [`automation.yaml`](home-assistant/automation.yaml) to your Home Assistant automations.
- In Home Assistant's `secrets.yaml`, add the authorization header using the same token as the website:

  ```yaml
  may_i_come_authorization_header: "Bearer REPLACE_WITH_YOUR_TOKEN"
  ```

Replace the example URL in the REST command with your actual HTTPS hostname. Restart Home Assistant or reload the relevant YAML configurations.

The automation expects `input_boolean.guest_mode` to indicate whether guests are already present. Create a toggle helper with that entity ID, connect it to your occupancy detection, or adapt the automation to use another entity. If the entity is missing or unavailable, the automation deliberately publishes **ABSOLUTELY NOT**.

Home Assistant publishes the effective answer when either helper changes, at startup, and every minute. Turning guest mode off republishes your original visitor choice.

## Check that it works

Select **Visitors welcome** in Home Assistant while guest mode is off. The page should show **COME ON OVER!**. Switch guest mode on; it should change to **ABSOLUTELY NOT**. Switch guest mode off to restore the selected answer.

You can also inspect the public status response:

```bash
curl -s https://visit.example.com/api/status
```

Replace `visit.example.com` with your own hostname. The response includes `status`, `updatedAt`, and `connected`.

If no authenticated update has arrived, the container restarts, or Home Assistant stops publishing for 180 seconds, the page defaults to **ABSOLUTELY NOT**. The browser refreshes the status every 30 seconds while visible. If it remains disconnected, check your Home Assistant automation, REST command URL, and token-file readability.

## HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `/` | Public visitor page |
| `GET /api/status` | Read-only visitor status |
| `POST /api/ha-update` | Authenticated Home Assistant update |
| `GET /healthz` | Container health check |

The website has no browser-based administrator account. It uses its own Bearer token for updates, **not** a Home Assistant long-lived access token.

Made with love, boundaries, and no surprise visits.
