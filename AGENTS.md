# AGENTS.md — Repository guidance

This file is for maintainers and coding assistants working on this repository. Keep end-user onboarding, configuration examples, and troubleshooting in `README.md`; keep implementation rules, editing conventions, and agent-specific instructions here. Do not add notes addressed to an AI assistant to the README.

## Repository scope

This is a small Node.js 22+ visitor-status application without runtime npm dependencies.

- `server.js`: HTTP server, token authentication, heartbeat and in-memory visitor state.
- `public/`: public page, styling and assets.
- `home-assistant/`: reusable Home Assistant configuration and automation examples.
- `compose.yaml`: standalone Docker Compose + Traefik example.
- `test/server.test.js`: regression tests using Node's built-in test runner.

Keep the repository independently usable. Do not couple examples or documentation to a particular person's network or deployment.

## Public examples and privacy

- Use `localhost` / `127.0.0.1` for local URLs, and reserved documentation domains such as `example.com`, `example.net`, or `example.org` when a hostname is needed.
- Do not include real hostnames, private domain names, infrastructure node names, LAN addresses, private mount paths, repository-specific deployment checkout paths, account IDs, or other identifiable operational details in documentation, examples, tests, comments, or issue/PR bodies.
- Never commit authentication tokens, passwords, authorization headers containing credentials, or other secrets. Use unmistakable placeholders. Do not expose token values in logs, test output, or public HTTP responses.
- Production-specific settings belong in the relevant deployment system, not in this generic application repository.
- Write the README for somebody installing or using the software. Avoid instructions about editing the README itself, internal authoring policy, historical cleanup, or AI workflows.

## Behavior and security invariants

- Exactly three public visitor states: `Absolutely not`, `Ask first`, and `Visitors welcome`. Unknown states must not grant permission.
- Default to `Absolutely not` on startup, missing credentials, invalid state, disconnected Home Assistant, or an expired heartbeat. Visitor state is in RAM only; do not reintroduce `/data` or status persistence.
- Home Assistant sends a heartbeat every minute; the server's default freshness timeout is 180 seconds. Keep the browser's safe fallback when its API is unreachable.
- The Home Assistant example checks `input_boolean.guest_mode`: only an explicit `off` permits the selected `input_select.may_i_come` value. `on`, `unknown`, `unavailable`, or absent helper means `Absolutely not`. Never overwrite the user's manual selection to implement the occupancy override.
- The website's update token is **optional on container startup**. File-backed credentials are reread per request; missing/unreadable/too-short token disables updates without crashing the site. Credential loss/rotation must not reinstate an old permissive decision.
- `POST /api/ha-update` requires a valid Bearer token and one of the fixed statuses; use timing-safe equality. `GET /api/status` remains publicly readable but never includes credentials.
- Demo controls belong only in demo mode. Do not accidentally expose write controls in production.

## Working practices

- Read the current source and tests before changing behavior; do not infer runtime state from a Git merge.
- Prefer focused branches and pull requests. Review the full diff and wait for all relevant CI checks before merging.
- Run `npm test` for behavior changes. For Docker changes, also validate the Compose file. Update regression tests for security and fail-closed behavior.
- Keep README instructions aligned with the actual application and Home Assistant example files; keep examples generic and concise.
- Keep production deployment and private configuration out of scope unless the user specifically requests changes in their respective source repositories.
