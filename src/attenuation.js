import { cWeighting, numeric } from './analysis.js';

export function parseAttenuationRows(rows) {
  const points = rows.map(row => ({ frequency: numeric(row[0]), db: numeric(row[1]) }))
    .filter(point => Number.isFinite(point.frequency) && point.frequency > 0 && Number.isFinite(point.db));
  points.sort((a, b) => a.frequency - b.frequency);
  for (let i = 1; i < points.length; i++) {
    if (points[i].frequency === points[i - 1].frequency) throw new Error(`Frequency ${points[i].frequency} Hz appears more than once in the attenuation curve.`);
  }
  if (points.length < 2) throw new Error('Enter at least two valid frequency and attenuation pairs.');
  return points;
}

export function attenuationAt(frequency, points, outside = 'zero') {
  if (frequency < points[0].frequency) return outside === 'hold' ? points[0].db : 0;
  if (frequency > points.at(-1).frequency) return outside === 'hold' ? points.at(-1).db : 0;
  let low = 0, high = points.length - 1;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (points[middle].frequency <= frequency) low = middle; else high = middle; }
  const a = points[low], b = points[high];
  return a.db + (b.db - a.db) * (frequency - a.frequency) / (b.frequency - a.frequency);
}

export function applyAttenuation(points, curve, outside = 'zero') {
  let outsideCount = 0;
  const result = points.map(point => {
    const bins = point.contributors.map(bin => {
      if (bin.frequency < curve[0].frequency || bin.frequency > curve.at(-1).frequency) outsideCount++;
      const loss = attenuationAt(bin.frequency, curve, outside);
      return { frequency: bin.frequency, loss, sourceLevel: bin.sourceLevel, weightedLevel: bin.level, afterLevel: bin.level - loss };
    });
    const energy = bins.reduce((sum, bin) => sum + 10 ** (bin.afterLevel / 10), 0);
    return { rpm: point.rpm, before: point.level, after: 10 * Math.log10(energy), bins };
  });
  return { points: result, outsideCount };
}

export function pressureSpectrum(point, sourceWeighting = 'z') {
  return [...point.contributors].sort((a, b) => a.frequency - b.frequency).map(bin => {
    const unweightedLevel = sourceWeighting === 'c' ? bin.sourceLevel - cWeighting(bin.frequency) : bin.sourceLevel;
    const rmsPa = 20e-6 * 10 ** (unweightedLevel / 20);
    return { frequency: bin.frequency, spl: unweightedLevel, rmsPa, peakPa: Math.SQRT2 * rmsPa };
  });
}

export function apdlPressureTable(spectrum, component = 'ACOUSTIC_INLET') {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(component)) throw new Error('Use an APDL component name starting with a letter and containing only letters, numbers, or underscores (32 characters maximum).');
  if (spectrum.length < 2) throw new Error('At least two frequency bins are needed for an Ansys frequency table.');
  const lines = [
    '! FFT pressure spectrum for Harmonic Acoustics / Mechanical APDL',
    '! Pressure amplitudes are peak Pa from RMS SPL referenced to 20e-6 Pa.',
    '! Phase is unavailable in the source FFT and is assumed zero at all bins.',
    '! The selected nodal component must exist and belong to the acoustic fluid boundary.',
    '! Pressure boundary is prescribed (Dirichlet); reflected pressure at this boundary is not included.',
    `*DIM,FFT_P,TABLE,${spectrum.length},1,1,FREQ`
  ];
  spectrum.forEach((bin, i) => { lines.push(`FFT_P(${i + 1},0)=${bin.frequency.toPrecision(12)}`); lines.push(`FFT_P(${i + 1},1)=${bin.peakPa.toExponential(9)}`); });
  lines.push(`CMSEL,S,${component},NODE`, 'D,ALL,PRES,%FFT_P%', 'ALLSEL,ALL');
  return lines.join('\r\n') + '\r\n';
}
