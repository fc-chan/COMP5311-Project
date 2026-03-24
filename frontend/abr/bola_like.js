import { clampBitrateIndex } from "../core/simulator.js";

export function createBolaLikeController({
  reservoir = 2,
  cushion = 10,
  switchGuard = 0.08,
} = {}) {
  return {
    id: "bola",
    selectBitrateIndex(context) {
      const ladder = context.bitrateLadderMbps;
      const previousIndex = context.previousBitrateIndex ?? 0;
      const minBitrate = ladder[0];
      const maxBitrate = ladder[ladder.length - 1];
      const normalizedBuffer = Math.max(
        0,
        Math.min(1, (context.bufferSeconds - reservoir) / Math.max(1, cushion))
      );

      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;

      ladder.forEach((bitrate, index) => {
        const utility =
          Math.log(bitrate / minBitrate) / Math.log(maxBitrate / minBitrate);
        const score = 1 - Math.abs(normalizedBuffer - utility) - switchGuard * Math.abs(index - previousIndex);

        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });

      return clampBitrateIndex(bestIndex, ladder.length);
    },
  };
}
