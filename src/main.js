import * as XLSX from 'xlsx';
import { analyze, numeric, recordsFromGrid, smoothSurface, worstCaseSurface } from './analysis.js';
import { applyAttenuation, apdlPressureTable, attenuationAt, parseAttenuationRows, pressureSpectrum } from './attenuation.js';
import { groupKey } from './optimizer.js';
import { BAND_WIDTH_HZ, bandContributions, standoutTone } from './bands.js';
import './style.css';

const $ = id => document.getElementById(id);
const state = { workbook: null, rows: [], result: null, surface: null, selected: 0, chartPoints: [], curve: null, attenuated: null, optimizerWorker: null, optimization: null, optBaseCurve: null, optOutside: 'zero', optRpmIndex: 0, spectrumGeneration: 0 };
const fmt = (n, digits = 1) => Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function showError(message) { $('error').textContent = message; $('error').classList.remove('hidden'); }
function clearError() { $('error').classList.add('hidden'); }
function colName(index) { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function likelyIndex(header, patterns, fallback) {
  const found = header.findIndex(cell => patterns.some(pattern => pattern.test(String(cell ?? ''))));
  return found >= 0 ? found : fallback;
}
function selectOptions(header, chosen) {
  return header.map((value, index) => `<option value="${index}" ${index === chosen ? 'selected' : ''}>${colName(index)} · ${escapeHtml(String(value ?? '').slice(0, 45) || '(blank)')}</option>`).join('');
}
function loadSheet() {
  const sheet = state.workbook.Sheets[$('sheet').value];
  state.rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false });
  const candidates = state.rows.slice(0, 30).map((row, i) => ({ i, row, score: row.filter(v => v !== null && v !== '').length + row.reduce((s, v) => s + (/(rpm|frequency|freq|hz|spl|level|db)/i.test(String(v ?? '')) ? 3 : 0), 0) }));
  candidates.sort((a, b) => b.score - a.score);
  const preferred = candidates[0]?.i ?? 0;
  $('header-row').innerHTML = state.rows.slice(0, Math.min(30, state.rows.length)).map((row, i) => `<option value="${i}" ${i === preferred ? 'selected' : ''}>Row ${i + 1}: ${escapeHtml(row.slice(0, 4).join(' · ').slice(0, 75))}</option>`).join('');
  const header = state.rows[preferred] || [];
  const headerText = header.map(String).join(' ').toLowerCase();
  $('layout').value = /rpm|speed/.test(headerText) && /freq|hz/.test(headerText) && /level|spl|db/.test(headerText) ? 'long' : 'long';
  $('row-count').textContent = `${state.rows.length.toLocaleString()} rows`;
  updateMapping();
}
function updateMapping() {
  const rowIndex = Number($('header-row').value) || 0;
  const header = state.rows[rowIndex] || [];
  const count = Math.max(header.length, ...state.rows.slice(rowIndex + 1, rowIndex + 10).map(r => r.length), 3);
  const labels = Array.from({ length: count }, (_, i) => header[i]);
  const layout = $('layout').value;
  let controls;
  if (layout === 'long') {
    const r = likelyIndex(labels, [/rpm/i, /speed/i], 0);
    const f = likelyIndex(labels, [/freq/i, /hz/i], 1);
    const l = likelyIndex(labels, [/spl/i, /level/i, /db/i], 2);
    controls = [['rpm-column', 'RPM column', r], ['frequency-column', 'Frequency column', f], ['level-column', 'SPL column', l]];
    $('setup-hint').textContent = 'Each data row has one RPM, one frequency in Hz, and one sound level in dB.';
  } else {
    controls = [['first-column', layout === 'freqRows' ? 'Frequency column' : 'RPM column', 0]];
    $('setup-hint').textContent = layout === 'freqRows' ? 'The selected column contains Hz; numeric column headers contain RPM.' : 'The selected column contains RPM; numeric column headers contain Hz.';
  }
  $('column-controls').innerHTML = controls.map(([id, label, selected]) => `<label>${label}<select id="${id}">${selectOptions(labels, selected)}</select></label>`).join('');
}

