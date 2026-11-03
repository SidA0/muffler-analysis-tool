import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSpectrum, optimizeSpectrum } from './optimizer.js';

test('frequency grouping gets more detailed with longer runs', () => {
  const bins = [100, 125, 160, 200, 250, 315, 400].map(frequency => ({ frequency, energy: 1 }));
  assert.ok(groupSpectrum(bins, 'short').length < groupSpectrum(bins, 'balanced').length);
  assert.equal(groupSpectrum(bins, 'long').length, bins.length);
});

test('solver reaches a target and favors the louder frequency group', async () => {
  const bins = [
    { frequency: 100, energy: 1e12 }, { frequency: 200, energy: 1e11 },
    { frequency: 400, energy: 1e10 }, { frequency: 800, energy: 1e9 }
  ];
  const result = await optimizeSpectrum({ bins, targetDb: 110, marginPercent: 10, mode: 'short' });
  assert.ok(result.achievedDb <= result.designTargetDb + 0.001);
  assert.ok(result.groups[0].cutDb > result.groups.at(-1).cutDb);
  assert.ok(result.groups.every(group => group.cutDb >= 0 && group.cutDb <= 60));
});

test('a target already met needs no extra attenuation', async () => {
  const bins = [{ frequency: 100, energy: 1e6 }, { frequency: 1000, energy: 1e6 }];
  const result = await optimizeSpectrum({ bins, targetDb: 100, marginPercent: 5, mode: 'balanced' });
  assert.ok(result.groups.every(group => group.cutDb === 0));
});
