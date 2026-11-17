// Appointments are scheduled in the clinic's time zone, not the viewer's.
export const CLINIC_TZ = 'America/New_York';

export const fmtClinic = (iso) =>
  new Date(iso).toLocaleString([], {
    timeZone: CLINIC_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** "2030-01-07T10:00" read as clinic wall-clock time -> ISO instant. */
export function clinicLocalToIso(local) {
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // Two passes handle DST transitions.
  let ts = guess - offsetMs(new Date(guess), CLINIC_TZ);
  ts = guess - offsetMs(new Date(ts), CLINIC_TZ);
  return new Date(ts).toISOString();
}