async function loadFile(file) {
  if (!file) return;
  clearError();
  clearOptimization(); state.result = null; state.surface = null; state.attenuated = null; state.spectrumGeneration++;
  try {
    const buffer = await file.arrayBuffer();
    state.workbook = XLSX.read(buffer, { type: 'array' });
    if (!state.workbook.SheetNames.length) throw new Error('No worksheets were found.');
    $('sheet').innerHTML = state.workbook.SheetNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    $('file-details').innerHTML = `<span>▣</span><strong>${escapeHtml(file.name)}</strong><small>${(file.size / 1024).toFixed(1)} KB · ${state.workbook.SheetNames.length} sheet${state.workbook.SheetNames.length === 1 ? '' : 's'}</small>`;
    $('file-details').classList.remove('hidden'); $('mapping').classList.remove('hidden');
    $('results').classList.add('hidden'); loadSheet();
  } catch (error) { showError(`Could not open this file: ${error.message}`); }
}

function runAnalysis() {
  clearError();
  const layout = $('layout').value;
  const opts = { layout, headerRow: Number($('header-row').value), rpmColumn: Number($('rpm-column')?.value), frequencyColumn: Number($('frequency-column')?.value), levelColumn: Number($('level-column')?.value), firstColumn: Number($('first-column')?.value) };
  if (layout === 'long' && new Set([opts.rpmColumn, opts.frequencyColumn, opts.levelColumn]).size !== 3) { showError('Choose three different columns for RPM, frequency, and SPL.'); return; }
  const records = recordsFromGrid(state.rows, opts);
  const result = analyze(records, $('weighting').value);
  if (!result.points.length) { showError('No valid measurements were found. Check the layout, header row, columns, and whether RPM/frequency/level cells contain numbers.'); return; }
  state.result = result;
  state.surface = worstCaseSurface(records, $('weighting').value);
  state.attenuated = state.curve ? applyAttenuation(result.points, state.curve, $('outside').value) : null;
  const peak = result.points.reduce((a, b) => a.level > b.level ? a : b);
  $('rpm-points').textContent = result.points.length.toLocaleString();
  $('peak-level').textContent = `${fmt(peak.level)} dBC`;
  $('peak-rpm').textContent = fmt(peak.rpm, 0);
  $('freq-bins').textContent = Math.max(...result.points.map(p => p.bins)).toLocaleString();
  $('rpm-select').innerHTML = result.points.map((p, i) => `<option value="${i}">${fmt(p.rpm, 0)} RPM · ${fmt(p.level)} dBC</option>`).join('');
  $('ansys-rpm').innerHTML = result.points.map((p, i) => `<option value="${i}">${fmt(p.rpm, 0)} RPM</option>`).join('');
  $('opt-rpm').innerHTML = result.points.map((p, i) => `<option value="${i}">${fmt(p.rpm, 0)} RPM · ${fmt(p.level)} dBC</option>`).join('');
  state.selected = result.points.findIndex(p => p === peak);
  $('rpm-select').value = state.selected;
  $('ansys-rpm').value = state.selected;
  $('opt-rpm').value = state.selected;
  $('opt-target').value = Math.max(0, Math.floor(peak.level - 10));
  clearOptimization(); updateOptimizerNotes(); showResultTab('analysis');
  $('results').classList.remove('hidden');
  renderContributors(); renderAttenuation(); drawChart(); drawSpectrum3d();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderContributors() {
  const point = state.result.points[state.selected];
  $('selected-rpm').textContent = fmt(point.rpm, 0);
  $('selected-level').textContent = fmt(point.level);
  $('ansys-rpm').value = state.selected;
  $('opt-rpm').value = state.selected;
  $('contrib-subtitle').textContent = `Energy contribution at ${fmt(point.rpm, 0)} RPM.`;
  const top = bandContributions(point.contributors).slice(0, 8);
  $('contributors').innerHTML = top.map((item, i) => `<div class="contributor"><span class="rank">${String(i + 1).padStart(2, '0')}</span><strong>${item.label}</strong><div class="bar-track"><div class="bar" style="width:${Math.max(0.6, item.share * 100)}%"></div></div><span class="share">${fmt(item.share * 100)}%</span></div>`).join('');
  const topShare = top[0]?.share || 0;
  $('insight-text').textContent = top.length ? `${top[0].label} is the largest measured bracket here, accounting for ${fmt(topShare * 100)}% of the total sound energy.` : '';
  const tone = standoutTone(point.contributors);
  $('tone-alert').classList.toggle('hidden', !tone);
  $('tone-alert').textContent = tone ? `Standout tone: ${fmt(tone.frequency, tone.frequency < 100 ? 1 : 0)} Hz contributes ${fmt(tone.share * 100)}% of total energy and is ${fmt(tone.contrastDb)} dB above the next measured bin in ${tone.band}. This is a screening flag, not proof of the source.` : '';
  renderAttenuation();
  drawChart();
}

function renderAttenuation() {
  const has = !!state.attenuated;
  $('after-legend').classList.toggle('hidden', !has);
  $('export-attenuated').classList.toggle('hidden', !has);
  $('attenuation-table').classList.toggle('hidden', !has);
  if (!has) { $('after-level').textContent = '—'; $('reduction').textContent = '—'; return; }
  const point = state.attenuated.points[state.selected];
  $('after-level').textContent = fmt(point.after);
  $('reduction').textContent = fmt(point.before - point.after);
  const curve = state.curve;
  $('curve-note').textContent = `${curve.length} curve points from ${fmt(curve[0].frequency, 0)} to ${fmt(curve.at(-1).frequency, 0)} Hz. ${state.attenuated.outsideCount} FFT bin${state.attenuated.outsideCount === 1 ? '' : 's'} outside the curve range use ${$('outside').value === 'hold' ? 'the nearest endpoint' : '0 dB'} attenuation.`;
  $('attenuation-table').innerHTML = `<table><thead><tr><th>RPM</th><th>Original dBC</th><th>After attenuation dBC</th><th>Reduction dB</th></tr></thead><tbody>${state.attenuated.points.map(p => `<tr><td>${fmt(p.rpm, 0)}</td><td>${fmt(p.before)}</td><td>${fmt(p.after)}</td><td>${fmt(p.before - p.after)}</td></tr>`).join('')}</tbody></table>`;
}

function drawChart() {
  if (!state.result) return;
  const canvas = $('chart'), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, m = { left: 56, right: 25, top: 32, bottom: 40 };
  const pts = state.result.points, xs = pts.map(p => p.rpm), ys = pts.map(p => p.level).concat(state.attenuated?.points.map(p => p.after) || []);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.floor((Math.min(...ys) - 3) / 5) * 5, y1 = Math.ceil((Math.max(...ys) + 3) / 5) * 5;
  const sx = x => m.left + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (w - m.left - m.right);
  const sy = y => h - m.bottom - (y1 === y0 ? 0.5 : (y - y0) / (y1 - y0)) * (h - m.top - m.bottom);
  ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) { const y = y0 + (y1 - y0) * i / 4, py = sy(y); ctx.strokeStyle = '#e8edf0'; ctx.beginPath(); ctx.moveTo(m.left, py); ctx.lineTo(w - m.right, py); ctx.stroke(); ctx.fillStyle = '#71808b'; ctx.fillText(fmt(y, 0), m.left - 12, py + 4); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) { const x = x0 + (x1 - x0) * i / 4; ctx.fillStyle = '#71808b'; ctx.fillText(fmt(x, 0), sx(x), h - 12); }
  state.chartPoints = pts.map(p => ({ x: sx(p.rpm), y: sy(p.level) }));
  if (pts.length > 1) {
    const fill = ctx.createLinearGradient(0, m.top, 0, h - m.bottom); fill.addColorStop(0, 'rgba(31, 157, 151, .23)'); fill.addColorStop(1, 'rgba(31, 157, 151, 0)');
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(sx(p.rpm), sy(p.level)) : ctx.moveTo(sx(p.rpm), sy(p.level)));
    ctx.lineTo(sx(pts.at(-1).rpm), h - m.bottom); ctx.lineTo(sx(pts[0].rpm), h - m.bottom); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(sx(p.rpm), sy(p.level)) : ctx.moveTo(sx(p.rpm), sy(p.level)));
  ctx.strokeStyle = '#1f9d97'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
  if (state.attenuated) {
    ctx.beginPath(); state.attenuated.points.forEach((p, i) => i ? ctx.lineTo(sx(p.rpm), sy(p.after)) : ctx.moveTo(sx(p.rpm), sy(p.after)));
    ctx.strokeStyle = '#e58660'; ctx.lineWidth = 3; ctx.stroke();
    state.attenuated.points.forEach((p, i) => { ctx.beginPath(); ctx.arc(sx(p.rpm), sy(p.after), i === state.selected ? 6 : 3.5, 0, 2 * Math.PI); ctx.fillStyle = '#e58660'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); });
  }
  state.chartPoints.forEach((p, i) => { ctx.beginPath(); ctx.arc(p.x, p.y, i === state.selected ? 7 : 4, 0, 2 * Math.PI); ctx.fillStyle = i === state.selected ? '#ee8159' : '#1f9d97'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); });
  ctx.save(); ctx.translate(15, h / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = '#75838d'; ctx.textAlign = 'center'; ctx.font = '700 10px Inter, system-ui, sans-serif'; ctx.fillText('dBC', 0, 0); ctx.restore();
}

