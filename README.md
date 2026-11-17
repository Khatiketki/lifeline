# Lifeline – Distributed Healthcare Platform

A full-stack healthcare platform built as containerized microservices:

- **Real-time vitals processing**: streaming ingest, early-warning scoring, anomaly detection, and live WebSocket push to clinicians
- **Conflict-aware appointment scheduling**: double-booking is blocked in the database itself, and a ranking engine spreads concurrent requests so fewer of them collide
- **Geospatial emergency routing**: PostGIS nearest-facility search combined with A* road routing, ranked by drive time plus live ER wait

**Stack:** React · Node.js (Express, ws) · Java 17 (Spring Boot) · PostgreSQL 16 + PostGIS · Docker · AWS (ECS Fargate, RDS, ALB, ECR, Cloud Map) via Terraform

```
                    ┌──────────────────────────┐
  Browser ─────────▶│ frontend (React + nginx) │
     │  /api, /ws   └────────────┬─────────────┘
     │                           │ proxy
     │              ┌────────────▼─────────────┐  REST   ┌───────────────────────────┐
     └─────────────▶│ core-api (Node.js)       │────────▶│ routing-service (Java)    │
        WebSocket   │ • patients / alerts      │         │ • in-memory CSR road graph│
                    │ • scheduling engine      │         │ • A* time-optimal routing │
                    │ • vitals stream processor│         │ • PostGIS KNN candidates  │
                    └────────────┬─────────────┘         └─────────────┬─────────────┘
                                 │                                     │
                    ┌────────────▼─────────────────────────────────────▼───┐
                    │ PostgreSQL 16 + PostGIS                              │
                    │ exclusion constraints · GiST/BRIN/partial indexes    │
                    └──────────────────────────────────────────────────────┘
```

## Quick start

```bash
docker compose up --build
```

| URL | What |
| --- | --- |
| http://localhost:3000 | Web app |
| http://localhost:4000/api/metrics | API latency percentiles, scheduling and ingest counters |
| http://localhost:8080/api/routing/graph | Routing graph stats |

On first boot, Postgres runs `db/init/*.sql`, which loads 12 facilities, about 30 providers, 250 patients, a 1,600-node road grid, and some existing bookings. The vitals simulator streams 1 Hz readings for the 12 monitored patients.

To reset the data: `docker compose down -v`.

## Services

### core-api (Node.js) `services/core-api`

| Endpoint | Purpose |
| --- | --- |
| `POST /api/appointments/suggest` | Ranked free slots for `{patientId, specialty, preferredStart, priority}` |
| `POST /api/appointments` | Book a specific slot. On a race it returns `409` plus fresh alternatives |
| `POST /api/appointments/auto` | Suggest and book in one call, retrying automatically if another request takes the slot first |
| `POST /api/vitals` | Device ingest (one reading or a batch of up to 1,000) |
| `GET /api/patients/:id/vitals?minutes=10` | Recent vitals history |
| `GET /api/alerts`, `POST /api/alerts/:id/ack` | Clinical alerts |
| `GET /api/facilities/nearest?lat&lng&specialty` | Gateway to the routing service |
| `GET /api/metrics` | p50/p95/p99 per route, conflict rate, ingest stats |
| `ws://…/ws` | Push channel: `vitals`, `alert`, `facility_wait` |

**Scheduling** (`src/scheduling/`)
- `appointments` has `EXCLUDE USING gist (provider_id WITH =, slot WITH &&)` (and the same for patients). Overlapping bookings can't be committed, even with many API replicas writing at once.
- `scheduler.js` is a pure engine. It turns working windows and existing bookings into free slots, then scores each slot on four things: closeness to the preferred time (or earliest time when urgent), provider utilization, travel distance from the patient's home (PostGIS), and calendar fragmentation. It then picks randomly among the near-equivalent top slots so concurrent requests don't all reach for the same one.
- `npm run simulate:scheduling` runs a reproducible benchmark. Waves of concurrent requests plan against the same calendar snapshot, and the benchmark compares this engine with the usual "closest free slot" approach:

  ```
  strategy   conflict-rate  conflicts/run  booked/run  avg-hours-from-preferred
  baseline           0.698          208.5        90.0                      1.90
  lifeline           0.377           54.5        90.0                      1.95
  Conflict-rate reduction vs baseline: 46.0%     (concurrency 6; 36.2% at concurrency 10)
  ```

