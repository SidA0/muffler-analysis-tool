const K = Math.LN10 / 10;
const MAX_CUT = 60;
import { BAND_WIDTH_HZ, bandKey, bandLabel } from './bands.js';

export const RUN_MODES = {
  short: { sweeps: 8, iterations: 12, maxMs: 2000 },
  balanced: { sweeps: 16, iterations: 24, maxMs: 8000 },
  long: { sweeps: 26, iterations: 36, maxMs: 20000 }
};

export function groupKey(frequency, mode) {
  if (!RUN_MODES[mode]) throw new Error('Choose a valid run length.');
  return bandKey(frequency);
}

export function groupSpectrum(bins, mode = 'balanced') {
  if (!RUN_MODES[mode]) throw new Error('Choose a valid run length.');
  const groups = new Map();
  for (const bin of bins) {
    if (!(bin.frequency > 0) || !(bin.energy > 0)) continue;
    const key = groupKey(bin.frequency, mode);
    const existing = groups.get(key) || { key, minHz: bin.frequency, maxHz: bin.frequency, energy: 0, count: 0 };
    existing.minHz = Math.min(existing.minHz, bin.frequency);
    existing.maxHz = Math.max(existing.maxHz, bin.frequency);
    existing.energy += bin.energy;
    existing.count++;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => a.key - b.key).map(group => ({ ...group, centerHz: group.key * BAND_WIDTH_HZ + BAND_WIDTH_HZ / 2, label: bandLabel(group.key) }));
}

function ratioAt(groups, cuts, total) {
  let energy = 0;
  for (let i = 0; i < groups.length; i++) energy += groups[i].energy * Math.exp(-K * cuts[i]);
  return energy / total;
}

function solveAtLambda(groups, shares, lambda, cuts, sweeps, beta) {
  const n = cuts.length;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let largestChange = 0;
    for (let i = 0; i < n; i++) {
      const neighbors = (i > 0 ? 1 : 0) + (i + 1 < n ? 1 : 0);
      const nearby = (i > 0 ? cuts[i - 1] : 0) + (i + 1 < n ? cuts[i + 1] : 0);
      let low = 0, high = MAX_CUT;
      for (let j = 0; j < 20; j++) {
        const mid = (low + high) / 2;
        const derivative = mid + beta * (neighbors * mid - nearby) - lambda * K * shares[i] * Math.exp(-K * mid);
        if (derivative < 0) low = mid; else high = mid;
      }
      const next = (low + high) / 2;
      largestChange = Math.max(largestChange, Math.abs(next - cuts[i]));
      cuts[i] = next;
    }
    if (largestChange < 0.0001) break;
  }
  return cuts;
}

export async function optimizeSpectrum({ bins, targetDb, marginPercent, mode = 'balanced' }, onProgress = () => {}, isStopped = () => false) {
  if (!RUN_MODES[mode]) throw new Error('Choose a valid run length.');
  if (!Number.isFinite(targetDb)) throw new Error('Enter a valid target dBC.');
  if (!(marginPercent >= 5 && marginPercent <= 20)) throw new Error('The pressure margin must be between 5% and 20%.');
  const groups = groupSpectrum(bins, mode);
  if (!groups.length) throw new Error('At least one measured frequency is required.');
  const total = groups.reduce((sum, group) => sum + group.energy, 0);
  const baselineDb = 10 * Math.log10(total);
  const designTargetDb = targetDb + 20 * Math.log10(1 - marginPercent / 100);
  const requiredRatio = 10 ** ((designTargetDb - baselineDb) / 10);
  if (requiredRatio < 10 ** (-MAX_CUT / 10) - 1e-12) throw new Error(`This target needs more than the ${MAX_CUT} dB per-group limit. Raise the target or reduce the margin.`);
  const zero = Array(groups.length).fill(0);
  if (requiredRatio >= 1) return { mode, baselineDb, designTargetDb, achievedDb: baselineDb, groups: groups.map(group => ({ ...group, cutDb: 0, removedShare: 0 })), iterations: 0 };

  const settings = RUN_MODES[mode];
  const shares = groups.map(group => group.energy / total);
  const beta = mode === 'long' ? 0.08 : 0.18;
  const started = performance.now();
  const yieldStep = () => new Promise(resolve => setTimeout(resolve, 0));
  let lambda = 1, lowLambda = 0, highLambda = 0, cuts = zero.slice(), best = null, iterations = 0;

  for (let bracket = 0; bracket < 52; bracket++) {
    if (isStopped()) throw new Error('Optimization stopped.');
    cuts = solveAtLambda(groups, shares, lambda, cuts, settings.sweeps, beta);
    iterations++;
    const ratio = ratioAt(groups, cuts, total);
    onProgress({ percent: Math.min(35, 4 + bracket * 1.5), stage: 'Finding a feasible reduction', elapsedMs: performance.now() - started });
    await yieldStep();
    if (ratio <= requiredRatio) { highLambda = lambda; best = cuts.slice(); break; }
    lowLambda = lambda;
    lambda *= 2;
  }
  if (!best) throw new Error('The solver could not find a feasible cut within its 60 dB per-group limit.');

  for (let step = 0; step < settings.iterations; step++) {
    if (isStopped()) throw new Error('Optimization stopped.');
    if (performance.now() - started > settings.maxMs && step > 2) break;
    const mid = (lowLambda + highLambda) / 2;
    cuts = solveAtLambda(groups, shares, mid, cuts, settings.sweeps, beta);
    iterations++;
    const ratio = ratioAt(groups, cuts, total);
    if (ratio <= requiredRatio) { highLambda = mid; best = cuts.slice(); }
    else lowLambda = mid;
    onProgress({ percent: 35 + 60 * (step + 1) / settings.iterations, stage: 'Refining frequency cuts', elapsedMs: performance.now() - started });
    await yieldStep();
  }

  // Finish on the feasible side of the boundary despite finite iteration precision.
  let finalRatio = ratioAt(groups, best, total);
  if (finalRatio > requiredRatio) {
    const extra = 10 * Math.log10(finalRatio / requiredRatio);
    best = best.map(value => Math.min(MAX_CUT, value + extra + 0.0001));
    finalRatio = ratioAt(groups, best, total);
  }
  if (finalRatio > requiredRatio * 1.00001) throw new Error('The target could not be reached within the 60 dB per-group limit.');
  const achievedDb = baselineDb + 10 * Math.log10(finalRatio);
  onProgress({ percent: 100, stage: 'Complete', elapsedMs: performance.now() - started });
  return { mode, baselineDb, designTargetDb, achievedDb, iterations, groups: groups.map((group, i) => ({ ...group, cutDb: best[i], removedShare: group.energy * (1 - Math.exp(-K * best[i])) / total })) };
}
