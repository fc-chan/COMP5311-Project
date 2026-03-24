import { createMovingAveragePredictor } from "./core/predictor.js";
import { ABR_ALGORITHMS } from "./core/algorithms.js";
import { AbrSimulator, BITRATE_LADDER_MBPS, CHUNK_DURATION } from "./core/simulator.js";
import { createMetricsTracker, formatSummaryMetrics } from "./core/metrics.js";
import { loadTraceCatalog } from "./core/traces.js";
import { analyzeLocalVideoSource } from "./core/video_profile.js";

const STEP_INTERVAL_MS = 650;
const VISUAL_PLAYBACK_RATE = CHUNK_DURATION / (STEP_INTERVAL_MS / 1000);
const DEFAULT_PROCESS_UPLOAD_HINT =
  "Upload one local video. The simulator will reuse the same source video for the main player, then map bitrate decisions to visible quality changes, rebuffer freezes, and a content-aware live utility model.";
const DEFAULT_COMPARISON_UPLOAD_HINT =
  "Upload two local videos. The left lane always uses SODA, the right lane follows the selected baseline, and these uploads only affect this comparison workspace.";
const QUALITY_LABELS = [
  "240p-like",
  "360p-like",
  "480p-like",
  "720p-like",
  "900p-like",
  "1080p-like",
  "1440p-like",
];

const ui = {
  screenTabs: Array.from(document.querySelectorAll("[data-screen-target]")),
  screenPanels: Array.from(document.querySelectorAll("[data-screen]")),
  processAlgorithmSelect: document.querySelector("#algorithm-select"),
  processScenarioSelect: document.querySelector("#scenario-select"),
  processStartBtn: document.querySelector("#start-btn"),
  processPauseBtn: document.querySelector("#pause-btn"),
  processResetBtn: document.querySelector("#reset-btn"),
  processVideoUpload: document.querySelector("#video-upload"),
  processClearVideoBtn: document.querySelector("#clear-video-btn"),
  processUploadHint: document.querySelector("#upload-hint"),
  processScenarioDescription: document.querySelector("#scenario-description"),
  compareAlgorithmSelect: document.querySelector("#compare-algorithm-select"),
  compareScenarioSelect: document.querySelector("#compare-scenario-select"),
  compareStartBtn: document.querySelector("#compare-start-btn"),
  comparePauseBtn: document.querySelector("#compare-pause-btn"),
  compareResetBtn: document.querySelector("#compare-reset-btn"),
  compareLeftVideoUpload: document.querySelector("#compare-left-video-upload"),
  compareLeftClearBtn: document.querySelector("#compare-left-clear-btn"),
  compareRightVideoUpload: document.querySelector("#compare-right-video-upload"),
  compareRightClearBtn: document.querySelector("#compare-right-clear-btn"),
  compareUploadHint: document.querySelector("#compare-upload-hint"),
  compareScenarioDescription: document.querySelector("#compare-scenario-description"),
  showdownTitle: document.querySelector("#showdown-title"),
  showdownCopy: document.querySelector("#showdown-copy"),
  compareLeftLabel: document.querySelector("#compare-left-label"),
  compareRightLabel: document.querySelector("#compare-right-label"),
  compareLeftSummary: document.querySelector("#compare-left-summary"),
  compareRightSummary: document.querySelector("#compare-right-summary"),
  comparisonTitle: document.querySelector("#comparison-title"),
  comparisonCopy: document.querySelector("#comparison-copy"),
  comparisonHighlights: document.querySelector("#comparison-highlights"),
  comparisonBody: document.querySelector("#comparison-body"),
  solverNote: document.querySelector("#solver-note"),
  sessionTitle: document.querySelector("#session-title"),
  stallIndicator: document.querySelector("#stall-indicator"),
  currentBitrate: document.querySelector("#current-bitrate"),
  currentThroughput: document.querySelector("#current-throughput"),
  currentBuffer: document.querySelector("#current-buffer"),
  playbackPosition: document.querySelector("#playback-position"),
  elapsedTime: document.querySelector("#elapsed-time"),
  playbackProgress: document.querySelector("#playback-progress"),
  bufferProgress: document.querySelector("#buffer-progress"),
  metricsGrid: document.querySelector("#metrics-grid"),
  decisionLog: document.querySelector("#decision-log"),
  throughputChart: document.querySelector("#throughput-chart"),
  bitrateChart: document.querySelector("#bitrate-chart"),
  bufferChart: document.querySelector("#buffer-chart"),
};

const chartStyles = {
  throughput: { color: "#0f766e", fill: "rgba(15, 118, 110, 0.14)" },
  bitrate: { color: "#ea580c", fill: "rgba(234, 88, 12, 0.14)" },
  buffer: { color: "#1d4ed8", fill: "rgba(29, 78, 216, 0.14)" },
  stall: "rgba(185, 28, 28, 0.22)",
  grid: "rgba(77, 67, 52, 0.08)",
  axis: "rgba(77, 67, 52, 0.44)",
  text: "#6f6a61",
};

