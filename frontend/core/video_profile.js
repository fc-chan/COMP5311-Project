import { normalizedUtilityForBitrate } from "./metrics.js";

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 54;
const SAMPLE_POSITIONS = [0.14, 0.34, 0.54, 0.74];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function once(target, successEvent, errorEvents = ["error"], timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${successEvent}`));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timerId);
      target.removeEventListener(successEvent, handleSuccess);
      errorEvents.forEach((eventName) => {
        target.removeEventListener(eventName, handleError);
      });
    }

    function handleSuccess() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error(`Failed while waiting for ${successEvent}`));
    }

    target.addEventListener(successEvent, handleSuccess, { once: true });
    errorEvents.forEach((eventName) => {
      target.addEventListener(eventName, handleError, { once: true });
    });
  });
}

function createProbeVideo(url) {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  return video;
}

async function seekVideo(video, timeSeconds) {
  const targetTime = Math.max(0, Math.min(timeSeconds, Math.max(video.duration - 0.05, 0)));
  if (Math.abs(video.currentTime - targetTime) < 0.01) {
    return;
  }

  const seekedPromise = once(video, "seeked", ["error", "stalled"], 4000);
  video.currentTime = targetTime;
  await seekedPromise;
}

function captureFrameSignal(video, canvas, context) {
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelCount = canvas.width * canvas.height;
  const luma = new Float32Array(pixelCount);
  let sum = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const value =
      (0.2126 * imageData[offset] + 0.7152 * imageData[offset + 1] + 0.0722 * imageData[offset + 2]) /
      255;
    luma[index] = value;
    sum += value;
  }

  const mean = sum / pixelCount;
  let variance = 0;
  let edgeEnergy = 0;

  for (let y = 1; y < canvas.height; y += 1) {
    for (let x = 1; x < canvas.width; x += 1) {
      const index = y * canvas.width + x;
      const center = luma[index];
      const left = luma[index - 1];
      const top = luma[index - canvas.width];
      const delta = center - mean;
      variance += delta * delta;
      edgeEnergy += Math.abs(center - left) + Math.abs(center - top);
    }
  }

  const comparisons = Math.max((canvas.width - 1) * (canvas.height - 1), 1);
  return {
    luma,
    variance: variance / comparisons,
    edgeEnergy: edgeEnergy / (comparisons * 2),
  };
}

function averageFrameDifference(left, right) {
  if (!left || !right || left.length !== right.length) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index] - right[index]);
  }
  return total / left.length;
}

function classifyComplexity(score) {
  if (score < 0.34) {
    return "Low-complexity";
  }
  if (score < 0.67) {
    return "Medium-complexity";
  }
  return "High-complexity";
}

function classifyDetail(score) {
  if (score < 0.34) {
    return "soft-detail";
  }
  if (score < 0.67) {
    return "balanced-detail";
  }
  return "rich-detail";
}

function classifyMotion(score) {
  if (score < 0.34) {
    return "steady-motion";
  }
  if (score < 0.67) {
    return "mixed-motion";
  }
  return "fast-motion";
}

function buildUtilityProfile({
  bitrateLadderMbps,
  fileName,
  width,
  height,
  durationSeconds,
  detailScore,
  motionScore,
}) {
  const pixelCount = Math.max(width * height, 1);
  const resolutionScore = clamp01(
    (Math.log2(pixelCount) - Math.log2(640 * 360)) / (Math.log2(2560 * 1440) - Math.log2(640 * 360))
  );
  const complexityScore = clamp01(
    resolutionScore * 0.45 + detailScore * 0.35 + motionScore * 0.2
  );
  const utilityExponent = 0.78 + complexityScore * 0.95;
  const utilityByBitrateIndex = bitrateLadderMbps.map((bitrate) =>
    clamp01(normalizedUtilityForBitrate(bitrate, bitrateLadderMbps) ** utilityExponent)
  );
  const complexityLabel = classifyComplexity(complexityScore);
  const detailLabel = classifyDetail(detailScore);
  const motionLabel = classifyMotion(motionScore);

  return {
    contentAware: true,
    fileName,
    width,
    height,
    durationSeconds,
    resolutionScore,
    detailScore,
    motionScore,
    complexityScore,
    utilityExponent,
    utilityByBitrateIndex,
    label: `${complexityLabel} content-aware utility`,
    shortLabel: `${height}p · ${motionLabel}`,
    description: `${width}×${height} · ${detailLabel} · ${motionLabel}`,
  };
}

export async function analyzeLocalVideoSource({ url, fileName, bitrateLadderMbps }) {
  const video = createProbeVideo(url);

  try {
    await once(video, "loadedmetadata");

    const width = Math.max(video.videoWidth || 0, 1);
    const height = Math.max(video.videoHeight || 0, 1);
    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context || !Number.isFinite(durationSeconds) || durationSeconds <= 0.4) {
      return buildUtilityProfile({
        bitrateLadderMbps,
        fileName,
        width,
        height,
        durationSeconds,
        detailScore: 0.45,
        motionScore: 0.35,
      });
    }

    const signals = [];
    for (const position of SAMPLE_POSITIONS) {
      await seekVideo(video, durationSeconds * position);
      signals.push(captureFrameSignal(video, canvas, context));
    }

    const averageEdgeEnergy =
      signals.reduce((acc, signal) => acc + signal.edgeEnergy, 0) / Math.max(signals.length, 1);
    const averageVariance =
      signals.reduce((acc, signal) => acc + signal.variance, 0) / Math.max(signals.length, 1);
    const motionSamples = signals.slice(1).map((signal, index) =>
      averageFrameDifference(signals[index].luma, signal.luma)
    );
    const averageMotion =
      motionSamples.reduce((acc, value) => acc + value, 0) / Math.max(motionSamples.length, 1);

    return buildUtilityProfile({
      bitrateLadderMbps,
      fileName,
      width,
      height,
      durationSeconds,
      detailScore: clamp01(averageEdgeEnergy * 7.2 + averageVariance * 1.8),
      motionScore: clamp01(averageMotion * 5.5),
    });
  } catch {
    return buildUtilityProfile({
      bitrateLadderMbps,
      fileName,
      width: 1280,
      height: 720,
      durationSeconds: 0,
      detailScore: 0.5,
      motionScore: 0.4,
    });
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