async function drawSpectrum3d() {
  if (!state.surface) return;
  const generation = ++state.spectrumGeneration;
  const plot = $('spectrum-3d');
  const { x, y, z: measuredZ, measured } = state.surface;
  const strength = $('surface-smoothing').value;
  const z = smoothSurface(measuredZ, strength);
  const smoothed = strength !== 'off';
  plot.setAttribute('aria-label', `Interactive 3D ${smoothed ? `${strength} smoothed display of` : 'top surface of'} highest measured C weighted dBC at each RPM and frequency`);
  $('spectrum-3d-note').textContent = `Top surface from ${measured.toLocaleString()} RPM–frequency coordinates. ${smoothed ? 'Smoothing changes only the displayed height and color; hover shows the measured worst case too. ' : 'Height and color show the highest measured C weighted dBC. '}Empty coordinates remain gaps. The RPM total below uses the energy sum of its bins.`;
  plot.textContent = 'Preparing interactive 3D graph…';
  try {
    const module = await import('plotly.js-gl3d-dist-min');
    if (generation !== state.spectrumGeneration) return;
    const Plotly = module.default || module;
    plot.textContent = '';
    await Plotly.newPlot(plot, [{ type: 'surface', x, y, z, surfacecolor: z, customdata: measuredZ, connectgaps: false, colorscale: 'Turbo', colorbar: { title: { text: 'Displayed dBC' }, thickness: 14, len: 0.7 }, hovertemplate: `%{x:,.0f} RPM<br>%{y:,.1f} Hz<br>${smoothed ? 'Displayed: %{z:.1f} dBC<br>' : ''}Worst measured: %{customdata:.1f} dBC<extra></extra>` }], { margin: { l: 0, r: 0, t: 8, b: 0 }, paper_bgcolor: '#fff', scene: { xaxis: { title: { text: 'RPM' } }, yaxis: { title: { text: 'Frequency (Hz)' } }, zaxis: { title: { text: 'Bin dBC' } }, aspectmode: 'cube' }, font: { family: 'DM Sans, sans-serif', color: '#425961' } }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'] });
  } catch (error) { plot.textContent = `3D graph could not load: ${error.message}`; }
}

function exportCsv() {
  if (!state.result) return;
  const lines = ['RPM,Total dBC,Range start Hz,Range end Hz,Range dBC,Energy contribution percent,Standout tone Hz,Standout tone energy percent'];
  for (const point of state.result.points) {
    const tone = standoutTone(point.contributors);
    for (const band of bandContributions(point.contributors)) lines.push([point.rpm, point.level.toFixed(4), band.key * BAND_WIDTH_HZ, (band.key + 1) * BAND_WIDTH_HZ, band.level.toFixed(4), (band.share * 100).toFixed(4), tone?.band === band.label ? tone.frequency : '', tone?.band === band.label ? (tone.share * 100).toFixed(4) : ''].join(','));
  }
  download('rpm_sound_analysis.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCurveText(text) {
  return parseAttenuationRows(text.split(/\r?\n/).map(line => line.trim().split(/[\t,; ]+/)));
}

function applyCurve() {
  $('curve-error').classList.add('hidden');
  try {
    const curve = parseCurveText($('curve-text').value);
    state.curve = curve;
    if (state.result) state.attenuated = applyAttenuation(state.result.points, curve, $('outside').value);
    renderAttenuation(); drawChart();
    clearOptimization(); updateOptimizerNotes();
  } catch (error) { $('curve-error').textContent = error.message; $('curve-error').classList.remove('hidden'); }
}

async function importCurveFile(file) {
  if (!file) return;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, raw: true });
    const curve = parseAttenuationRows(rows);
    $('curve-text').value = ['Frequency Hz,Attenuation dB', ...curve.map(p => `${p.frequency},${p.db}`)].join('\n');
    applyCurve();
  } catch (error) { $('curve-error').textContent = `Could not read curve: ${error.message}`; $('curve-error').classList.remove('hidden'); }
}