const previews = {
  process: createPreviewController({
    root: document.querySelector("#video-preview"),
    video: document.querySelector("#local-video"),
    emptyState: document.querySelector("#video-empty-state"),
    qualityBadge: document.querySelector("#video-quality-badge"),
    statusCopy: document.querySelector("#video-status-copy"),
    stallOverlay: document.querySelector("#video-stall-overlay"),
    emptyMessage:
      "Upload a local video to turn SODA and baseline decisions into a visible playback demo.",
  }),
  compareLeft: createPreviewController({
    root: document.querySelector("#compare-left-preview"),
    video: document.querySelector("#compare-left-video"),
    emptyState: document.querySelector("#compare-left-empty"),
    qualityBadge: document.querySelector("#compare-left-quality"),
    statusCopy: document.querySelector("#compare-left-status"),
    stallOverlay: document.querySelector("#compare-left-stall"),
    emptyMessage: "Upload the left comparison video for SODA.",
  }),
  compareRight: createPreviewController({
    root: document.querySelector("#compare-right-preview"),
    video: document.querySelector("#compare-right-video"),
    emptyState: document.querySelector("#compare-right-empty"),
    qualityBadge: document.querySelector("#compare-right-quality"),
    statusCopy: document.querySelector("#compare-right-status"),
    stallOverlay: document.querySelector("#compare-right-stall"),
    emptyMessage: "Upload the right comparison video for the selected baseline.",
  }),
};

const processState = {
  algorithmId: "soda",
  traceId: null,
  session: null,
  timerId: null,
  videoUrl: null,
  utilityProfile: null,
  isProfileLoading: false,
  profileRequestId: 0,
};

const comparisonState = {
  baselineAlgorithmId: "greedy",
  traceId: null,
  sodaSession: null,
  baselineSession: null,
  timerId: null,
  leftVideoUrl: null,
  rightVideoUrl: null,
  leftUtilityProfile: null,
  rightUtilityProfile: null,
  leftProfileLoading: false,
  rightProfileLoading: false,
  leftProfileRequestId: 0,
  rightProfileRequestId: 0,
};

let traceCatalog = [];
let batchResults = null;
let activeScreen = "workspace";

function createPreviewController({
  root,
  video,
  emptyState,
  qualityBadge,
  statusCopy,
  stallOverlay,
  emptyMessage,
}) {
  return {
    root,
    video,
    emptyState,
    qualityBadge,
    statusCopy,
    stallOverlay,
    emptyMessage,
    stallTimeoutId: null,
    stallActive: false,
  };
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value, digits = 1) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}%`;
}

function getTraceById(traceId) {
  return traceCatalog.find((trace) => trace.id === traceId);
}

function getAlgorithmSpec(algorithmId) {
  return ABR_ALGORITHMS[algorithmId];
}

function pauseActiveScreen(screenId) {
  if (screenId === "workspace") {
    pauseProcessLoop({ render: false });
  } else if (screenId === "comparison") {
    pauseComparisonLoop({ render: false });
  }
}

function getProcessUploadHintText() {
  if (processState.isProfileLoading) {
    return "Analyzing the uploaded video for this workspace. The live process metrics will refresh when the profile is ready.";
  }

  if (processState.utilityProfile) {
    return `Workspace utility model: ${processState.utilityProfile.description}. This upload only affects the first workspace.`;
  }

  return DEFAULT_PROCESS_UPLOAD_HINT;
}

function getComparisonUploadHintText() {
  if (comparisonState.leftProfileLoading || comparisonState.rightProfileLoading) {
    return "Analyzing one of the comparison videos. The showdown summaries will refresh when both lane profiles are ready.";
  }

  const activeProfiles = [];
  if (comparisonState.leftUtilityProfile) {
    activeProfiles.push(`left ${comparisonState.leftUtilityProfile.description}`);
  }
  if (comparisonState.rightUtilityProfile) {
    activeProfiles.push(`right ${comparisonState.rightUtilityProfile.description}`);
  }

  if (activeProfiles.length > 0) {
    return `Comparison utility models active: ${activeProfiles.join(" | ")}. These uploads only affect the second workspace.`;
  }

  return DEFAULT_COMPARISON_UPLOAD_HINT;
}

function populateSelectors() {
  Object.entries(ABR_ALGORITHMS).forEach(([id, spec]) => {
    const processOption = document.createElement("option");
    processOption.value = id;
    processOption.textContent = spec.label;
    ui.processAlgorithmSelect.appendChild(processOption);

    if (id !== "soda") {
      const compareOption = document.createElement("option");
      compareOption.value = id;
      compareOption.textContent = spec.label;
      ui.compareAlgorithmSelect.appendChild(compareOption);
    }
  });

  traceCatalog.forEach((trace) => {
    const processOption = document.createElement("option");
    processOption.value = trace.id;
    processOption.textContent = trace.label;
    ui.processScenarioSelect.appendChild(processOption);

    const compareOption = document.createElement("option");
    compareOption.value = trace.id;
    compareOption.textContent = trace.label;
    ui.compareScenarioSelect.appendChild(compareOption);
  });
}

function setActiveScreen(screenId) {
  if (activeScreen !== screenId) {
    pauseActiveScreen(activeScreen);
  }

  activeScreen = screenId;

  ui.screenTabs.forEach((tab) => {
    const isActive = tab.dataset.screenTarget === screenId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  ui.screenPanels.forEach((panel) => {
    const isActive = panel.dataset.screen === screenId;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });

  window.requestAnimationFrame(() => {
    renderAll();
  });
}

async function loadBatchResults() {
  try {
    const response = await fetch("../results/batch_eval.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load batch results: ${response.status}`);
    }
    return response.json();
  } catch {
    return null;
  }
}

function createAbrSession(algorithmId, trace, utilityProfile = null) {
  const algorithmSpec = getAlgorithmSpec(algorithmId);
  return {
    algorithmId,
    algorithmSpec,
    trace,
    predictor: createMovingAveragePredictor({ windowSize: 5, defaultValue: 2.2 }),
    controller: algorithmSpec.factory(),
    simulator: new AbrSimulator({
      trace,
      chunkDuration: CHUNK_DURATION,
      bitrateLadderMbps: BITRATE_LADDER_MBPS,
      startupBuffer: 4,
      maxBuffer: 20,
    }),
    metrics: createMetricsTracker({
      traceId: trace.id,
      algorithmId,
      chunkDuration: CHUNK_DURATION,
      bitrateLadderMbps: BITRATE_LADDER_MBPS,
      utilityProfile,
    }),
  };
}

