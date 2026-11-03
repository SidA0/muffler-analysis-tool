import { optimizeSpectrum } from './optimizer.js';

let stopped = false;
self.onmessage = async event => {
  if (event.data?.type === 'stop') { stopped = true; return; }
  if (event.data?.type !== 'run') return;
  stopped = false;
  try {
    const result = await optimizeSpectrum(event.data.input, progress => self.postMessage({ type: 'progress', progress }), () => stopped);
    self.postMessage({ type: 'done', result });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
