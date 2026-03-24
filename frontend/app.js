import { createMovingAveragePredictor } from "./core/predictor.js";
import { ABR_ALGORITHMS } from "./core/algorithms.js";
import { AbrSimulator, BITRATE_LADDER_MBPS, CHUNK_DURATION } from "./core/simulator.js";
import { createMetricsTracker, formatSummaryMetrics } from "./core/metrics.js";
import { loadTraceCatalog } from "./core/traces.js";

const STEP_INTERVAL_MS = 650;
const VISUAL_PLAYBACK_RATE = CHUNK_DURATION / (STEP_INTERVAL_MS / 1000);
const BASELINE_SELECTION_HINT =
  "Select HYB-like, BOLA-like, or Greedy to place it against SODA.";
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
  algorithmSelect: document.querySelector("#algorithm-select"),
  scenarioSelect: document.querySelector("#scenario-select"),
  startBtn: document.querySelector("#start-btn"),
  pauseBtn: document.querySelector("#pause-btn"),
  resetBtn: document.querySelector("#reset-btn"),
  videoUpload: document.querySelector("#video-upload"),
  clearVideoBtn: document.querySelector("#clear-video-btn"),
  scenarioDescription: document.querySelector("#scenario-description"),
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
  main: createPreviewController({
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
    emptyMessage: "Upload a local video to start the side-by-side comparison.",
  }),
  compareRight: createPreviewController({
    root: document.querySelector("#compare-right-preview"),
    video: document.querySelector("#compare-right-video"),
    emptyState: document.querySelector("#compare-right-empty"),
    qualityBadge: document.querySelector("#compare-right-quality"),
    statusCopy: document.querySelector("#compare-right-status"),
    stallOverlay: document.querySelector("#compare-right-stall"),
    emptyMessage: BASELINE_SELECTION_HINT,
  }),
};

let traceCatalog = [];
let batchResults = null;
let mainSession = null;
let compareSodaSession = null;
let timerId = null;
let localVideoUrl = null;

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

function populateSelectors() {
  Object.entries(ABR_ALGORITHMS).forEach(([id, spec]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = spec.label;
    ui.algorithmSelect.appendChild(option);
  });

  traceCatalog.forEach((trace) => {
    const option = document.createElement("option");
    option.value = trace.id;
    option.textContent = trace.label;
    ui.scenarioSelect.appendChild(option);
  });
}

function getSelectedTrace() {
  return traceCatalog.find((trace) => trace.id === ui.scenarioSelect.value);
}

