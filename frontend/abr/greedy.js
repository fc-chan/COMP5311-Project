import { clampBitrateIndex } from "../core/simulator.js";

export function createGreedyController({ safetyFactor = 0.9 } = {}) {
  return {
    id: "greedy",
    selectBitrateIndex(context) {
      const safeCapacity = context.predictedThroughputMbps * safetyFactor;
      let candidateIndex = 0;
      context.bitrateLadderMbps.forEach((bitrate, index) => {
        if (bitrate <= safeCapacity) {
          candidateIndex = index;
        }
      });
      return clampBitrateIndex(candidateIndex, context.bitrateLadderMbps.length);
    },
  };
}
