# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

**Alloy Modal Helper** is a Chrome extension (pnpm monorepo) that reads a session UUID from the active tab URL, calls a local **modal-helper** HTTP server on port **5477**, looks up the Modal sandbox ID in Postgres, and opens the matching Modal.com URL.

See `README.md` for the user-facing flow.

### Prerequisites

- **Node.js** ≥ 22.15.1 (see `.nvmrc`)
- **pnpm** 10.11.0 (`packageManager` in root `package.json`)
- **Google Chrome** (or Chromium) to load the unpacked extension from `dist/`
- **PostgreSQL** with table `agent_session_sandbox` for full product E2E (not bundled in this repo)
- **Docker** (optional) to run modal-helper via `docker compose up modal-helper`

### Common commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Build extension | `pnpm build` → output in `dist/` |
| Dev (HMR) | `pnpm dev` — cleans `dist/`, runs `turbo watch dev`; HMR WebSocket on `:8081` |
| Lint | `pnpm lint` |
| Type-check | `pnpm type-check` — may fail on a fresh clone until workspace packages are built (`pnpm build` or `turbo ready`) |
| E2E (boilerplate) | `pnpm e2e` — builds, zips, runs WebdriverIO |
| modal-helper (local) | `pnpm modal-helper:dev` |
| modal-helper (Docker) | `pnpm modal-helper:docker` |

### Services to run for product testing

1. **modal-helper** — `pnpm modal-helper:dev` (listens on `http://127.0.0.1:5477`)
2. **PostgreSQL** — default URL in popup/modal-helper: `postgresql://postgres:mysecretpassword@localhost:5432/postgres`
3. **Chrome** — load unpacked extension from `/workspace/dist` after `pnpm build`

`pnpm dev` wipes and rebuilds `dist/`; use it for active development. For a stable unpacked load in Chrome, prefer `pnpm build` first.

### Gotchas

- **`pnpm type-check` on fresh install**: Several packages (`@extension/i18n`, `@extension/content-ui`, etc.) depend on generated/built artifacts. Run `pnpm build` once before expecting a clean type-check.
- **`pnpm e2e` extension tests**: Fail on newer Chrome (e.g. 148+) because WebdriverIO cannot reach the `extensions-item` shadow DOM on `chrome://extensions` (see `tests/e2e/utils/extension-path.ts` and upstream issue #786). The smoke spec (`specs/smoke.test.ts`) still passes.
- **PostgreSQL is external**: Not in `docker-compose.yml`. modal-helper Docker image connects via `host.docker.internal:5432`. On Linux VMs, start Postgres manually, e.g. `sudo pg_ctlcluster 16 main start`.
- **Pre-commit hook**: Husky runs `pnpm dlx lint-staged --allow-empty` (Prettier + ESLint on staged files).

### Hello-world verification

```bash
pnpm install && pnpm build
sudo pg_ctlcluster 16 main start   # if Postgres installed but not running
pnpm modal-helper:dev              # separate terminal

curl -X POST http://127.0.0.1:5477/sandbox-id \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<valid-uuid>","databaseKey":"local","localDatabaseUrl":"postgresql://postgres:mysecretpassword@localhost:5432/postgres"}'
```

Load `dist/` as an unpacked extension in Chrome, open a tab whose URL contains the session UUID, open the popup, and click **Open in Modal**.