function stepAbrSession(session) {
  if (!session || session.simulator.isFinished()) {
    return null;
  }

  const predictedThroughput = session.predictor.predict();
  const decisionContext = session.simulator.buildDecisionContext({
    predictedThroughput,
    previousBitrateIndex: session.simulator.getLastBitrateIndex(),
  });
  const bitrateIndex = session.controller.selectBitrateIndex(decisionContext);
  const chunkResult = session.simulator.downloadNextChunk({
    bitrateIndex,
    predictedThroughput,
  });
  session.predictor.pushSample(chunkResult.actualThroughputMbps);
  session.metrics.recordChunk(chunkResult);
  return chunkResult;
}

function getSessionSnapshot(session) {
  return session ? session.simulator.getSnapshot() : null;
}

function getSessionSummary(session) {
  return session ? session.metrics.getSummary(session.simulator.getSnapshot()) : null;
}

function previewHasVideo(preview) {
  return preview.video.hasAttribute("src");
}

function clearPreviewStall(preview) {
  if (preview.stallTimeoutId) {
    window.clearTimeout(preview.stallTimeoutId);
    preview.stallTimeoutId = null;
  }
  preview.stallActive = false;
  preview.root.classList.remove("is-stalled");
  preview.stallOverlay.textContent = "Rebuffering";
}

function pausePreview(preview) {
  if (!previewHasVideo(preview)) {
    return;
  }
  preview.video.pause();
}

function playPreview(preview) {
  if (!previewHasVideo(preview) || preview.stallActive || preview.video.readyState < 2) {
    return;
  }
  preview.video.playbackRate = VISUAL_PLAYBACK_RATE;
  const promise = preview.video.play();
  if (promise && typeof promise.catch === "function") {
    promise.catch(() => {});
  }
}

function resetPreviewPlayback(preview) {
  clearPreviewStall(preview);
  pausePreview(preview);

  if (!previewHasVideo(preview) || preview.video.readyState < 1) {
    return;
  }

  try {
    preview.video.currentTime = 0;
  } catch {
    // Ignore occasional media seek errors while metadata is stabilizing.
  }
}

function setPreviewSource(preview, url, emptyMessage = preview.emptyMessage) {
  preview.emptyState.textContent = emptyMessage;

  if (!url) {
    clearPreviewStall(preview);
    pausePreview(preview);
    preview.video.removeAttribute("src");
    preview.video.load();
    preview.root.classList.remove("has-video", "is-stalled");
    preview.qualityBadge.textContent = "No video loaded";
    preview.statusCopy.textContent = emptyMessage;
    preview.root.style.setProperty("--video-blur", "9px");
    preview.root.style.setProperty("--video-saturation", "0.65");
    preview.root.style.setProperty("--video-contrast", "0.82");
    preview.root.style.setProperty("--video-overlay-opacity", "0.38");
    return;
  }

  if (preview.video.getAttribute("src") !== url) {
    preview.video.setAttribute("src", url);
    preview.video.load();
  }
  preview.root.classList.add("has-video");
}

function syncPreviewToSnapshot(preview, snapshot, isRunning) {
  if (!snapshot || !previewHasVideo(preview)) {
    return;
  }

  if (
    preview.video.readyState < 1 ||
    !Number.isFinite(preview.video.duration) ||
    preview.video.duration <= 0
  ) {
    return;
  }

  const traceDuration = snapshot.totalChunks * CHUNK_DURATION;
  const targetTime = Math.min(
    preview.video.duration,
    (snapshot.playbackPosition / traceDuration) * preview.video.duration
  );
  const drift = Math.abs(preview.video.currentTime - targetTime);

  if (!isRunning || preview.stallActive || drift > 0.65) {
    try {
      preview.video.currentTime = targetTime;
    } catch {
      // Ignore occasional browser seek rejections during fast updates.
    }
  }
}

function renderPreview(preview, snapshot, statusText, isRunning) {
  const hasVideo = previewHasVideo(preview);
  preview.root.classList.toggle("has-video", hasVideo);
  preview.root.classList.toggle("is-stalled", preview.stallActive);

  if (!hasVideo) {
    preview.qualityBadge.textContent = "No video loaded";
    preview.statusCopy.textContent = preview.emptyState.textContent;
    return;
  }

  const bitrateIndex =
    !snapshot || snapshot.history.length === 0
      ? 0
      : snapshot.history[snapshot.history.length - 1].selectedBitrateIndex;
  const normalizedQuality = bitrateIndex / Math.max(BITRATE_LADDER_MBPS.length - 1, 1);
  const bitrateMbps = snapshot?.currentBitrateMbps ?? BITRATE_LADDER_MBPS[0];
  const qualityLabel = QUALITY_LABELS[bitrateIndex] ?? "Adaptive";

  preview.root.style.setProperty("--video-blur", `${(9.5 - normalizedQuality * 8.5).toFixed(2)}px`);
  preview.root.style.setProperty("--video-saturation", (0.62 + normalizedQuality * 0.38).toFixed(2));
  preview.root.style.setProperty("--video-contrast", (0.8 + normalizedQuality * 0.2).toFixed(2));
  preview.root.style.setProperty("--video-overlay-opacity", (0.42 - normalizedQuality * 0.34).toFixed(2));
  preview.qualityBadge.textContent = `Simulated ${qualityLabel} · ${bitrateMbps.toFixed(2)} Mbps`;
  preview.statusCopy.textContent = statusText;
  syncPreviewToSnapshot(preview, snapshot, isRunning);
}

