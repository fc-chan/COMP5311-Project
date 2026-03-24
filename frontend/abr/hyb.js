import { clampBitrateIndex } from "../core/simulator.js";

export function createHybController({ safetyFactor = 0.92, bufferMargin = 0.25 } = {}) {
  return {
    id: "hyb",
    selectBitrateIndex(context) {
      let candidateIndex = 0;
      const safeThroughput = Math.max(0.35, context.predictedThroughputMbps * safetyFactor);
      const availableBuffer = Math.max(0.5, context.bufferSeconds + context.chunkDuration * bufferMargin);

      context.bitrateLadderMbps.forEach((bitrate, index) => {
        const downloadTime = (bitrate * context.chunkDuration) / safeThroughput;
        if (downloadTime <= availableBuffer) {
          candidateIndex = index;
        }
      });

      return clampBitrateIndex(candidateIndex, context.bitrateLadderMbps.length);
    },
  };
}
