import type { TransformOptions } from './transform.js';
import type { TrajectoryObservation } from './trajectory.js';

/**
 * A repeat-retrieval circuit breaker is deliberately stronger than the normal
 * semantic classifier. Once the session exhibits a likely rediscovery loop after
 * image exposure, PXPipe stops changing modality for that session. Routing,
 * authentication, streaming and telemetry continue normally.
 */
export function applyTrajectoryCircuitBreaker(
  options: TransformOptions | undefined,
  observation: TrajectoryObservation | undefined,
): TransformOptions {
  const base = options ?? {};
  if (!observation?.breakerActive) return base;
  return {
    ...base,
    compress: false,
    compressTools: false,
    compressToolResults: false,
    collapseHistory: false,
  };
}
