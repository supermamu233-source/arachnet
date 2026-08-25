# Robot simulator

Simulates a physical warehouse robot speaking Arachnet's robot protocol
(auth headers -> presign -> upload -> finalize -> observe). Pure Python
standard library — no `pip install` needed, so the same script can run
unmodified on constrained hardware (e.g. a Raspberry Pi) later. Requires
Python 3.9+.

## 1. Start the local dev server

```sh
pnpm dev   # serves http://localhost:3000
```

Postgres and MinIO must already be running locally (see the repo's main
setup notes) — this simulator talks to the real dev database and the real
`arachnet-evidence` MinIO bucket, nothing is mocked.

## 2. Get a robot device secret

The demo seed (`pnpm db:seed`) creates a `scout-001` robot device, but its
secret is only ever shown once, at the moment it was seeded — it is not
retrievable afterwards (only its hash is persisted, by design). You have two
options:

**Option A — rotate the seeded robot's secret** (keeps the `scout-001` code
and its warehouse/location association):

1. Sign in to the dashboard as a human user with the ADMIN role or higher.
2. Go to **Robots** -> `scout-001` -> **Rotar secreto**.
3. Copy the secret shown — it will never be shown again.

**Option B — create a brand new robot** from the **Robots** page (**Nuevo
robot**), picking any warehouse and a code of your choice. If you do this,
also set `ROBOT_CODE` and `LOCATION_CODE`/`EAN` below to match a location and
product that actually exist in that warehouse.

Either way, export the secret you were shown:

```sh
export ROBOT_SECRET="paste-the-one-time-secret-here"
```

## 3. Run the simulator

```sh
# from the repo root
pnpm robot:simulate

# or directly
python3 tools/robot-simulator/simulator.py
```

Each run retries any unsent/failed events left over from a previous
(crashed or interrupted) run, then sends exactly one new observation event
and prints the reconciliation result it gets back:

```
[robot-simulator] Base URL: http://localhost:3000  Robot: scout-001  Location: WH1-A03-RB-L04  EAN: 8431234567890
[robot-simulator] Event 3f2a...: accepted.
[robot-simulator]   Expected: 82  Observed: 74  Difference: -8  Status: SHORTAGE  Confidence: HIGH
```

Run it again with the same environment and it queues and sends a *new*
event id each time — to see the idempotency-replay behavior instead, see
below.

## Configuration (environment variables)

| Variable | Default | Notes |
| --- | --- | --- |
| `ARACHNET_BASE_URL` | `http://localhost:3000` | Base URL of the running app |
| `ROBOT_CODE` | `scout-001` | Must match a `RobotDevice.code` |
| `ROBOT_SECRET` | *(required)* | The one-time-shown device secret |
| `LOCATION_CODE` | `WH1-A03-RB-L04` | Must exist in the robot's warehouse |
| `EAN` | `8431234567890` | Looked up via exact `ProductBarcode` match |
| `BOXES` | `12` | Boxes observed |
| `LOOSE_UNITS` | `2` | Loose units observed |
| `CONFIDENCE` | `0.97` | 0–1; below the configured thresholds forces `REVIEW_REQUIRED` |
| `SAMPLE_IMAGE_PATH` | `sample_image.jpg` (checked in, next to this script) | A real, decodable JPEG — evidence finalization actually decodes it server-side |
| `ROBOT_QUEUE_DB` | `robot_queue.sqlite3` (next to this script) | Local retry queue |

## Behavior notes

- **Crash-safe retries**: every event is written to the local SQLite queue
  (`ROBOT_QUEUE_DB`) before it's sent. On the next run, anything still
  `pending` or `error` from a previous run is retried *before* a new event
  is created — a crash mid-flight never silently drops an observation.
- **Replay is success**: if the server reports `data.replay === true` (it
  recognized the `eventId` as one it already fully processed with the exact
  same payload), the simulator logs it as a success, not an error.
- **Idempotency conflict is reported distinctly**: if the server returns
  `409` (the `eventId` was reused with different data — see
  `docs/robot-protocol.md`), the simulator logs it clearly as a CONFLICT,
  marks that queued event `conflict` in SQLite, and does not retry it
  automatically (retrying would just get another 409).
- To manually force a conflict for testing, edit a `sent` row's `boxes` in
  the SQLite file back to `pending` with different values and re-run — or
  simpler, read `docs/robot-protocol.md`'s idempotency section and drive the
  API directly with `curl`.
