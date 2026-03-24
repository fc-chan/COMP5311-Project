export const BITRATE_LADDER_MBPS = [0.3, 0.75, 1.2, 1.85, 2.85, 4.3, 6.0];
export const CHUNK_DURATION = 2.0;

export function clampBitrateIndex(index, bitrateCount) {
  return Math.max(0, Math.min(index, bitrateCount - 1));
}

export class AbrSimulator {
  constructor({
    trace,
    chunkDuration,
    bitrateLadderMbps,
    startupBuffer = 4,
    maxBuffer = 20,
  }) {
    this.trace = trace;
    this.chunkDuration = chunkDuration;
    this.bitrateLadderMbps = bitrateLadderMbps;
    this.maxBuffer = maxBuffer;
    this.reset(startupBuffer);
  }

  reset(startupBuffer = 4) {
    this.chunkIndex = 0;
    this.playbackPosition = 0;
    this.elapsedTime = 0;
    this.bufferSeconds = startupBuffer;
    this.lastBitrateIndex = 0;
    this.lastThroughputMbps = 0;
    this.lastStallSeconds = 0;
    this.history = [];
  }

  isFinished() {
    return this.chunkIndex >= this.trace.samples.length;
  }

  getLastBitrateIndex() {
    return this.history.length === 0 ? 0 : this.lastBitrateIndex;
  }

  buildDecisionContext({ predictedThroughput, previousBitrateIndex }) {
    return {
      bufferSeconds: this.bufferSeconds,
      previousBitrateIndex,
      predictedThroughputMbps: predictedThroughput,
      predictedHorizonMbps: Array.from({ length: 5 }, (_, index) =>
        Math.max(0.35, predictedThroughput * (1 - index * 0.03))
      ),
      bitrateLadderMbps: this.bitrateLadderMbps,
      chunkDuration: this.chunkDuration,
      maxBuffer: this.maxBuffer,
      chunkIndex: this.chunkIndex,
      traceLabel: this.trace.label,
    };
  }

  downloadNextChunk({ bitrateIndex, predictedThroughput }) {
    // A trace sample is treated as the delivery capacity for one chunk interval.
    const selectedBitrateMbps = this.bitrateLadderMbps[bitrateIndex];
    const actualThroughputMbps = this.trace.samples[this.chunkIndex];
    const chunkSizeMbit = selectedBitrateMbps * this.chunkDuration;
    const downloadTimeSeconds = chunkSizeMbit / actualThroughputMbps;
    const stallSeconds = Math.max(0, downloadTimeSeconds - this.bufferSeconds);
    const bufferAfterSeconds = Math.min(
      this.maxBuffer,
      Math.max(0, this.bufferSeconds - downloadTimeSeconds) + this.chunkDuration
    );

    this.elapsedTime += downloadTimeSeconds;
    this.playbackPosition += this.chunkDuration;
    this.bufferSeconds = bufferAfterSeconds;
    this.chunkIndex += 1;
    this.lastBitrateIndex = bitrateIndex;
    this.lastThroughputMbps = actualThroughputMbps;
    this.lastStallSeconds = stallSeconds;

    const chunkResult = {
      chunkNumber: this.chunkIndex,
      chunkDurationSeconds: this.chunkDuration,
      selectedBitrateIndex: bitrateIndex,
      selectedBitrateMbps,
      predictedThroughputMbps: predictedThroughput,
      actualThroughputMbps,
      downloadTimeSeconds,
      stallSeconds,
      bufferAfterSeconds,
      elapsedTimeSeconds: this.elapsedTime,
      playbackPositionSeconds: this.playbackPosition,
    };

    this.history.push(chunkResult);
    return chunkResult;
  }

  getSnapshot() {
    return {
      traceId: this.trace.id,
      totalChunks: this.trace.samples.length,
      currentBitrateMbps: this.bitrateLadderMbps[this.lastBitrateIndex],
      lastThroughputMbps: this.lastThroughputMbps,
      bufferSeconds: this.bufferSeconds,
      playbackPosition: this.playbackPosition,
      elapsedTime: this.elapsedTime,
      lastStallSeconds: this.lastStallSeconds,
      history: this.history,
      traceSamples: this.trace.samples,
    };
  }
}
