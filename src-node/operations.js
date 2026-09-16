// Stop waiting promptly; cooperative operations receive the same signal to stop work.
export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Operation cancelled."));
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
    if (signal.aborted) { cleanup(); abort(); }
  });
}
