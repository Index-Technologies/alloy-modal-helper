# Alloy Modal Helper

Chrome extension for opening the Modal sandbox page for the current Alloy session.

Open an Alloy session page, click the extension, then click **Open in Modal**. The extension extracts the session ID from the current URL, asks a local helper server for the matching Modal sandbox ID, and opens the right Modal sandbox URL.

## Helper server

The extension cannot connect to Postgres directly, so a local helper server must be running:

```bash
docker compose up modal-helper
```

The helper listens on `http://127.0.0.1:5477` and accepts `POST /sandbox-id`. It receives the session ID plus the local/prod database URLs saved in the extension settings, queries `agent_session_sandbox`, and returns the Modal sandbox ID.

## Settings

Use the cog button in the extension popup to configure:

- Dev sandbox: `slavko-dev-sandbox`, `leo-dev-sandbox`, or `iaculch-dev-sandbox`
- Local database URL, used on `localhost`
- Prod database URL, used on `alloy.app`

When the helper is running in Docker, the local database URL must point back to the host machine:

```text
postgresql://postgres:mysecretpassword@host.docker.internal:5432/postgres
```

Do not use `localhost` for the local DB URL when running the helper in Docker, because `localhost` means the helper container itself.

For production, use the real RDS/Postgres hostname:

```text
postgresql://user:password@encrypted-ebs-db.example.us-west-2.rds.amazonaws.com:5432/ebdb
```

## Build

```bash
pnpm install
pnpm build
```

Then load `dist` as an unpacked extension from `chrome://extensions`.
