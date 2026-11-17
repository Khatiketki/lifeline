-- Demo data: fictional facilities around Boston, a synthetic road grid,
-- providers, patients and a few existing bookings.
SELECT setseed(0.42);

-- ---------------------------------------------------------------------------
-- Facilities (fictional names, real-world-ish coordinates)
-- ---------------------------------------------------------------------------
INSERT INTO facilities (name, type, address, location, er_capacity, current_wait_minutes, specialties) VALUES
('Lifeline Back Bay Medical Center', 'hospital',    'Back Bay, Boston',     ST_MakePoint(-71.0810, 42.3505)::geography, 40, 25, '{cardiology,neurology,orthopedics,primary_care,emergency}'),
('Lifeline Longwood General',        'hospital',    'Longwood, Boston',     ST_MakePoint(-71.1060, 42.3370)::geography, 60, 40, '{cardiology,neurology,pediatrics,primary_care,emergency}'),
('Harborview Community Hospital',    'hospital',    'South Boston',         ST_MakePoint(-71.0450, 42.3350)::geography, 25, 15, '{orthopedics,primary_care,emergency}'),
('Charles River Children''s',        'hospital',    'Cambridge',            ST_MakePoint(-71.1100, 42.3750)::geography, 30, 20, '{pediatrics,neurology,emergency}'),
('Dorchester Regional Medical',      'hospital',    'Dorchester',           ST_MakePoint(-71.0600, 42.3100)::geography, 35, 55, '{cardiology,primary_care,emergency}'),
('Fenway Family Clinic',             'clinic',      'Fenway, Boston',       ST_MakePoint(-71.0950, 42.3450)::geography,  0,  0, '{primary_care,dermatology,pediatrics}'),
('North End Health Clinic',          'clinic',      'North End, Boston',    ST_MakePoint(-71.0540, 42.3650)::geography,  0,  0, '{primary_care,dermatology}'),
('Allston Wellness Clinic',          'clinic',      'Allston',              ST_MakePoint(-71.1300, 42.3540)::geography,  0,  0, '{primary_care,orthopedics,dermatology}'),
('Jamaica Plain Urgent Care',        'urgent_care', 'Jamaica Plain',        ST_MakePoint(-71.1150, 42.3100)::geography, 10, 10, '{primary_care,emergency}'),
('Seaport Urgent Care',              'urgent_care', 'Seaport, Boston',      ST_MakePoint(-71.0300, 42.3500)::geography, 10,  5, '{primary_care,emergency}'),
('Somerville Urgent Care',           'urgent_care', 'Somerville',           ST_MakePoint(-71.0900, 42.3900)::geography, 12, 30, '{primary_care,emergency}'),
('Brookline Heart & Vascular',       'clinic',      'Brookline',            ST_MakePoint(-71.1220, 42.3330)::geography,  0,  0, '{cardiology}');

-- ---------------------------------------------------------------------------
-- Road graph: 40x40 grid over the service area. Every 5th row/column is an
-- arterial (50 km/h), the rest are local streets (30 km/h). ~5% of local
-- segments are dropped to simulate closures so routes are not trivially
-- straight lines.
-- ---------------------------------------------------------------------------
INSERT INTO road_nodes (id, lat, lng)
SELECT r * 40 + c,
       42.30 + r * (0.10 / 39.0),
       -71.15 + c * (0.15 / 39.0)
FROM generate_series(0, 39) r, generate_series(0, 39) c;

WITH pairs AS (
    SELECT a.id AS f, b.id AS t, a.lat AS alat, a.lng AS alng, b.lat AS blat, b.lng AS blng,
           CASE
               WHEN b.id = a.id + 1  AND (a.id / 40) % 5 = 0 THEN 50   -- horizontal arterial
               WHEN b.id = a.id + 40 AND (a.id % 40) % 5 = 0 THEN 50   -- vertical arterial
               ELSE 30
           END AS speed
    FROM road_nodes a
    JOIN road_nodes b ON (b.id = a.id + 1 AND a.id % 40 <> 39) OR (b.id = a.id + 40)
), kept AS MATERIALIZED (
    SELECT * FROM pairs WHERE speed = 50 OR random() > 0.05
)
INSERT INTO road_edges (from_node, to_node, length_m, speed_kph)
SELECT f, t, ST_Distance(ST_MakePoint(alng, alat)::geography, ST_MakePoint(blng, blat)::geography), speed FROM kept
UNION ALL
SELECT t, f, ST_Distance(ST_MakePoint(alng, alat)::geography, ST_MakePoint(blng, blat)::geography), speed FROM kept;

