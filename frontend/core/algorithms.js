import { createSodaController, createExactSodaController, DEFAULT_SODA_OPTIONS } from "../abr/soda.js";
import { createGreedyController } from "../abr/greedy.js";
import { createHybController } from "../abr/hyb.js";
import { createBolaLikeController } from "../abr/bola_like.js";

export const SODA_REPRODUCTION_OPTIONS = {
  ...DEFAULT_SODA_OPTIONS,
};

export const ABR_ALGORITHMS = {
  soda: {
    label: "SODA (paper reproduction)",
    description:
      "Time-based horizon planning with moving-average throughput prediction, buffer stabilization, switching cost, and the monotonic-search approximation described in the paper.",
    factory: () => createSodaController(SODA_REPRODUCTION_OPTIONS),
  },
  hyb: {
    label: "HYB-like Throughput Baseline",
    description:
      "A throughput-driven baseline that chooses the highest bitrate predicted to finish without rebuffering.",
    factory: () => createHybController({ safetyFactor: 0.92, bufferMargin: 0.25 }),
  },
  bola: {
    label: "BOLA-like Buffer Baseline",
    description:
      "A buffer-occupancy baseline that maps safe buffer regions to higher quality while discouraging unnecessary switches.",
    factory: () => createBolaLikeController({ reservoir: 2, cushion: 10, switchGuard: 0.08 }),
  },
  greedy: {
    label: "Greedy Throughput Baseline",
    description:
      "A simple safety-margin baseline that always chases the highest bitrate under predicted throughput.",
    factory: () => createGreedyController({ safetyFactor: 0.88 }),
  },
};

export function listAbrAlgorithms() {
  return Object.entries(ABR_ALGORITHMS).map(([id, spec]) => ({
    id,
    ...spec,
  }));
}

export function createAbrController(algorithmId) {
  return ABR_ALGORITHMS[algorithmId].factory();
}

export function createExactSodaReference() {
  return createExactSodaController(SODA_REPRODUCTION_OPTIONS);
}