function triggerPreviewStall(preview, stallSeconds, isRunningGetter) {
  if (!previewHasVideo(preview) || stallSeconds <= 0) {
    return;
  }

  clearPreviewStall(preview);
  preview.stallActive = true;
  preview.root.classList.add("is-stalled");
  preview.stallOverlay.textContent = `Rebuffering ${stallSeconds.toFixed(1)} s`;
  pausePreview(preview);

  const stallWallClockMs = Math.max(280, (stallSeconds * STEP_INTERVAL_MS) / CHUNK_DURATION);
  preview.stallTimeoutId = window.setTimeout(() => {
    preview.stallActive = false;
    preview.root.classList.remove("is-stalled");
    if (isRunningGetter()) {
      playPreview(preview);
    }
    preview.stallTimeoutId = null;
  }, stallWallClockMs);
}

function renderSummaryCards(container, summary, placeholderText) {
  if (!summary) {
    container.innerHTML = `<article class="compare-summary-placeholder">${placeholderText}</article>`;
    return;
  }

  const items = [
    { label: "QoE", value: summary.qoe.toFixed(3) },
    { label: "Rebuffer", value: formatPercent(summary.rebufferRatio, 2) },
    { label: "Switching", value: formatPercent(summary.switchingRate, 2) },
    {
      label: summary.contentAwareUtility ? "Mean content utility" : "Mean utility",
      value: summary.meanUtility.toFixed(3),
    },
  ];

  container.innerHTML = "";
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "compare-summary-card";
    card.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong>`;
    container.appendChild(card);
  });
}

function revokeVideoUrl(url) {
  if (url) {
    URL.revokeObjectURL(url);
  }
  return null;
}

function syncProcessPreviewSource() {
  setPreviewSource(previews.process, processState.videoUrl, previews.process.emptyMessage);
}

function syncComparisonPreviewSources() {
  setPreviewSource(previews.compareLeft, comparisonState.leftVideoUrl, previews.compareLeft.emptyMessage);
  setPreviewSource(
    previews.compareRight,
    comparisonState.rightVideoUrl,
    previews.compareRight.emptyMessage
  );
}

function clearProcessPreviewState() {
  clearPreviewStall(previews.process);
  resetPreviewPlayback(previews.process);
  syncProcessPreviewSource();
}

function clearComparisonPreviewState() {
  clearPreviewStall(previews.compareLeft);
  clearPreviewStall(previews.compareRight);
  resetPreviewPlayback(previews.compareLeft);
  resetPreviewPlayback(previews.compareRight);
  syncComparisonPreviewSources();
}

function buildProcessSession() {
  const trace = getTraceById(processState.traceId);
  const algorithmSpec = getAlgorithmSpec(processState.algorithmId);

  processState.session = createAbrSession(processState.algorithmId, trace, processState.utilityProfile);
  ui.sessionTitle.textContent = `${algorithmSpec.label} on ${trace.label}`;
  ui.processScenarioDescription.textContent = processState.utilityProfile
    ? `${algorithmSpec.description} ${trace.description} Workspace utility model: ${processState.utilityProfile.label.toLowerCase()} (${processState.utilityProfile.description}).`
    : `${algorithmSpec.description} ${trace.description} Workspace utility model: generic bitrate-only utility.`;

  clearProcessPreviewState();
  renderAll();
}

function buildComparisonSessions() {
  const trace = getTraceById(comparisonState.traceId);
  const baselineSpec = getAlgorithmSpec(comparisonState.baselineAlgorithmId);

  comparisonState.sodaSession = createAbrSession("soda", trace, comparisonState.leftUtilityProfile);
  comparisonState.baselineSession = createAbrSession(
    comparisonState.baselineAlgorithmId,
    trace,
    comparisonState.rightUtilityProfile
  );

  const leftUtilityCopy = comparisonState.leftUtilityProfile
    ? `Left utility model: ${comparisonState.leftUtilityProfile.description}.`
    : "Left utility model: generic bitrate-only utility.";
  const rightUtilityCopy = comparisonState.rightUtilityProfile
    ? `Right utility model: ${comparisonState.rightUtilityProfile.description}.`
    : "Right utility model: generic bitrate-only utility.";

  ui.compareScenarioDescription.textContent = `${baselineSpec.description} ${trace.description} ${leftUtilityCopy} ${rightUtilityCopy}`;

  clearComparisonPreviewState();
  renderAll();
}

function startProcessLoop() {
  if (!processState.session || processState.timerId || processState.session.simulator.isFinished()) {
    return;
  }
  processState.timerId = window.setInterval(stepProcessSession, STEP_INTERVAL_MS);
  playPreview(previews.process);
  renderAll();
}

function pauseProcessLoop({ render = true } = {}) {
  if (processState.timerId) {
    window.clearInterval(processState.timerId);
    processState.timerId = null;
  }
  clearPreviewStall(previews.process);
  pausePreview(previews.process);
  if (render) {
    renderAll();
  }
}

function resetProcessSession() {
  pauseProcessLoop({ render: false });
  buildProcessSession();
}

function stepProcessSession() {
  if (!processState.session || processState.session.simulator.isFinished()) {
    pauseProcessLoop();
    return;
  }

  const chunk = stepAbrSession(processState.session);
  if (chunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.process, chunk.stallSeconds, () => Boolean(processState.timerId));
  }

  renderAll();

  if (processState.session.simulator.isFinished()) {
    pauseProcessLoop();
  }
}

function startComparisonLoop() {
  if (
    !comparisonState.sodaSession ||
    !comparisonState.baselineSession ||
    comparisonState.timerId ||
    (comparisonState.sodaSession.simulator.isFinished() &&
      comparisonState.baselineSession.simulator.isFinished())
  ) {
    return;
  }

  comparisonState.timerId = window.setInterval(stepComparisonSessions, STEP_INTERVAL_MS);
  playPreview(previews.compareLeft);
  playPreview(previews.compareRight);
  renderAll();
}

function pauseComparisonLoop({ render = true } = {}) {
  if (comparisonState.timerId) {
    window.clearInterval(comparisonState.timerId);
    comparisonState.timerId = null;
  }
  clearPreviewStall(previews.compareLeft);
  clearPreviewStall(previews.compareRight);
  pausePreview(previews.compareLeft);
  pausePreview(previews.compareRight);
  if (render) {
    renderAll();
  }
}

function resetComparisonSession() {
  pauseComparisonLoop({ render: false });
  buildComparisonSessions();
}

function stepComparisonSessions() {
  if (
    !comparisonState.sodaSession ||
    !comparisonState.baselineSession ||
    (comparisonState.sodaSession.simulator.isFinished() &&
      comparisonState.baselineSession.simulator.isFinished())
  ) {
    pauseComparisonLoop();
    return;
  }

  const sodaChunk = stepAbrSession(comparisonState.sodaSession);
  const baselineChunk = stepAbrSession(comparisonState.baselineSession);

  if (sodaChunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.compareLeft, sodaChunk.stallSeconds, () =>
      Boolean(comparisonState.timerId)
    );
  }

  if (baselineChunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.compareRight, baselineChunk.stallSeconds, () =>
      Boolean(comparisonState.timerId)
    );
  }

  renderAll();

  if (
    comparisonState.sodaSession.simulator.isFinished() &&
    comparisonState.baselineSession.simulator.isFinished()
  ) {
    pauseComparisonLoop();
  }
}

function clearProcessVideo({ clearInput = true } = {}) {
  processState.profileRequestId += 1;
  processState.isProfileLoading = false;
  processState.utilityProfile = null;
  pauseProcessLoop({ render: false });
  processState.videoUrl = revokeVideoUrl(processState.videoUrl);
  if (clearInput) {
    ui.processVideoUpload.value = "";
  }
  buildProcessSession();
}

async function handleProcessVideoSelection(event) {
  const [file] = event.target.files ?? [];
  if (!file) {
    return;
  }

  const requestId = ++processState.profileRequestId;
  processState.isProfileLoading = true;
  processState.utilityProfile = null;
  pauseProcessLoop({ render: false });
  processState.videoUrl = revokeVideoUrl(processState.videoUrl);
  processState.videoUrl = URL.createObjectURL(file);
  syncProcessPreviewSource();
  renderAll();

  try {
    const profile = await analyzeLocalVideoSource({
      url: processState.videoUrl,
      fileName: file.name,
      bitrateLadderMbps: BITRATE_LADDER_MBPS,
    });

    if (requestId !== processState.profileRequestId) {
      return;
    }

    processState.utilityProfile = profile;
  } finally {
    if (requestId !== processState.profileRequestId) {
      return;
    }

    processState.isProfileLoading = false;
    buildProcessSession();
  }
}

function clearComparisonVideo(side, { clearInput = true } = {}) {
  if (side === "left") {
    comparisonState.leftProfileRequestId += 1;
    comparisonState.leftProfileLoading = false;
    comparisonState.leftUtilityProfile = null;
    comparisonState.leftVideoUrl = revokeVideoUrl(comparisonState.leftVideoUrl);
    if (clearInput) {
      ui.compareLeftVideoUpload.value = "";
    }
  } else {
    comparisonState.rightProfileRequestId += 1;
    comparisonState.rightProfileLoading = false;
    comparisonState.rightUtilityProfile = null;
    comparisonState.rightVideoUrl = revokeVideoUrl(comparisonState.rightVideoUrl);
    if (clearInput) {
      ui.compareRightVideoUpload.value = "";
    }
  }

  pauseComparisonLoop({ render: false });
  buildComparisonSessions();
}

async function handleComparisonVideoSelection(side, event) {
  const [file] = event.target.files ?? [];
  if (!file) {
    return;
  }

  pauseComparisonLoop({ render: false });

  if (side === "left") {
    const requestId = ++comparisonState.leftProfileRequestId;
    comparisonState.leftProfileLoading = true;
    comparisonState.leftUtilityProfile = null;
    comparisonState.leftVideoUrl = revokeVideoUrl(comparisonState.leftVideoUrl);
    comparisonState.leftVideoUrl = URL.createObjectURL(file);
    syncComparisonPreviewSources();
    renderAll();

    try {
      const profile = await analyzeLocalVideoSource({
        url: comparisonState.leftVideoUrl,
        fileName: file.name,
        bitrateLadderMbps: BITRATE_LADDER_MBPS,
      });

      if (requestId !== comparisonState.leftProfileRequestId) {
        return;
      }

      comparisonState.leftUtilityProfile = profile;
    } finally {
      if (requestId !== comparisonState.leftProfileRequestId) {
        return;
      }

      comparisonState.leftProfileLoading = false;
      buildComparisonSessions();
    }
    return;
  }

  const requestId = ++comparisonState.rightProfileRequestId;
  comparisonState.rightProfileLoading = true;
  comparisonState.rightUtilityProfile = null;
  comparisonState.rightVideoUrl = revokeVideoUrl(comparisonState.rightVideoUrl);
  comparisonState.rightVideoUrl = URL.createObjectURL(file);
  syncComparisonPreviewSources();
  renderAll();

  try {
    const profile = await analyzeLocalVideoSource({
      url: comparisonState.rightVideoUrl,
      fileName: file.name,
      bitrateLadderMbps: BITRATE_LADDER_MBPS,
    });

    if (requestId !== comparisonState.rightProfileRequestId) {
      return;
    }

    comparisonState.rightUtilityProfile = profile;
  } finally {
    if (requestId !== comparisonState.rightProfileRequestId) {
      return;
    }

    comparisonState.rightProfileLoading = false;
    buildComparisonSessions();
  }
}

function getPreviewStatusText(session, preview, label, isRunning, emptyMessage) {
  if (!session) {
    return emptyMessage;
  }

  const snapshot = getSessionSnapshot(session);
  if (!previewHasVideo(preview)) {
    return preview.emptyState.textContent;
  }

  if (!snapshot || snapshot.history.length === 0) {
    return `${label} is ready. Press Start to replay the selected trace on the uploaded video.`;
  }

  if (preview.stallActive || snapshot.lastStallSeconds > 0) {
    return `${label} is freezing to visualize a rebuffer event.`;
  }

  if (isRunning) {
    return `${label} is replaying the selected trace under synchronized timing.`;
  }

  return `${label} is paused. Use Start to continue the run.`;
}

function renderMainMetrics(summary) {
  ui.metricsGrid.innerHTML = "";
  formatSummaryMetrics(summary).forEach((item) => {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong>`;
    ui.metricsGrid.appendChild(card);
  });
}

