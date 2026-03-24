import { clampBitrateIndex } from "../core/simulator.js";

export const DEFAULT_SODA_OPTIONS = {
  horizon: 5,
  targetBuffer: 10,
  bufferWeight: 0.16,
  switchWeight: 5.0,
  lowBufferWeight: 6.0,
  highBufferWeight: 0.08,
  usePredictionCeiling: true,
};

function getPredictionCeilingIndex(ladder, predictedThroughputMbps, enabled) {
  if (!enabled) {
    return ladder.length - 1;
  }

  const firstAtLeast = ladder.findIndex((bitrate) => bitrate >= predictedThroughputMbps);
  return firstAtLeast === -1 ? ladder.length - 1 : firstAtLeast;
}

function getSafeFallbackIndex(context, ceilingIndex) {
  const safeThroughput = Math.max(0.35, context.predictedThroughputMbps * 0.88);
  let fallbackIndex = 0;

  context.bitrateLadderMbps.forEach((bitrate, index) => {
    if (index <= ceilingIndex && bitrate <= safeThroughput) {
      fallbackIndex = index;
    }
  });

  return fallbackIndex;
}

function buildPlanner(context, options) {
  const settings = { ...DEFAULT_SODA_OPTIONS, ...options };
  const ladder = context.bitrateLadderMbps;
  const maxBitrate = ladder[ladder.length - 1];
  const horizonPredictions = Array.from({ length: settings.horizon }, (_, step) =>
    Math.max(0.35, context.predictedHorizonMbps[step] ?? context.predictedThroughputMbps)
  );
  const ceilingIndex = getPredictionCeilingIndex(
    ladder,
    context.predictedThroughputMbps,
    settings.usePredictionCeiling
  );

  function bufferPenalty(nextBuffer) {
    if (nextBuffer <= settings.targetBuffer) {
      return 0.5 * settings.lowBufferWeight * (settings.targetBuffer - nextBuffer) ** 2;
    }
    return 0.5 * settings.highBufferWeight * (nextBuffer - settings.targetBuffer) ** 2;
  }

  function advanceState(state, bitrateIndex, step) {
    if (step === 0 && bitrateIndex > ceilingIndex) {
      return null;
    }

    const bitrate = ladder[bitrateIndex];
    const throughput = horizonPredictions[step];
    const nextBuffer =
      state.bufferSeconds + (throughput * context.chunkDuration) / bitrate - context.chunkDuration;

    if (nextBuffer < 0 || nextBuffer > context.maxBuffer) {
      return null;
    }

    const distortionCost = (throughput * context.chunkDuration) / (bitrate * bitrate);
    const switchCost = ((bitrate - ladder[state.previousIndex]) / maxBitrate) ** 2;

    return {
      bufferSeconds: nextBuffer,
      previousIndex: bitrateIndex,
      totalCost:
        state.totalCost +
        distortionCost +
        settings.bufferWeight * bufferPenalty(nextBuffer) +
        settings.switchWeight * switchCost,
    };
  }

  return {
    settings,
    ladder,
    ceilingIndex,
    advanceState,
    fallbackIndex: getSafeFallbackIndex(context, ceilingIndex),
    initialState: {
      bufferSeconds: context.bufferSeconds,
      previousIndex: context.previousBitrateIndex ?? 0,
      totalCost: 0,
    },
  };
}

function solveWithMonotonicSearch(context, options) {
  const planner = buildPlanner(context, options);
  let bestIndex = planner.fallbackIndex;
  let bestCost = Number.POSITIVE_INFINITY;
  let evaluatedTrajectories = 0;

  function commit(sequence, state) {
    evaluatedTrajectories += 1;
    if (state.totalCost < bestCost) {
      bestCost = state.totalCost;
      bestIndex = sequence[0];
    }
  }

  function searchUp(sequence, startIndex, step, state) {
    if (step === planner.settings.horizon) {
      commit(sequence, state);
      return;
    }

    for (let bitrateIndex = startIndex; bitrateIndex <= planner.ceilingIndex; bitrateIndex += 1) {
      const nextState = planner.advanceState(state, bitrateIndex, step);
      if (!nextState) {
        continue;
      }
      searchUp([...sequence, bitrateIndex], bitrateIndex, step + 1, nextState);
    }
  }

  function searchDown(sequence, startIndex, step, state) {
    if (step === planner.settings.horizon) {
      commit(sequence, state);
      return;
    }

    for (let bitrateIndex = startIndex; bitrateIndex >= 0; bitrateIndex -= 1) {
      const nextState = planner.advanceState(state, bitrateIndex, step);
      if (!nextState) {
        continue;
      }
      searchDown([...sequence, bitrateIndex], bitrateIndex, step + 1, nextState);
    }
  }

  for (let startIndex = 0; startIndex <= planner.ceilingIndex; startIndex += 1) {
    const upState = planner.advanceState(planner.initialState, startIndex, 0);
    if (upState) {
      searchUp([startIndex], startIndex, 1, upState);
    }

    const downState = planner.advanceState(planner.initialState, startIndex, 0);
    if (downState) {
      searchDown([startIndex], startIndex, 1, downState);
    }
  }

  return {
    bitrateIndex: clampBitrateIndex(bestIndex, planner.ladder.length),
    objectiveCost: bestCost,
    evaluatedTrajectories,
  };
}

function solveExactly(context, options) {
  const planner = buildPlanner(context, options);
  let bestIndex = planner.fallbackIndex;
  let bestCost = Number.POSITIVE_INFINITY;
  let evaluatedTrajectories = 0;

  function search(sequence, step, state) {
    if (step === planner.settings.horizon) {
      evaluatedTrajectories += 1;
      if (state.totalCost < bestCost) {
        bestCost = state.totalCost;
        bestIndex = sequence[0];
      }
      return;
    }

    for (let bitrateIndex = 0; bitrateIndex < planner.ladder.length; bitrateIndex += 1) {
      const nextState = planner.advanceState(state, bitrateIndex, step);
      if (!nextState) {
        continue;
      }
      search([...sequence, bitrateIndex], step + 1, nextState);
    }
  }

  search([], 0, planner.initialState);

  return {
    bitrateIndex: clampBitrateIndex(bestIndex, planner.ladder.length),
    objectiveCost: bestCost,
    evaluatedTrajectories,
  };
}

export function solveSodaDecision(context, options = {}) {
  return solveWithMonotonicSearch(context, options);
}

export function solveSodaDecisionExact(context, options = {}) {
  return solveExactly(context, options);
}

export function createSodaController(options = {}) {
  return {
    id: "soda",
    selectBitrateIndex(context) {
      return solveSodaDecision(context, options).bitrateIndex;
    },
  };
}

export function createExactSodaController(options = {}) {
  return {
    id: "soda-exact",
    selectBitrateIndex(context) {
      return solveSodaDecisionExact(context, options).bitrateIndex;
    },
  };
}