function getSelectedAlgorithmSpec() {
  return ABR_ALGORITHMS[ui.algorithmSelect.value];
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

function createAbrSession(algorithmId, trace) {
  const algorithmSpec = ABR_ALGORITHMS[algorithmId];
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

function syncPreviewToSnapshot(preview, snapshot) {
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

  if (!timerId || preview.stallActive || drift > 0.65) {
    try {
      preview.video.currentTime = targetTime;
    } catch {
      // Ignore occasional browser seek rejections during fast updates.
    }
  }
}

function renderPreview(preview, snapshot, statusText) {
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
  syncPreviewToSnapshot(preview, snapshot);
}

function triggerPreviewStall(preview, stallSeconds) {
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
    if (timerId) {
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
    { label: "Mean utility", value: summary.meanUtility.toFixed(3) },
  ];

  container.innerHTML = "";
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "compare-summary-card";
    card.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong>`;
    container.appendChild(card);
  });
}

function getShowdownLeftSession() {
  return mainSession?.algorithmId === "soda" ? mainSession : compareSodaSession;
}

function getShowdownRightSession() {
  return mainSession?.algorithmId === "soda" ? null : mainSession;
}

function syncPreviewSources() {
  const rightShowdownSession = getShowdownRightSession();
  setPreviewSource(previews.main, localVideoUrl, previews.main.emptyMessage);
  setPreviewSource(previews.compareLeft, localVideoUrl, previews.compareLeft.emptyMessage);
  setPreviewSource(
    previews.compareRight,
    rightShowdownSession ? localVideoUrl : null,
    rightShowdownSession ? previews.compareRight.emptyMessage : BASELINE_SELECTION_HINT
  );
}

function clearAllPreviewStalls() {
  Object.values(previews).forEach(clearPreviewStall);
}

function pauseAllPreviews() {
  Object.values(previews).forEach(pausePreview);
}

function playActivePreviews() {
  playPreview(previews.main);
  playPreview(previews.compareLeft);
  if (getShowdownRightSession()) {
    playPreview(previews.compareRight);
  }
}

function resetAllPreviewPlayback() {
  Object.values(previews).forEach(resetPreviewPlayback);
}

function revokeLocalVideoUrl() {
  if (!localVideoUrl) {
    return;
  }
  URL.revokeObjectURL(localVideoUrl);
  localVideoUrl = null;
}

function clearLocalVideo({ clearInput = true } = {}) {
  clearAllPreviewStalls();
  pauseAllPreviews();
  revokeLocalVideoUrl();
  syncPreviewSources();
  if (clearInput) {
    ui.videoUpload.value = "";
  }
  renderAll();
}

function handleVideoSelection(event) {
  const [file] = event.target.files ?? [];
  if (!file) {
    return;
  }

  clearAllPreviewStalls();
  pauseAllPreviews();
  revokeLocalVideoUrl();
  localVideoUrl = URL.createObjectURL(file);
  syncPreviewSources();
  renderAll();
}

function buildSessions() {
  const trace = getSelectedTrace();
  const selectedAlgorithmId = ui.algorithmSelect.value;
  const algorithmSpec = getSelectedAlgorithmSpec();

  mainSession = createAbrSession(selectedAlgorithmId, trace);
  compareSodaSession =
    selectedAlgorithmId === "soda" ? null : createAbrSession("soda", trace);

  ui.sessionTitle.textContent = `${algorithmSpec.label} on ${trace.label}`;
  ui.scenarioDescription.textContent = `${algorithmSpec.description} ${trace.description}`;

  clearAllPreviewStalls();
  resetAllPreviewPlayback();
  syncPreviewSources();
  renderAll();
}

function startLoop() {
  if (!mainSession || timerId || mainSession.simulator.isFinished()) {
    return;
  }
  timerId = window.setInterval(stepSessions, STEP_INTERVAL_MS);
  playActivePreviews();
  renderAll();
}

function pauseLoop() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }
  clearAllPreviewStalls();
  pauseAllPreviews();
  renderAll();
}

function resetSession() {
  pauseLoop();
  buildSessions();
}

function stepSessions() {
  if (!mainSession || mainSession.simulator.isFinished()) {
    pauseLoop();
    return;
  }

  const mainChunk = stepAbrSession(mainSession);
  const sodaChunk = stepAbrSession(compareSodaSession);
  const leftChunk = mainSession.algorithmId === "soda" ? mainChunk : sodaChunk;
  const rightChunk = getShowdownRightSession() ? mainChunk : null;

  if (mainChunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.main, mainChunk.stallSeconds);
  }

  if (leftChunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.compareLeft, leftChunk.stallSeconds);
  }

  if (rightChunk?.stallSeconds > 0) {
    triggerPreviewStall(previews.compareRight, rightChunk.stallSeconds);
  }

  renderAll();

  if (mainSession.simulator.isFinished()) {
    pauseLoop();
  }
}

function getPreviewStatusText(session, preview, label) {
  if (!session) {
    return "Select HYB-like, BOLA-like, or Greedy to activate this lane.";
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

  if (timerId) {
    return `${label} is replaying the same trace under synchronized timing.`;
  }

  return `${label} is paused. Use Start to continue the comparison.`;
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

function renderMainStage() {
  const snapshot = getSessionSnapshot(mainSession);
  const summary = getSessionSummary(mainSession);

  ui.currentBitrate.textContent = `${snapshot.currentBitrateMbps.toFixed(2)} Mbps`;
  ui.currentThroughput.textContent = `${snapshot.lastThroughputMbps.toFixed(2)} Mbps`;
  ui.currentBuffer.textContent = `${snapshot.bufferSeconds.toFixed(1)} s`;
  ui.playbackPosition.textContent = `Playback ${snapshot.playbackPosition.toFixed(1)} s`;
  ui.elapsedTime.textContent = `Elapsed ${snapshot.elapsedTime.toFixed(1)} s`;

  const traceDuration = snapshot.totalChunks * CHUNK_DURATION;
  ui.playbackProgress.style.width = `${Math.min(100, (snapshot.playbackPosition / traceDuration) * 100)}%`;
  ui.bufferProgress.style.width = `${Math.min(100, (snapshot.bufferSeconds / mainSession.simulator.maxBuffer) * 100)}%`;

  const isStalling = snapshot.lastStallSeconds > 0;
  ui.stallIndicator.textContent = isStalling
    ? `Stalling ${snapshot.lastStallSeconds.toFixed(1)} s`
    : "Smooth";
  ui.stallIndicator.classList.toggle("stalling", isStalling);

  renderMainMetrics(summary);
  renderDecisionLog(snapshot.history);
  renderPreview(
    previews.main,
    snapshot,
    getPreviewStatusText(mainSession, previews.main, mainSession.algorithmSpec.label)
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
    maxValue: mainSession.simulator.maxBuffer,
    style: chartStyles.buffer,
    stalls: snapshot.history,
  });
}

function renderShowdownStage() {
  const leftSession = getShowdownLeftSession();
  const rightSession = getShowdownRightSession();
  const trace = getSelectedTrace();

  ui.compareLeftLabel.textContent = "SODA (paper reproduction)";
  ui.compareRightLabel.textContent = rightSession
    ? rightSession.algorithmSpec.label
    : "Choose a baseline";

  if (rightSession) {
    ui.showdownTitle.textContent = `SODA vs ${rightSession.algorithmSpec.label} on ${trace.label}`;
    ui.showdownCopy.textContent =
      "Both panes replay the same local video under the same trace. The only difference is the ABR controller.";
  } else {
    ui.showdownTitle.textContent = "Select a non-SODA algorithm to activate the right lane";
    ui.showdownCopy.textContent =
      "The left lane always stays on SODA. Choose HYB-like, BOLA-like, or Greedy to create a true side-by-side showdown.";
  }

  renderPreview(
    previews.compareLeft,
    getSessionSnapshot(leftSession),
    getPreviewStatusText(leftSession, previews.compareLeft, "SODA")
  );
  renderSummaryCards(
    ui.compareLeftSummary,
    getSessionSummary(leftSession),
    "SODA metrics will appear here once the session is initialized."
  );

  renderPreview(
    previews.compareRight,
    getSessionSnapshot(rightSession),
    getPreviewStatusText(rightSession, previews.compareRight, rightSession?.algorithmSpec.label ?? "The right lane")
  );
  renderSummaryCards(
    ui.compareRightSummary,
    getSessionSummary(rightSession),
    BASELINE_SELECTION_HINT
  );
}

function renderComparisonTable() {
  const selectedTrace = getSelectedTrace();
  const selectedAlgorithmId = ui.algorithmSelect.value;

  if (!batchResults || !selectedTrace) {
    ui.comparisonTitle.textContent = "Batch evaluation unavailable";
    ui.comparisonCopy.textContent =
      "Run `npm run eval` in the project root to regenerate the offline comparison results.";
    ui.comparisonHighlights.innerHTML = "";
    ui.comparisonBody.innerHTML = "";
    ui.solverNote.textContent =
      "The live simulator still works, but the paper-style summary table depends on generated result artifacts.";
    return;
  }

  const traceRows = batchResults.byTrace[selectedTrace.id] ?? [];
  const overview = batchResults.overview;
  const aggregateById = Object.fromEntries(
    batchResults.aggregate.map((row) => [row.algorithmId, row])
  );

  ui.comparisonTitle.textContent = `Paper-style comparison on ${selectedTrace.label}`;
  ui.comparisonCopy.textContent =
    "Rows are ranked by paper QoE = mean utility - 10 × rebuffer ratio - switching rate.";

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
    const tableRow = document.createElement("tr");
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
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight / 4) * i;
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

function renderAll() {
  if (!mainSession) {
    return;
  }
  renderMainStage();
  renderShowdownStage();
  renderComparisonTable();
}

function attachPreviewLoadedMetadataHandler(preview, sessionGetter) {
  preview.video.addEventListener("loadedmetadata", () => {
    const session = sessionGetter();
    syncPreviewToSnapshot(preview, getSessionSnapshot(session));
    if (timerId) {
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
  ui.algorithmSelect.value = "soda";
  ui.scenarioSelect.value = traceCatalog[0].id;

  attachPreviewLoadedMetadataHandler(previews.main, () => mainSession);
  attachPreviewLoadedMetadataHandler(previews.compareLeft, () => getShowdownLeftSession());
  attachPreviewLoadedMetadataHandler(previews.compareRight, () => getShowdownRightSession());

  buildSessions();

  ui.algorithmSelect.addEventListener("change", resetSession);
  ui.scenarioSelect.addEventListener("change", resetSession);
  ui.startBtn.addEventListener("click", startLoop);
  ui.pauseBtn.addEventListener("click", pauseLoop);
  ui.resetBtn.addEventListener("click", resetSession);
  ui.videoUpload.addEventListener("change", handleVideoSelection);
  ui.clearVideoBtn.addEventListener("click", () => clearLocalVideo());
  window.addEventListener("beforeunload", () => {
    revokeLocalVideoUrl();
  });
  window.addEventListener("resize", renderAll);
}

init();
