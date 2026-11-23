/** Upper bound for any native collector command (pmset, ioreg, vm_stat). */
export const COLLECTOR_TIMEOUT_MS = 5_000;

/** execFile options: kill a stalled command so presence reporting keeps going. */
export const COLLECTOR_EXEC_OPTIONS = {
  timeout: COLLECTOR_TIMEOUT_MS,
  killSignal: "SIGKILL" as const,
};

/**
 * Resolve to `fallback` if `work` has not settled within `ms`. A last line of
 * defence on top of the per-command timeout: one stuck collector can never stop
 * a presence report from being sent.
 */
export function withFallback<T>(
  work: Promise<T>,
  fallback: T,
  ms = COLLECTOR_TIMEOUT_MS + 1_000,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