function exportAttenuated() {
  if (!state.attenuated) return;
  const lines = ['RPM,Original dBC,After attenuation dBC,Reduction dB'];
  state.attenuated.points.forEach(p => lines.push([p.rpm, p.before.toFixed(4), p.after.toFixed(4), (p.before - p.after).toFixed(4)].join(',')));
  download('rpm_before_after_attenuation.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function getAnsysSpectrum() {
  if (!state.result) throw new Error('Analyze an FFT workbook first.');
  return pressureSpectrum(state.result.points[Number($('ansys-rpm').value)], $('weighting').value);
}

function withAnsysError(action) {
  $('ansys-error').classList.add('hidden');
  try { action(); } catch (error) { $('ansys-error').textContent = error.message; $('ansys-error').classList.remove('hidden'); }
}

function exportAnsysCsv() { withAnsysError(() => {
  const spectrum = getAnsysSpectrum();
  const lines = ['Frequency Hz,Unweighted SPL dB,Pressure RMS Pa,Pressure peak Pa'];
  spectrum.forEach(p => lines.push([p.frequency, p.spl.toFixed(5), p.rmsPa.toExponential(9), p.peakPa.toExponential(9)].join(',')));
  download(`ansys_pressure_${state.result.points[Number($('ansys-rpm').value)].rpm}rpm.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}); }

function exportAnsysApdl() { withAnsysError(() => {
  const script = apdlPressureTable(getAnsysSpectrum(), $('ansys-component').value.trim());
  download(`ansys_pressure_${state.result.points[Number($('ansys-rpm').value)].rpm}rpm.inp`, script, 'text/plain;charset=utf-8');
}); }

function showResultTab(name) {
  const analysis = name === 'analysis';
  $('analysis-panel').classList.toggle('hidden', !analysis);
  $('optimizer-panel').classList.toggle('hidden', analysis);
  for (const [id, active] of [['analysis-tab', analysis], ['optimize-tab', !analysis]]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-selected', String(active));
  }
  if (analysis) requestAnimationFrame(drawChart);
}

function clearOptimization() {
  if (state.optimizerWorker) { state.optimizerWorker.terminate(); state.optimizerWorker = null; }
  state.optimization = null;
  $('opt-output').classList.add('hidden');
  $('opt-progress-card').classList.add('hidden');
  $('opt-run').disabled = false;
}

function updateOptimizerNotes() {
  if (!state.result) return;
  const hasCurve = !!state.curve;
  $('opt-use-curve').disabled = !hasCurve;
  $('opt-margin-value').textContent = `${$('opt-margin').value}%`;
  const useCurve = hasCurve && $('opt-use-curve').checked;
  const index = Number($('opt-rpm').value) || 0;
  const baseline = useCurve ? state.attenuated.points[index].after : state.result.points[index].level;
  $('opt-baseline-note').textContent = hasCurve
    ? (useCurve ? `Starting from the applied curve: ${fmt(baseline)} dBC at this RPM. The solver recommends additional cuts.` : `Starting from the original spectrum: ${fmt(baseline)} dBC at this RPM. The applied curve is ignored.`)
    : `Starting from the original spectrum: ${fmt(baseline)} dBC at this RPM.`;
  const target = Number($('opt-target').value), margin = Number($('opt-margin').value);
  const design = target + 20 * Math.log10(1 - margin / 100);
  $('opt-target-note').textContent = Number.isFinite(design) && $('opt-target').value !== ''
    ? `Design target ${fmt(design)} dBC · ${baseline > design ? `${fmt(baseline - design)} dB below the starting level` : 'already met'}`
    : 'Enter a target level.';
}

function stopOptimizer() {
  if (state.optimizerWorker) { state.optimizerWorker.terminate(); state.optimizerWorker = null; }
  $('opt-progress-title').textContent = 'Optimization stopped';
  $('opt-progress-detail').textContent = 'Change the settings and run it again.';
  $('opt-stop').classList.add('hidden');
  $('opt-run').disabled = false;
}

function runOptimizer() {
  $('opt-error').classList.add('hidden');
  if (!state.result) { $('opt-error').textContent = 'Analyze an FFT workbook first.'; $('opt-error').classList.remove('hidden'); return; }
  const rpmIndex = Number($('opt-rpm').value), targetDb = Number($('opt-target').value), marginPercent = Number($('opt-margin').value), mode = $('opt-duration').value;
  if ($('opt-target').value === '' || !Number.isFinite(targetDb) || targetDb < 0 || targetDb > 250) { $('opt-error').textContent = 'Enter a target between 0 and 250 dBC.'; $('opt-error').classList.remove('hidden'); return; }
  clearOptimization();
  const useCurve = !!state.curve && $('opt-use-curve').checked;
  state.optBaseCurve = useCurve ? state.curve.map(point => ({ ...point })) : null;
  state.optOutside = $('outside').value;
  state.optRpmIndex = rpmIndex;
  const bins = state.result.points[rpmIndex].contributors.map(bin => ({ frequency: bin.frequency, energy: bin.energy * 10 ** (-(useCurve ? attenuationAt(bin.frequency, state.optBaseCurve, state.optOutside) : 0) / 10) }));
  $('opt-progress-card').classList.remove('hidden');
  $('opt-progress-title').textContent = 'Optimizing frequency cuts…';
  $('opt-progress-detail').textContent = 'Preparing frequency groups';
  $('opt-progress').value = 0;
  $('opt-progress-percent').textContent = '0%';
  $('opt-elapsed').textContent = '0.0 s elapsed';
  $('opt-stop').classList.remove('hidden');
  $('opt-run').disabled = true;
  const worker = new Worker(new URL('./optimizer-worker.js', import.meta.url), { type: 'module' });
  state.optimizerWorker = worker;
  worker.onmessage = event => {
    if (worker !== state.optimizerWorker) return;
    const { type, progress, result, message } = event.data;
    if (type === 'progress') {
      $('opt-progress').value = progress.percent;
      $('opt-progress-percent').textContent = `${Math.round(progress.percent)}%`;
      $('opt-progress-detail').textContent = progress.stage;
      $('opt-elapsed').textContent = `${fmt(progress.elapsedMs / 1000)} s elapsed`;
    } else if (type === 'done') {
      state.optimization = result;
      worker.terminate(); state.optimizerWorker = null;
      $('opt-run').disabled = false; $('opt-stop').classList.add('hidden');
      $('opt-progress-title').textContent = 'Optimization complete';
      $('opt-progress-detail').textContent = `${result.iterations} iterative updates · ${result.groups.length} frequency groups`;
      $('opt-progress').value = 100; $('opt-progress-percent').textContent = '100%';
      renderOptimizerOutput();
    } else if (type === 'error') {
      worker.terminate(); state.optimizerWorker = null;
      $('opt-run').disabled = false; $('opt-progress-card').classList.add('hidden');
      $('opt-error').textContent = message; $('opt-error').classList.remove('hidden');
    }
  };
  worker.onerror = error => { if (worker !== state.optimizerWorker) return; worker.terminate(); state.optimizerWorker = null; $('opt-run').disabled = false; $('opt-progress-card').classList.add('hidden'); $('opt-error').textContent = `Optimizer failed: ${error.message}`; $('opt-error').classList.remove('hidden'); };
  worker.postMessage({ type: 'run', input: { bins, targetDb, marginPercent, mode } });
}

function renderOptimizerOutput() {
  const result = state.optimization, rpm = state.result.points[state.optRpmIndex].rpm;
  $('opt-output').classList.remove('hidden');
  $('opt-start-level').textContent = `${fmt(result.baselineDb)} dBC`;
  $('opt-design-target').textContent = `${fmt(result.designTargetDb)} dBC`;
  $('opt-achieved').textContent = `${fmt(result.achievedDb)} dBC`;
  $('opt-band-count').textContent = result.groups.length.toLocaleString();
  $('opt-result-note').textContent = `At ${fmt(rpm, 0)} RPM, ${fmt(result.baselineDb - result.achievedDb)} dB of additional reduction is predicted.${result.iterations ? '' : ' The target is already met.'}`;
  const sourceBins = state.result.points[state.optRpmIndex].contributors.map(bin => ({ frequency: bin.frequency, energy: bin.energy * 10 ** (-(state.optBaseCurve ? attenuationAt(bin.frequency, state.optBaseCurve, state.optOutside) : 0) / 10) }));
  const tone = standoutTone(sourceBins);
  $('opt-tone-alert').classList.toggle('hidden', !tone);
  $('opt-tone-alert').textContent = tone ? `Standout tone at ${fmt(tone.frequency, tone.frequency < 100 ? 1 : 0)} Hz (${fmt(tone.share * 100)}% of starting energy, ${fmt(tone.contrastDb)} dB above the next bin in its bracket). The recommended cut applies to its whole 300 Hz bracket.` : '';
  const ranked = [...result.groups].filter(group => group.cutDb >= 0.05).sort((a, b) => b.removedShare - a.removedShare);
  $('opt-table-note').textContent = ranked.length ? `Showing the ${Math.min(25, ranked.length)} groups removing the most starting sound energy. Export for every group.` : 'No additional frequency cuts are needed.';
  $('opt-table').innerHTML = `<table><thead><tr><th>Frequency bracket</th><th>Measured bins</th><th>Extra cut</th><th>Energy removed</th></tr></thead><tbody>${ranked.slice(0, 25).map(group => `<tr><td>${group.label}</td><td>${group.count}</td><td>${fmt(group.cutDb)} dB</td><td>${fmt(group.removedShare * 100)}%</td></tr>`).join('')}</tbody></table>`;
}

function exportOptimization() {
  if (!state.optimization) return;
  const lines = ['RPM,Bracket start Hz,Bracket end Hz,Measured bin count,Additional attenuation dB,Starting energy removed percent'];
  const rpm = state.result.points[state.optRpmIndex].rpm;
  state.optimization.groups.forEach(group => lines.push([rpm, group.key * BAND_WIDTH_HZ, (group.key + 1) * BAND_WIDTH_HZ, group.count, group.cutDb.toFixed(4), (group.removedShare * 100).toFixed(4)].join(',')));
  download(`optimized_frequency_cuts_${rpm}rpm.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function applyOptimization() {
  if (!state.optimization) return;
  const cuts = new Map(state.optimization.groups.map(group => [group.key, group.cutDb]));
  const frequencies = [...new Set(state.result.points.flatMap(point => point.contributors.map(bin => bin.frequency)))].sort((a, b) => a - b);
  const curve = frequencies.map(frequency => {
    const base = state.optBaseCurve ? attenuationAt(frequency, state.optBaseCurve, state.optOutside) : 0;
    return { frequency, db: base + (cuts.get(groupKey(frequency, state.optimization.mode)) || 0) };
  });
  $('curve-text').value = ['Frequency Hz,Attenuation dB', ...curve.map(point => `${point.frequency},${point.db.toFixed(4)}`)].join('\n');
  $('outside').value = 'zero';
  applyCurve();
  showResultTab('analysis');
  $('attenuation-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('file').addEventListener('change', event => loadFile(event.target.files[0]));
const drop = $('dropzone');
['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
drop.addEventListener('drop', event => loadFile(event.dataTransfer.files[0]));
$('sheet').addEventListener('change', loadSheet);
$('layout').addEventListener('change', updateMapping);
$('header-row').addEventListener('change', updateMapping);
$('analyze').addEventListener('click', runAnalysis);
$('surface-smoothing').addEventListener('change', drawSpectrum3d);
$('rpm-select').addEventListener('change', event => { state.selected = Number(event.target.value); renderContributors(); });
$('export').addEventListener('click', exportCsv);
$('curve-file').addEventListener('change', event => importCurveFile(event.target.files[0]));
$('apply-curve').addEventListener('click', applyCurve);
$('outside').addEventListener('change', () => { if (state.curve) applyCurve(); });
$('export-attenuated').addEventListener('click', exportAttenuated);
$('export-ansys-csv').addEventListener('click', exportAnsysCsv);
$('export-ansys-apdl').addEventListener('click', exportAnsysApdl);
$('analysis-tab').addEventListener('click', () => showResultTab('analysis'));
$('optimize-tab').addEventListener('click', () => { updateOptimizerNotes(); showResultTab('optimize'); });
const changedOptimizerInput = () => { clearOptimization(); updateOptimizerNotes(); };
$('opt-rpm').addEventListener('change', changedOptimizerInput);
$('opt-target').addEventListener('input', changedOptimizerInput);
$('opt-margin').addEventListener('input', changedOptimizerInput);
$('opt-use-curve').addEventListener('change', changedOptimizerInput);
$('opt-duration').addEventListener('change', changedOptimizerInput);
$('opt-run').addEventListener('click', runOptimizer);
$('opt-stop').addEventListener('click', stopOptimizer);
$('opt-export').addEventListener('click', exportOptimization);
$('opt-apply').addEventListener('click', applyOptimization);
window.addEventListener('resize', drawChart);
$('chart').addEventListener('click', event => { const rect = event.target.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top; let closest = -1, distance = 20; state.chartPoints.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < distance) { distance = d; closest = i; } }); if (closest >= 0) { state.selected = closest; $('rpm-select').value = closest; renderContributors(); } });
