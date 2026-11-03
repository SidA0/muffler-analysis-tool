import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analysis.js';
import { applyAttenuation, apdlPressureTable, attenuationAt, parseAttenuationRows, pressureSpectrum } from './attenuation.js';

test('attenuation interpolates in Hz and defaults to zero outside the curve', () => {
  const curve = parseAttenuationRows([['Hz', 'dB'], [100, 5], [300, 15]]);
  assert.equal(attenuationAt(200, curve), 10);
  assert.equal(attenuationAt(50, curve), 0);
  assert.equal(attenuationAt(50, curve, 'hold'), 5);
});

test('a 10 dB flat curve lowers the summed level by 10 dB', () => {
  const source = analyze([{ rpm: 1000, frequency: 100, level: 60 }, { rpm: 1000, frequency: 1000, level: 70 }], 'c');
  const result = applyAttenuation(source.points, [{ frequency: 100, db: 10 }, { frequency: 1000, db: 10 }]);
  assert.ok(Math.abs(result.points[0].before - result.points[0].after - 10) < 1e-9);
});

test('60 dB SPL gives 0.02 Pa RMS and a larger peak pressure', () => {
  const source = analyze([{ rpm: 1000, frequency: 1000, level: 60 }, { rpm: 1000, frequency: 2000, level: 50 }], 'z');
  const spectrum = pressureSpectrum(source.points[0], 'z');
  assert.ok(Math.abs(spectrum[0].rmsPa - 0.02) < 1e-12);
  assert.ok(Math.abs(spectrum[0].peakPa - Math.SQRT2 * 0.02) < 1e-12);
  const apdl = apdlPressureTable(spectrum, 'INLET');
  assert.match(apdl, /\*DIM,FFT_P,TABLE,2,1,1,FREQ/);
  assert.match(apdl, /D,ALL,PRES,%FFT_P%/);
  assert.match(apdl, /CMSEL,S,INLET,NODE/);
});