function renderDecisionLog(history) {
  ui.decisionLog.innerHTML = "";
  history.slice(-8).reverse().forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${item.chunkNumber}</td>
      <td>${item.predictedThroughputMbps.toFixed(2)}</td>
      <td>${item.actualThroughputMbps.toFixed(2)}</td>
      <td>${item.selectedBitrateMbps.toFixed(2)}</td>
      <td>${item.downloadTimeSeconds.toFixed(2)}</td>
      <td>${item.bufferAfterSeconds.toFixed(2)}</td>
      <td class="${item.stallSeconds > 0 ? "stall-cell" : ""}">${item.stallSeconds.toFixed(2)}</td>
    `;
    ui.decisionLog.appendChild(row);
  });
}

function drawLineChart(canvas, history, options) {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth * dpr;
  const height = canvas.clientHeight * dpr;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const padding = { top: 18, right: 16, bottom: 28, left: 40 };
  const plotWidth = w - padding.left - padding.right;
  const plotHeight = h - padding.top - padding.bottom;

  ctx.strokeStyle = chartStyles.grid;
  ctx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }

  const points = history.map((item, index) => ({
    x: padding.left + (plotWidth * index) / Math.max(history.length - 1, 1),
    y:
      padding.top +
      plotHeight -
      (Math.min(options.maxValue, options.accessor(item)) / options.maxValue) * plotHeight,
  }));

  options.stalls.forEach((item, index) => {
    if (item.stallSeconds <= 0 || history.length === 0) {
      return;
    }
    const x = padding.left + (plotWidth * index) / Math.max(history.length - 1, 1);
    ctx.fillStyle = chartStyles.stall;
    ctx.fillRect(x - 4, padding.top, 8, plotHeight);
  });

  if (points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point, index) => {
      if (options.step) {
        const previousPoint = points[index];
        ctx.lineTo(point.x, previousPoint.y);
      }
      ctx.lineTo(point.x, point.y);
    });
    ctx.lineTo(points[points.length - 1].x, padding.top + plotHeight);
    ctx.lineTo(points[0].x, padding.top + plotHeight);
    ctx.closePath();
    ctx.fillStyle = options.style.fill;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point, index) => {
      if (options.step) {
        const previousPoint = points[index];
        ctx.lineTo(point.x, previousPoint.y);
      }
      ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = options.style.color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  ctx.fillStyle = chartStyles.text;
  ctx.font = "12px Segoe UI";
  ctx.fillText(`0 ${options.label}`, 8, h - 12);
  ctx.fillText(`${options.maxValue.toFixed(1)} ${options.label}`, 8, padding.top + 12);

  ctx.strokeStyle = chartStyles.axis;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.stroke();
}

function renderProcessInterface() {
  if (!processState.session) {
    return;
  }

  ui.processUploadHint.textContent = getProcessUploadHintText();

  const snapshot = getSessionSnapshot(processState.session);
  const summary = getSessionSummary(processState.session);

  ui.currentBitrate.textContent = `${snapshot.currentBitrateMbps.toFixed(2)} Mbps`;
  ui.currentThroughput.textContent = `${snapshot.lastThroughputMbps.toFixed(2)} Mbps`;
  ui.currentBuffer.textContent = `${snapshot.bufferSeconds.toFixed(1)} s`;
  ui.playbackPosition.textContent = `Playback ${snapshot.playbackPosition.toFixed(1)} s`;
  ui.elapsedTime.textContent = `Elapsed ${snapshot.elapsedTime.toFixed(1)} s`;

  const traceDuration = snapshot.totalChunks * CHUNK_DURATION;
  ui.playbackProgress.style.width = `${Math.min(100, (snapshot.playbackPosition / traceDuration) * 100)}%`;
  ui.bufferProgress.style.width = `${Math.min(100, (snapshot.bufferSeconds / processState.session.simulator.maxBuffer) * 100)}%`;

  const isStalling = snapshot.lastStallSeconds > 0;
  ui.stallIndicator.textContent = isStalling
    ? `Stalling ${snapshot.lastStallSeconds.toFixed(1)} s`
    : "Smooth";
  ui.stallIndicator.classList.toggle("stalling", isStalling);

  renderMainMetrics(summary);
  renderDecisionLog(snapshot.history);
  renderPreview(
    previews.process,
    snapshot,
    getPreviewStatusText(
      processState.session,
      previews.process,
      processState.session.algorithmSpec.label,
      Boolean(processState.timerId),
      previews.process.emptyMessage
    ),
    Boolean(processState.timerId)
  );

  drawLineChart(ui.throughputChart, snapshot.history, {
    accessor: (item) => item.actualThroughputMbps,
    label: "Mbps",
    maxValue: Math.max(...snapshot.traceSamples, ...BITRATE_LADDER_MBPS, 1),
    style: chartStyles.throughput,
    stalls: snapshot.history,
  });
  drawLineChart(ui.bitrateChart, snapshot.history, {
    accessor: (item) => item.selectedBitrateMbps,
    label: "Mbps",
    maxValue: BITRATE_LADDER_MBPS[BITRATE_LADDER_MBPS.length - 1],
    style: chartStyles.bitrate,
    stalls: snapshot.history,
    step: true,
  });
  drawLineChart(ui.bufferChart, snapshot.history, {
    accessor: (item) => item.bufferAfterSeconds,
    label: "sec",
    maxValue: processState.session.simulator.maxBuffer,
    style: chartStyles.buffer,
    stalls: snapshot.history,
  });
}

function renderComparisonShowdown() {
  if (!comparisonState.sodaSession || !comparisonState.baselineSession) {
    return;
  }

  const trace = getTraceById(comparisonState.traceId);
  const baselineSpec = getAlgorithmSpec(comparisonState.baselineAlgorithmId);
  const leftSummary = getSessionSummary(comparisonState.sodaSession);
  const rightSummary = getSessionSummary(comparisonState.baselineSession);

  ui.compareUploadHint.textContent = getComparisonUploadHintText();
  ui.compareLeftLabel.textContent = "SODA (paper reproduction)";
  ui.compareRightLabel.textContent = baselineSpec.label;
  ui.showdownTitle.textContent = `SODA vs ${baselineSpec.label} on ${trace.label}`;
  ui.showdownCopy.textContent =
    "Both lanes replay the same trace under independent control-panel settings. Left uses SODA, right uses the selected baseline.";

  renderPreview(
    previews.compareLeft,
    getSessionSnapshot(comparisonState.sodaSession),
    getPreviewStatusText(
      comparisonState.sodaSession,
      previews.compareLeft,
      "SODA",
      Boolean(comparisonState.timerId),
      previews.compareLeft.emptyMessage
    ),
    Boolean(comparisonState.timerId)
  );
  renderPreview(
    previews.compareRight,
    getSessionSnapshot(comparisonState.baselineSession),
    getPreviewStatusText(
      comparisonState.baselineSession,
      previews.compareRight,
      baselineSpec.label,
      Boolean(comparisonState.timerId),
      previews.compareRight.emptyMessage
    ),
    Boolean(comparisonState.timerId)
  );

  renderSummaryCards(
    ui.compareLeftSummary,
    leftSummary,
    "Upload the left comparison video and start the showdown to populate this lane."
  );
  renderSummaryCards(
    ui.compareRightSummary,
    rightSummary,
    "Upload the right comparison video and start the showdown to populate this lane."
  );
}

function renderComparisonTable() {
  const selectedTrace = getTraceById(comparisonState.traceId);
  const selectedAlgorithmId = comparisonState.baselineAlgorithmId;

  if (!batchResults || !selectedTrace) {
    ui.comparisonTitle.textContent = "Batch evaluation unavailable";
    ui.comparisonCopy.textContent =
      "Run `npm run eval` in the project root to regenerate the offline comparison results.";
    ui.comparisonHighlights.innerHTML = "";
    ui.comparisonBody.innerHTML = "";
    ui.solverNote.textContent =
      "The comparison workspace still runs live, but the paper-style table depends on generated result artifacts.";
    return;
  }

  const traceRows = batchResults.byTrace[selectedTrace.id] ?? [];
  const overview = batchResults.overview;
  const aggregateById = Object.fromEntries(
    batchResults.aggregate.map((row) => [row.algorithmId, row])
  );

  ui.comparisonTitle.textContent = `Paper-style comparison on ${selectedTrace.label}`;
  ui.comparisonCopy.textContent =
    comparisonState.leftUtilityProfile || comparisonState.rightUtilityProfile
      ? "Rows are ranked by paper QoE = mean utility - 10 x rebuffer ratio - switching rate. Uploaded comparison videos only change the live showdown summaries above."
      : "Rows are ranked by paper QoE = mean utility - 10 x rebuffer ratio - switching rate.";

  const highlightCards = [
    {
      label: "Overall best QoE",
      value: `SODA ${aggregateById.soda.qoe.toFixed(3)}`,
      detail: `${formatSignedPercent(overview.sodaVsBestBaseline.qoeGainPercent)} vs ${overview.sodaVsBestBaseline.baselineAlgorithmLabel}`,
    },
    {
      label: "Switching reduction vs BOLA-like",
      value: formatSignedPercent(overview.sodaVsBola.switchingReductionPercent),
      detail: `Aggregate switching rate ${formatPercent(aggregateById.soda.switchingRate)} vs ${formatPercent(aggregateById.bola.switchingRate)}`,
    },
    {
      label: "Approx solver fidelity",
      value: formatPercent(overview.solverComparison.agreementRate),
      detail: `${overview.solverComparison.speedup.toFixed(1)}x fewer trajectories than exact search`,
    },
  ];

  ui.comparisonHighlights.innerHTML = "";
  highlightCards.forEach((card) => {
    const element = document.createElement("article");
    element.className = "comparison-highlight";
    element.innerHTML = `<span>${card.label}</span><strong>${card.value}</strong><p>${card.detail}</p>`;
    ui.comparisonHighlights.appendChild(element);
  });

  ui.solverNote.textContent =
    `SODA keeps aggregate rebuffer ratio at ${formatPercent(aggregateById.soda.rebufferRatio, 2)}. Compared with the greedy throughput baseline, that is ${formatSignedPercent(
      overview.sodaVsGreedy.rebufferReductionPercent
    )} less rebuffering.`;

  ui.comparisonBody.innerHTML = "";
  traceRows.forEach((row, index) => {
    const rowClasses = [];
    if (row.algorithmId === "soda") {
      rowClasses.push("comparison-row-soda");
    }
    if (row.algorithmId === selectedAlgorithmId) {
      rowClasses.push("comparison-row-active");
    }
    if (index === 0) {
      rowClasses.push("comparison-row-best");
    }

    const tableRow = document.createElement("tr");
    tableRow.className = rowClasses.join(" ");
    tableRow.innerHTML = `
      <td>${row.algorithmLabel}</td>
      <td>${row.meanUtility.toFixed(3)}</td>
      <td>${formatPercent(row.rebufferRatio, 2)}</td>
      <td>${formatPercent(row.switchingRate, 2)}</td>
      <td>${row.qoe.toFixed(3)}</td>
      <td>${row.averageBitrate.toFixed(2)} Mbps</td>
      <td>${row.totalStallSeconds.toFixed(2)}</td>
    `;
    ui.comparisonBody.appendChild(tableRow);
  });
}

function renderAll() {
  renderProcessInterface();
  renderComparisonShowdown();
  renderComparisonTable();
}

function attachPreviewLoadedMetadataHandler(preview, sessionGetter, isRunningGetter) {
  preview.video.addEventListener("loadedmetadata", () => {
    const session = sessionGetter();
    syncPreviewToSnapshot(preview, getSessionSnapshot(session), isRunningGetter());
    if (isRunningGetter()) {
      playPreview(preview);
    }
  });
}

async function init() {
  [traceCatalog, batchResults] = await Promise.all([
    loadTraceCatalog("../traces"),
    loadBatchResults(),
  ]);

  populateSelectors();

  processState.traceId = traceCatalog[0].id;
  comparisonState.traceId = traceCatalog[0].id;

  ui.processAlgorithmSelect.value = processState.algorithmId;
  ui.processScenarioSelect.value = processState.traceId;
  ui.compareAlgorithmSelect.value = comparisonState.baselineAlgorithmId;
  ui.compareScenarioSelect.value = comparisonState.traceId;

  attachPreviewLoadedMetadataHandler(
    previews.process,
    () => processState.session,
    () => Boolean(processState.timerId)
  );
  attachPreviewLoadedMetadataHandler(
    previews.compareLeft,
    () => comparisonState.sodaSession,
    () => Boolean(comparisonState.timerId)
  );
  attachPreviewLoadedMetadataHandler(
    previews.compareRight,
    () => comparisonState.baselineSession,
    () => Boolean(comparisonState.timerId)
  );

  buildProcessSession();
  buildComparisonSessions();
  setActiveScreen(activeScreen);

  ui.screenTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveScreen(tab.dataset.screenTarget);
    });
  });

  ui.processAlgorithmSelect.addEventListener("change", () => {
    processState.algorithmId = ui.processAlgorithmSelect.value;
    resetProcessSession();
  });
  ui.processScenarioSelect.addEventListener("change", () => {
    processState.traceId = ui.processScenarioSelect.value;
    resetProcessSession();
  });
  ui.processStartBtn.addEventListener("click", startProcessLoop);
  ui.processPauseBtn.addEventListener("click", () => pauseProcessLoop());
  ui.processResetBtn.addEventListener("click", resetProcessSession);
  ui.processVideoUpload.addEventListener("change", handleProcessVideoSelection);
  ui.processClearVideoBtn.addEventListener("click", () => clearProcessVideo());

  ui.compareAlgorithmSelect.addEventListener("change", () => {
    comparisonState.baselineAlgorithmId = ui.compareAlgorithmSelect.value;
    resetComparisonSession();
  });
  ui.compareScenarioSelect.addEventListener("change", () => {
    comparisonState.traceId = ui.compareScenarioSelect.value;
    resetComparisonSession();
  });
  ui.compareStartBtn.addEventListener("click", startComparisonLoop);
  ui.comparePauseBtn.addEventListener("click", () => pauseComparisonLoop());
  ui.compareResetBtn.addEventListener("click", resetComparisonSession);
  ui.compareLeftVideoUpload.addEventListener("change", (event) =>
    handleComparisonVideoSelection("left", event)
  );
  ui.compareRightVideoUpload.addEventListener("change", (event) =>
    handleComparisonVideoSelection("right", event)
  );
  ui.compareLeftClearBtn.addEventListener("click", () => clearComparisonVideo("left"));
  ui.compareRightClearBtn.addEventListener("click", () => clearComparisonVideo("right"));

  window.addEventListener("beforeunload", () => {
    processState.videoUrl = revokeVideoUrl(processState.videoUrl);
    comparisonState.leftVideoUrl = revokeVideoUrl(comparisonState.leftVideoUrl);
    comparisonState.rightVideoUrl = revokeVideoUrl(comparisonState.rightVideoUrl);
  });
  window.addEventListener("resize", renderAll);
}

init();
