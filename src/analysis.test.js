import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, cWeighting, recordsFromGrid } from './analysis.js';

test('C weighting is approximately flat at 1 kHz and attenuates low frequencies', () => {
  assert.ok(Math.abs(cWeighting(1000)) < 0.1);
  assert.ok(cWeighting(20) < -6);
});

test('equal independent bins add 3.01 dB and split energy equally', () => {
  const { points } = analyze([{ rpm: 1000, frequency: 1000, level: 60 }, { rpm: 1000, frequency: 2000, level: 60 }], 'c');
  assert.ok(Math.abs(points[0].level - 63.0103) < 0.001);
  assert.equal(points[0].contributors[0].share, 0.5);
});

test('repeated readings of one bin are averaged rather than counted twice', () => {
  const { points } = analyze([{ rpm: 1000, frequency: 1000, level: 60 }, { rpm: 1000, frequency: 1000, level: 60 }], 'c');
  assert.equal(points[0].level, 60);
});

test('wide frequency rows map RPM column headers to records', () => {
  const records = recordsFromGrid([['Hz', 1000, 2000], [100, 50, 55]], { layout: 'freqRows', headerRow: 0, firstColumn: 0 });
  assert.deepEqual(records, [{ frequency: 100, rpm: 1000, level: 50 }, { frequency: 100, rpm: 2000, level: 55 }]);
});
