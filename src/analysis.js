export function cWeighting(frequency) {
  if (!(frequency > 0)) return -Infinity;
  const f2 = frequency * frequency;
  const response = (12200 ** 2 * f2) / ((f2 + 20.6 ** 2) * (f2 + 12200 ** 2));
  return 20 * Math.log10(response) + 0.06;
}

export function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null || value === '') return NaN;
  const clean = String(value).trim().replace(/,/g, '').replace(/\s*(hz|rpm|db(?:c|spl)?)\s*$/i, '');
  return clean === '' ? NaN : Number(clean);
}

export function analyze(records, sourceWeighting = 'z') {
  const byRpm = new Map();
  let accepted = 0;
  for (const record of records) {
    const rpm = numeric(record.rpm), frequency = numeric(record.frequency), level = numeric(record.level);
    if (!Number.isFinite(rpm) || rpm < 0 || !Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(level)) continue;
    const weighted = level + (sourceWeighting === 'c' ? 0 : cWeighting(frequency));
    const energy = 10 ** (weighted / 10);
    if (!Number.isFinite(energy) || energy <= 0) continue;
    if (!byRpm.has(rpm)) byRpm.set(rpm, new Map());
    const bins = byRpm.get(rpm);
    const current = bins.get(frequency) || { energy: 0, sourceEnergy: 0, count: 0 };
    current.energy += energy;
    current.sourceEnergy += 10 ** (level / 10);
    current.count++;
    bins.set(frequency, current);
    accepted++;
  }
  const points = [...byRpm].map(([rpm, bins]) => {
    const contributors = [...bins].map(([frequency, value]) => ({ frequency, energy: value.energy / value.count, sourceLevel: 10 * Math.log10(value.sourceEnergy / value.count) }));
    const totalEnergy = contributors.reduce((sum, item) => sum + item.energy, 0);
    contributors.forEach(item => { item.share = item.energy / totalEnergy; item.level = 10 * Math.log10(item.energy); });
    contributors.sort((a, b) => b.energy - a.energy);
    return { rpm, level: 10 * Math.log10(totalEnergy), contributors, bins: contributors.length };
  }).sort((a, b) => a.rpm - b.rpm);
  return { points, accepted };
}

export function recordsFromGrid(rows, { layout, headerRow, rpmColumn, frequencyColumn, levelColumn, firstColumn }) {
  const header = rows[headerRow] || [];
  const records = [];
  if (layout === 'long') {
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      records.push({ rpm: row[rpmColumn], frequency: row[frequencyColumn], level: row[levelColumn] });
    }
  } else {
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      for (let j = 0; j < Math.max(header.length, row.length); j++) {
        if (j === firstColumn) continue;
        const dimension = numeric(header[j]);
        if (!Number.isFinite(dimension)) continue;
        records.push(layout === 'freqRows'
          ? { frequency: row[firstColumn], rpm: dimension, level: row[j] }
          : { rpm: row[firstColumn], frequency: dimension, level: row[j] });
      }
    }
  }
  return records;
}
