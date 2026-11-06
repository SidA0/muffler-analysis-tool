import test from 'node:test';
import assert from 'node:assert/strict';
import { bandContributions, standoutTone } from './bands.js';

test('band shares sum linear sound energy across 300 Hz brackets', () => {
  const bands = bandContributions([{ frequency: 100, energy: 10 }, { frequency: 200, energy: 10 }, { frequency: 300, energy: 5 }]);
  assert.equal(bands[0].label, '0–300 Hz');
  assert.equal(bands[0].share, 0.8);
  assert.equal(bands[1].label, '300–600 Hz');
});

test('tone flag needs a strong bin with both contrast and overall share', () => {
  const bins = [{ frequency: 100, energy: 100 }, { frequency: 150, energy: 10 }, { frequency: 200, energy: 5 }, { frequency: 400, energy: 10 }];
  assert.equal(standoutTone(bins).frequency, 100);
  assert.equal(standoutTone([{ frequency: 100, energy: 100 }, { frequency: 400, energy: 10 }]), null);
});
