-- Lifeline schema. Runs automatically on first start of the Postgres container.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Facilities & providers
-- ---------------------------------------------------------------------------
CREATE TABLE facilities (
    id                   SERIAL PRIMARY KEY,
    name                 TEXT NOT NULL,
    type                 TEXT NOT NULL CHECK (type IN ('hospital', 'clinic', 'urgent_care')),
    address              TEXT,
    location             GEOGRAPHY(Point, 4326) NOT NULL,
    er_capacity          INT  NOT NULL DEFAULT 0,
    current_wait_minutes INT  NOT NULL DEFAULT 0,
    specialties          TEXT[] NOT NULL DEFAULT '{}',
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- GiST index powers KNN (<->) and ST_DWithin lookups for nearest-facility routing.
CREATE INDEX facilities_location_gix ON facilities USING GIST (location);
CREATE INDEX facilities_specialties_gin ON facilities USING GIN (specialties);

CREATE TABLE providers (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    specialty    TEXT NOT NULL,
    facility_id  INT  NOT NULL REFERENCES facilities (id),
    work_start   TIME NOT NULL DEFAULT '09:00',
    work_end     TIME NOT NULL DEFAULT '17:00',
    slot_minutes INT  NOT NULL DEFAULT 30 CHECK (slot_minutes > 0)
);
CREATE INDEX providers_specialty_idx ON providers (specialty);

CREATE TABLE patients (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    date_of_birth DATE,
    home_location GEOGRAPHY(Point, 4326),
    risk_level    TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
    monitored     BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX patients_monitored_idx ON patients (id) WHERE monitored;

-- ---------------------------------------------------------------------------
-- Scheduling
-- The exclusion constraints make double-booking impossible at the database
-- level, even under concurrent writes from many API replicas.
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
    id          BIGSERIAL PRIMARY KEY,
    patient_id  INT NOT NULL REFERENCES patients (id),
    provider_id INT NOT NULL REFERENCES providers (id),
    slot        TSTZRANGE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'completed', 'cancelled')),
    priority    INT  NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT no_provider_overlap EXCLUDE USING gist (provider_id WITH =, slot WITH &&) WHERE (status = 'booked'),
    CONSTRAINT no_patient_overlap  EXCLUDE USING gist (patient_id  WITH =, slot WITH &&) WHERE (status = 'booked')
);
CREATE INDEX appointments_start_idx ON appointments (lower(slot)) WHERE status = 'booked';

-- ---------------------------------------------------------------------------
-- Real-time monitoring
-- ---------------------------------------------------------------------------
CREATE TABLE vitals (
    id          BIGSERIAL PRIMARY KEY,
    patient_id  INT NOT NULL REFERENCES patients (id),
    recorded_at TIMESTAMPTZ NOT NULL,
    heart_rate  REAL,
    spo2        REAL,
    systolic_bp REAL,
    resp_rate   REAL,
    temperature REAL,
    ews_score   SMALLINT
);
-- Composite index serves "latest N readings for patient"; BRIN keeps time-range
-- scans over the append-only table cheap at a tiny fraction of a B-tree's size.
CREATE INDEX vitals_patient_time_idx ON vitals (patient_id, recorded_at DESC);
CREATE INDEX vitals_time_brin ON vitals USING BRIN (recorded_at);

CREATE TABLE alerts (
    id           BIGSERIAL PRIMARY KEY,
    patient_id   INT NOT NULL REFERENCES patients (id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    severity     TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    kind         TEXT NOT NULL,
    message      TEXT NOT NULL,
    acknowledged BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX alerts_open_idx ON alerts (created_at DESC) WHERE NOT acknowledged;

-- ---------------------------------------------------------------------------
-- Road network used by the Java routing service (A* over a weighted graph).
-- ---------------------------------------------------------------------------
CREATE TABLE road_nodes (
    id  INT PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL
);

CREATE TABLE road_edges (
    from_node INT NOT NULL REFERENCES road_nodes (id),
    to_node   INT NOT NULL REFERENCES road_nodes (id),
    length_m  DOUBLE PRECISION NOT NULL,
    speed_kph DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (from_node, to_node)
);
