// Early Warning Score, modelled on the NEWS2 physiological parameters
// (without the consciousness/oxygen-supplement inputs a device can't report).

const band = (v, rules) => {
  for (const [test, score] of rules) if (test(v)) return score;
  return 0;
};

export function scoreComponents({ heart_rate, spo2, systolic_bp, resp_rate, temperature }) {
  return {
    resp_rate: resp_rate == null ? 0 : band(resp_rate, [[(v) => v <= 8, 3], [(v) => v <= 11, 1], [(v) => v <= 20, 0], [(v) => v <= 24, 2], [() => true, 3]]),
    spo2: spo2 == null ? 0 : band(spo2, [[(v) => v <= 91, 3], [(v) => v <= 93, 2], [(v) => v <= 95, 1]]),
    systolic_bp: systolic_bp == null ? 0 : band(systolic_bp, [[(v) => v <= 90, 3], [(v) => v <= 100, 2], [(v) => v <= 110, 1], [(v) => v <= 219, 0], [() => true, 3]]),
    heart_rate: heart_rate == null ? 0 : band(heart_rate, [[(v) => v <= 40, 3], [(v) => v <= 50, 1], [(v) => v <= 90, 0], [(v) => v <= 110, 1], [(v) => v <= 130, 2], [() => true, 3]]),
    temperature: temperature == null ? 0 : band(temperature, [[(v) => v <= 35, 3], [(v) => v <= 36, 1], [(v) => v <= 38, 0], [(v) => v <= 39, 1], [() => true, 2]]),
  };
}

export function earlyWarningScore(reading) {
  const parts = scoreComponents(reading);
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const redFlag = Object.values(parts).some((s) => s === 3);
  let level = 'normal';
  if (total >= 7) level = 'critical';
  else if (total >= 5 || redFlag) level = 'warning';
  return { total, level, parts };
}
