import { parentPort } from 'node:worker_threads';
import { bundledDemand } from './demand.js';
import { bundledParkingRules, ParkingRules } from './parking-rules.js';
import { buildWindowSync, windowBuffers, type WindowRequest } from './sim-window.js';
import { encodeWindow, WindowStore, type WindowKeyInputs } from './window-store.js';

/**
 * Worker entry (§11.5): computes one window per message off the main thread and hands its
 * columns back by transfer, so serving requests never waits on a multi-day simulation. With a
 * window store it first tries the stored day (§22) and, after a build, returns the file bytes for
 * the main thread to write.
 */
let rules: ParkingRules | null = null;

parentPort?.on(
  'message',
  (message: {
    id: number;
    request: WindowRequest;
    store?: { directory: string; inputs: WindowKeyInputs };
  }) => {
    try {
      const logs: string[] = [];
      const store = message.store
        ? new WindowStore(message.store.directory, (line) => logs.push(line))
        : null;
      const stored = store?.readSync(message.store!.inputs) ?? null;
      if (stored) {
        parentPort!.postMessage(
          { id: message.id, data: stored, source: 'store', logs },
          windowBuffers(stored),
        );
        return;
      }
      const demand = bundledDemand();
      rules ??= new ParkingRules(bundledParkingRules(), demand);
      const started = performance.now();
      const data = buildWindowSync(message.request, demand, rules);
      const builtMs = Math.round(performance.now() - started);
      // Encoded before the transfer below detaches the columns; a failure only skips the store.
      let file: Uint8Array | undefined;
      if (message.store)
        try {
          file = encodeWindow(data, message.store.inputs, builtMs, Date.now());
        } catch (error) {
          logs.push(`simulation window store encode failed: ${(error as Error).name}`);
        }
      parentPort!.postMessage({ id: message.id, data, source: 'build', file, builtMs, logs }, [
        ...windowBuffers(data),
        ...(file ? [file.buffer as ArrayBuffer] : []),
      ]);
    } catch (error) {
      parentPort!.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