-- ---------------------------------------------------------------------------
-- Providers: one or two per (facility, specialty) pair.
-- ---------------------------------------------------------------------------
INSERT INTO providers (name, specialty, facility_id, work_start, work_end, slot_minutes)
SELECT 'Dr. ' || (ARRAY['Avery','Jordan','Morgan','Riley','Casey','Quinn','Parker','Rowan','Sasha','Emerson','Hayden','Kai'])[1 + floor(random() * 12)::int]
              || ' ' ||
              (ARRAY['Chen','Patel','Okafor','Garcia','Nguyen','Kim','Silva','Haddad','Novak','Ito','Mensah','Rossi'])[1 + floor(random() * 12)::int],
       s.specialty,
       f.id,
       (ARRAY['08:00','09:00','10:00'])[1 + floor(random() * 3)::int]::time,
       (ARRAY['16:00','17:00','18:00'])[1 + floor(random() * 3)::int]::time,
       CASE WHEN s.specialty IN ('primary_care', 'dermatology') THEN 20 ELSE 30 END
FROM facilities f
CROSS JOIN LATERAL unnest(f.specialties) AS s(specialty)
CROSS JOIN LATERAL generate_series(1, CASE WHEN f.type = 'hospital' THEN 2 ELSE 1 END) n
WHERE s.specialty <> 'emergency';

-- ---------------------------------------------------------------------------
-- Patients: 250 synthetic patients with home locations inside the service area.
-- The first 12 are enrolled in remote vitals monitoring.
-- ---------------------------------------------------------------------------
INSERT INTO patients (name, date_of_birth, home_location, risk_level, monitored)
SELECT (ARRAY['Alex','Blake','Cameron','Dana','Eli','Frankie','Gray','Harper','Indy','Jamie','Kendall','Logan','Micah','Noor','Oakley','Peyton','Reese','Skyler','Tatum','Wren'])[1 + floor(random() * 20)::int]
         || ' ' ||
       (ARRAY['Adams','Brown','Carter','Diaz','Evans','Fischer','Gupta','Hughes','Ivanova','Johnson','Khan','Lopez','Murphy','Nakamura','Owens','Perez','Reyes','Singh','Taylor','Walsh'])[1 + floor(random() * 20)::int],
       DATE '1940-01-01' + floor(random() * 30000)::int,
       ST_MakePoint(-71.14 + random() * 0.13, 42.305 + random() * 0.09)::geography,
       (ARRAY['low','low','low','medium','medium','high'])[1 + floor(random() * 6)::int],
       g <= 12
FROM generate_series(1, 250) g;

-- ---------------------------------------------------------------------------
-- Existing bookings: for the next business day, book each provider's first
-- and a mid-day slot so the scheduler has real constraints to work around.
-- ---------------------------------------------------------------------------
WITH next_day AS (
    SELECT (CASE extract(isodow FROM now() AT TIME ZONE 'America/New_York')
                WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END
            + (now() AT TIME ZONE 'America/New_York')::date) AS d
)
INSERT INTO appointments (patient_id, provider_id, slot, priority, reason)
SELECT 1 + ((p.id * 7 + k) % 250),
       p.id,
       tstzrange(((nd.d + p.work_start) AT TIME ZONE 'America/New_York') + (k * p.slot_minutes) * interval '1 minute',
                 ((nd.d + p.work_start) AT TIME ZONE 'America/New_York') + ((k + 1) * p.slot_minutes) * interval '1 minute'),
       3,
       'Follow-up visit'
FROM providers p, next_day nd, unnest(ARRAY[0, 6]) k
ON CONFLICT DO NOTHING;
