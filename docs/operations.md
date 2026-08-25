# Operations runbook

## Local environment (this build's sandbox has no Docker)

This repo's documented standard local path is `docker-compose.yml`
(Postgres 16 + MinIO). The sandbox this MVP was built in does not have
Docker/Colima available, so local services run natively via Homebrew
instead — functionally equivalent, just started differently:

```bash
# Postgres
brew install postgresql@16   # once
brew services start postgresql@16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
pg_isready                    # should say "accepting connections"
createdb arachnet_dev         # once
createdb arachnet_test        # once

# MinIO (no brew service registered — start manually)
brew install minio minio-mc   # once
MINIO_ROOT_USER=arachnet_minio MINIO_ROOT_PASSWORD=arachnet_minio_secret \
  nohup /opt/homebrew/opt/minio/bin/minio server --address ":9000" \
  --console-address ":9001" ./.minio-data > /tmp/minio.log 2>&1 &

mc alias set arachnet http://localhost:9000 arachnet_minio arachnet_minio_secret
mc mb arachnet/arachnet-evidence
mc mb arachnet/arachnet-evidence-test
mc anonymous set none arachnet/arachnet-evidence
mc anonymous set none arachnet/arachnet-evidence-test
```

If Docker IS available on your machine, prefer `docker compose up -d`
instead of the above — it starts both services with the same credentials
`docker-compose.yml` expects.

## Clean-clone setup

```bash
pnpm install
cp .env.example .env        # fill in DATABASE_URL/DIRECT_URL/S3_*/AUTH_SECRET/ROBOT_AUTH_PEPPER
                             # (see "Local environment" above for local values,
                             # or docs/deployment.md for Neon/R2 values)
pnpm db:migrate:deploy       # applies existing migrations (or db:migrate for a fresh dev DB)
pnpm db:seed                 # creates demo org/warehouse/products/robot/owner user —
                              # prints a ONE-TIME temporary owner password, save it now
pnpm dev
```

## Seed data

`prisma/seed.ts` is idempotent (uses `upsert` throughout) — safe to re-run.
It creates:

- Organization `demo-warehouse`, warehouse `WH1`, a 5-level location
  hierarchy under `WH1-A03-RB-*`.
- 20 products (`SKU-0001`..`SKU-0020`), one of which (`SKU-0001`) has EAN
  `8431234567890` / `defaultUnitsPerBox: 6` at location `WH1-A03-RB-L04`
  with an expected balance of 82 — this is the exact fixture the required
  robot-integration demo/test case uses.
- Expected balances for several other products.
- A robot device `scout-001` (its secret is generated fresh and printed
  once — the same rule as the owner password below applies).
- One `OWNER` user, `owner@arachnet.local`, with a randomly generated
  temporary password printed once to the terminal. There is no hardcoded
  production password anywhere in this codebase.

## Rotating a robot secret

If you've lost a seeded robot's secret (it's only ever shown once), don't
try to recover it — rotate it:

```bash
# as an ADMIN+ user, via the dashboard (Robots → rotate) or:
curl -X POST http://localhost:3000/api/robots/<id>/rotate-secret \
  -H "Cookie: <your session cookie>"
```

## Running the robot simulator

See `docs/robot-protocol.md` and `tools/robot-simulator/README.md` for the
exact command — in short, it needs the app running (`pnpm dev`), a robot
code + secret (from seed output or a fresh `rotate-secret` call), and will
print the reconciliation result (expected/observed/difference) after each
run.

## Troubleshooting

- **"invalid email or password" on a login you're sure is correct**: check
  that the `Account` row for that user has `providerId: "credential"` AND
  `issuer: "local:credential"` — better-auth 1.7 added the `issuer` column
  and silently fails sign-in without it (see `chatgpt.md`'s Phase 1 entry
  for how this was diagnosed).
- **Prisma CLI refuses `migrate reset`**: this is an intentional agent-safety
  guard (Prisma detects it's being invoked by an AI coding agent and refuses
  a destructive reset without explicit human consent passed via an env var).
  Don't try to work around it — if you really need a full reset, run it
  yourself as a human, or ask whoever is operating an AI agent session to
  get your explicit sign-off first.
- **MinIO port already in use**: another instance may already be running
  from a previous session — check `curl -s http://localhost:9000/minio/health/live`
  before starting a new one.

## Backup / restore (Neon production)

Neon has point-in-time restore built in (check your plan's retention
window) — prefer that over ad hoc `pg_dump`/`pg_restore` for production
recovery. For a manual logical backup:

```bash
pg_dump "$DIRECT_URL" -Fc -f arachnet-backup-$(date +%Y%m%d).dump
# restore:
pg_restore -d "$DIRECT_URL" --clean --if-exists arachnet-backup-YYYYMMDD.dump
```

Never run a restore against a database other people are actively using
without a maintenance window — it will conflict with live writes.
