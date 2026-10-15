/** Compose signals without requiring AbortSignal.any (Node 20.3+). Dispose at operation end. */
export function combineSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const dispose = () => { for (const remove of listeners) remove(); listeners.length = 0; };
  for (const signal of signals) {
    const abort = () => { controller.abort(signal.reason); dispose(); };
    if (signal.aborted) { abort(); break; }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", abort));
  }
  return { signal: controller.signal, dispose };
}
