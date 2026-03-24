import { clampBitrateIndex } from "../core/simulator.js";

export function createBufferBasedController({ thresholds }) {
  return {
    id: "buffer",
    selectBitrateIndex(context) {
      const bufferLevel = context.bufferSeconds;
      let index = 0;
      thresholds.forEach((threshold, thresholdIndex) => {
        if (bufferLevel >= threshold) {
          index = thresholdIndex + 1;
        }
      });
      return clampBitrateIndex(index, context.bitrateLadderMbps.length);
    },
  };
}
