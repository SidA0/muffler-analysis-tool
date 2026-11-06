export const BAND_WIDTH_HZ = 300;

export function bandKey(frequency) {
  return Math.floor(frequency / BAND_WIDTH_HZ);
}

export function bandLabel(key) {
  return `${key * BAND_WIDTH_HZ}–${(key + 1) * BAND_WIDTH_HZ} Hz`;
}

export function bandContributions(bins) {
  const total = bins.reduce((sum, bin) => sum + bin.energy, 0);
  const bands = new Map();
  for (const bin of bins) {
    if (!(bin.frequency > 0) || !(bin.energy > 0)) continue;
    const key = bandKey(bin.frequency);
    const band = bands.get(key) || { key, energy: 0, bins: [] };
    band.energy += bin.energy;
    band.bins.push(bin);
    bands.set(key, band);
  }
  return [...bands.values()].map(band => ({ ...band, share: band.energy / total, level: 10 * Math.log10(band.energy), label: bandLabel(band.key) })).sort((a, b) => b.energy - a.energy);
}

export function standoutTone(bins) {
  const total = bins.reduce((sum, bin) => sum + bin.energy, 0);
  const candidates = bandContributions(bins).flatMap(band => {
    const sorted = [...band.bins].sort((a, b) => b.energy - a.energy);
    if (sorted.length < 3) return [];
    const [loudest, second] = sorted;
    const contrastDb = 10 * Math.log10(loudest.energy / second.energy);
    const share = loudest.energy / total;
    return contrastDb >= 6 && share >= 0.08 ? [{ frequency: loudest.frequency, level: 10 * Math.log10(loudest.energy), share, contrastDb, band: band.label }] : [];
  });
  return candidates.sort((a, b) => b.share - a.share)[0] || null;
}