**Real-time processing** (`src/realtime/`)
- `processor.js` scores every reading with an early warning score modelled on NEWS2. It flags heart-rate anomalies using a z-score against a 60-reading sliding window per patient, and it de-duplicates alerts with a cooldown.
- Readings are buffered and written in batches, one `INSERT … SELECT FROM UNNEST(...)` every 2 s, instead of one row per request. If the database fails, the batch is re-queued, with a bounded buffer as back-pressure.
- `hub.js` coalesces WebSocket frames to one per second per client.

### routing-service (Java / Spring Boot) `services/routing-service`

| Endpoint | Purpose |
| --- | --- |
| `GET /api/routing/route?fromLat&fromLng&toLat&toLng` | A* route: path, distance, ETA, nodes expanded |
| `GET /api/routing/nearest?lat&lng&specialty&type&k` | Facilities ranked by drive time plus live ER wait |
| `POST /api/routing/graph/reload` | Hot-swap the road graph from the DB |

- `RoadGraph` stores the network in **compressed sparse row** form (flat primitive arrays) and uses a grid bucket index to snap coordinates to the nearest node.
- `AStar` uses an admissible heuristic (straight-line distance ÷ top speed), a primitive binary heap, and lazy decrease-key. Tests check that its results match Dijkstra while it expands fewer nodes.
- Candidate facilities come from a PostGIS KNN query (`ORDER BY location <-> point`, using the GiST index), so A* only runs for a handful of plausible facilities. An LRU cache stores node-pair paths.

### Database optimizations `db/init/001_schema.sql`
- GiST on `facilities.location` for KNN and radius queries. GIN on `specialties`.
- GiST exclusion constraints, which double as the overlap index for scheduling lookups.
- `vitals`: a composite `(patient_id, recorded_at DESC)` index for "latest N readings", plus **BRIN** on `recorded_at` for cheap time-range scans over the append-only table.
- Partial indexes for the hot paths: booked appointments, unacknowledged alerts, monitored patients.
- Pooled connections with statement timeouts on both services.

## Tests & benchmarks

```bash
cd services/core-api && npm install && npm test        # scheduler + stream processor
cd services/core-api && npm run simulate:scheduling    # conflict benchmark
cd services/routing-service && mvn verify              # A* / graph tests (JDK 17)
cd frontend && npm install && npm run build

# Against a running stack:
cd services/core-api && npm run loadtest -- --requests 4000 --concurrency 50
```

### Measured locally (Docker Desktop on Windows, single replica of each service)

`npm run loadtest -- --requests 4000 --concurrency 50` gave 0 errors. Server-side latency from `/api/metrics`:

| Route | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: |
| `GET /api/patients` | 47 | 89 | 122 |
| `GET /api/patients/:id/vitals` | 50 | 94 | 109 |
| `GET /api/facilities/nearest` (PostGIS + A*) | 82 | 140 | 278 |
| `POST /api/appointments/suggest` | 123 | 180 | 219 |

Other checks:
- **Same-slot race:** 10 clients booked the same slot simultaneously. Exactly 1 got `201` and 9 got `409` with alternatives.
- **Concurrent auto-booking:** 90 requests in waves of 30, all for the same preferred time. All 90 were booked, each in a unique slot.

## Deploying to AWS

`infra/terraform` provisions:
- a VPC (public subnets for the ALB, private subnets for everything else)
- ECR repositories
- RDS Postgres 16 (encrypted, with Secrets Manager-managed credentials and slow-query logging)
- an ECS Fargate cluster with three services and CPU autoscaling for the API
- Cloud Map private DNS (`api.lifeline.local`, `routing.lifeline.local`)
- an ALB that sends `/api/*` and `/ws` to the API and everything else to the SPA, with optional HTTPS through ACM

```bash
./scripts/deploy-aws.sh   # terraform apply → build & push images → run migrations task → roll out
```

To tear it down: `terraform -chdir=infra/terraform destroy`. The NAT gateway, RDS and ALB cost money while they're running.

## Local development without Docker

```bash
# Postgres with PostGIS on :5432, then load db/init/*.sql
cd services/routing-service && mvn spring-boot:run
cd services/core-api && npm install && npm run dev
cd frontend && npm install && npm run dev            # http://localhost:5173 (proxies /api and /ws)
```

## Known limitations / next steps
- With multiple API replicas, each replica only pushes WebSocket events produced on that replica. A Redis or SNS fan-out would make the push channel cluster-wide.
- The road network is a synthetic grid. Importing OpenStreetMap data (osm2pgsql) into `road_nodes`/`road_edges` would give real routes without code changes.
- There is no authentication or authorization. A real deployment would need OIDC, row-level access control, audit logging, and HIPAA-grade controls.
- All data is synthetic. Don't use real patient information.
