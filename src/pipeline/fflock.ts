/** Serialize the CPU-relevant ffmpeg jobs (Gemini folds, consolidation,
 *  orphan rescue) so they never stack on top of each other. Cheap remuxes
 *  (seek-point rebuild) skip the queue on purpose. */
let chain: Promise<unknown> = Promise.resolve();

export function ffSerial<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => { /* keep the queue alive after failures */ });
  return next;
}
