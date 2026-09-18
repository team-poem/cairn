// Run the existing real-browser fixture and measure each successful perception-to-click cycle.
// Build first. Optional arguments match test-document-refs.mjs: runtime module, MCP entry.
import { pathToFileURL } from 'node:url';
const runtime = process.argv[2] ? pathToFileURL(process.argv[2]) : new URL('../packages/harness/dist/index.js', import.meta.url);
const { ChromeDevToolsDriver } = await import(runtime.href);
const prototype = ChromeDevToolsDriver.prototype;
const original = { call: prototype.call, snapshot: prototype.snapshot, click: prototype.click };
const pending = new WeakMap();
const measurements = [];
prototype.call = async function(name, ...args) {
  const measurement = pending.get(this);
  if (measurement) measurement.calls[name] = (measurement.calls[name] ?? 0) + 1;
  return original.call.call(this, name, ...args);
};
prototype.snapshot = async function(options) {
  if (options?.perception) pending.set(this, { start: performance.now(), calls: {} });
  return original.snapshot.call(this, options);
};
prototype.click = async function(target, ref) {
  const measurement = pending.get(this);
  const result = await original.click.call(this, target, ref);
  if (ref && measurement) {
    measurements.push({ target, elapsedMs: performance.now() - measurement.start,
      calls: Object.values(measurement.calls).reduce((sum, count) => sum + count, 0), tools: measurement.calls });
    pending.delete(this);
  }
  return result;
};
try {
  await import(new URL('./test-document-refs.mjs', import.meta.url));
  console.log(JSON.stringify({ measurements }, null, 2));
} finally {
  Object.assign(prototype, original);
}
