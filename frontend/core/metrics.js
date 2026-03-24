export const PAPER_QOE_WEIGHTS = {
  rebuffer: 10,
  switching: 1,
};

function normalizedUtilityForBitrate(bitrateMbps, bitrateLadderMbps) {
  const minBitrate = bitrateLadderMbps[0];
  const maxBitrate = bitrateLadderMbps[bitrateLadderMbps.length - 1];

  if (bitrateMbps <= minBitrate) {
    return 0;
  }

  return Math.log(bitrateMbps / minBitrate) / Math.log(maxBitrate / minBitrate);
}

export function summarizeRecords({
  records,
  traceId,
  algorithmId,
  chunkDuration,
  bitrateLadderMbps,
  qoeWeights = PAPER_QOE_WEIGHTS,
  totalChunks,
}) {
  const totalStallSeconds = records.reduce((acc, item) => acc + item.stallSeconds, 0);
  const averageBitrate =
    records.length === 0
      ? 0
      : records.reduce((acc, item) => acc + item.selectedBitrateMbps, 0) / records.length;
  const averageThroughput =
    records.length === 0
      ? 0
      : records.reduce((acc, item) => acc + item.actualThroughputMbps, 0) / records.length;
  const averageBuffer =
    records.length === 0
      ? 0
      : records.reduce((acc, item) => acc + item.bufferAfterSeconds, 0) / records.length;
  const switchCount = records.reduce((acc, item, index) => {
    if (index === 0) {
      return 0;
    }
    return acc + Number(item.selectedBitrateIndex !== records[index - 1].selectedBitrateIndex);
  }, 0);
  const meanUtility =
    records.length === 0
      ? 0
      : records.reduce(
          (acc, item) =>
            acc + normalizedUtilityForBitrate(item.selectedBitrateMbps, bitrateLadderMbps),
          0
        ) / records.length;
  const playbackDurationSeconds = records.length * chunkDuration;
  const rebufferRatio =
    playbackDurationSeconds === 0 ? 0 : totalStallSeconds / playbackDurationSeconds;
  const switchingRate = switchCount / Math.max(records.length - 1, 1);
  const qoe = meanUtility - qoeWeights.rebuffer * rebufferRatio - qoeWeights.switching * switchingRate;

  return {
    traceId,
    algorithmId,
    chunkDuration,
    totalChunks,
    completedChunks: records.length,
    totalStallSeconds,
    averageBitrate,
    averageThroughput,
    averageBuffer,
    switchCount,
    meanUtility,
    rebufferRatio,
    switchingRate,
    qoe,
    playbackDurationSeconds,
  };
}

export function createMetricsTracker({
  traceId,
  algorithmId,
  chunkDuration,
  bitrateLadderMbps,
  qoeWeights,
}) {
  const records = [];

  return {
    recordChunk(result) {
      records.push(result);
    },
    getSummary(snapshot) {
      return summarizeRecords({
        records,
        traceId,
        algorithmId,
        chunkDuration,
        bitrateLadderMbps,
        qoeWeights,
        totalChunks: snapshot.totalChunks,
      });
    },
  };
}

export function formatSummaryMetrics(summary) {
  return [
    {
      label: "Completed chunks",
      value: `${summary.completedChunks} / ${summary.totalChunks}`,
    },
    {
      label: "Paper QoE score",
      value: `${summary.qoe.toFixed(3)}`,
    },
    {
      label: "Mean utility",
      value: `${summary.meanUtility.toFixed(3)}`,
    },
    {
      label: "Rebuffer ratio",
      value: `${(summary.rebufferRatio * 100).toFixed(2)}%`,
    },
    {
      label: "Switching rate",
      value: `${(summary.switchingRate * 100).toFixed(2)}%`,
    },
    {
      label: "Average bitrate",
      value: `${summary.averageBitrate.toFixed(2)} Mbps`,
    },
    {
      label: "Average throughput",
      value: `${summary.averageThroughput.toFixed(2)} Mbps`,
    },
    {
      label: "Average buffer",
      value: `${summary.averageBuffer.toFixed(2)} s`,
    },
    {
      label: "Bitrate switches",
      value: `${summary.switchCount}`,
    },
    {
      label: "Total stall time",
      value: `${summary.totalStallSeconds.toFixed(2)} s`,
    },
  ];
}
