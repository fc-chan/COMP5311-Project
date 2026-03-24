import { createMovingAveragePredictor } from "./core/predictor.js";
import { ABR_ALGORITHMS } from "./core/algorithms.js";
import { AbrSimulator, BITRATE_LADDER_MBPS, CHUNK_DURATION } from "./core/simulator.js";
import { createMetricsTracker, formatSummaryMetrics } from "./core/metrics.js";
import { loadTraceCatalog } from "./core/traces.js";

const ui = {
  algorithmSelect: document.querySelector("#algorithm-select"),
  scenarioSelect: document.querySelector("#scenario-select"),
  startBtn: document.querySelector("#start-btn"),
  pauseBtn: document.querySelector("#pause-btn"),
  resetBtn: document.querySelector("#reset-btn"),
  scenarioDescription: document.querySelector("#scenario-description"),
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

let traceCatalog = [];
let batchResults = null;
let simulator = null;
let predictor = null;
let controller = null;
let metrics = null;
let timerId = null;

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

function buildSession() {
  const trace = getSelectedTrace();
  const algorithmSpec = getSelectedAlgorithmSpec();
  predictor = createMovingAveragePredictor({ windowSize: 5, defaultValue: 2.2 });
  controller = algorithmSpec.factory();
  simulator = new AbrSimulator({
    trace,
    chunkDuration: CHUNK_DURATION,
    bitrateLadderMbps: BITRATE_LADDER_MBPS,
    startupBuffer: 4,
    maxBuffer: 20,
  });
  metrics = createMetricsTracker({
    traceId: trace.id,
    algorithmId: ui.algorithmSelect.value,
    chunkDuration: CHUNK_DURATION,
    bitrateLadderMbps: BITRATE_LADDER_MBPS,
  });
  ui.sessionTitle.textContent = `${algorithmSpec.label} on ${trace.label}`;
  ui.scenarioDescription.textContent = `${algorithmSpec.description} ${trace.description}`;
  renderComparison();
  render();
}

function startLoop() {
  if (timerId || simulator.isFinished()) {
    return;
  }
  timerId = window.setInterval(stepSession, 650);
}

function pauseLoop() {
  if (!timerId) {
    return;
  }
  window.clearInterval(timerId);
  timerId = null;
}

function resetSession() {
  pauseLoop();
  buildSession();
}

function stepSession() {
  if (simulator.isFinished()) {
    pauseLoop();
    render();
    return;
  }

  const predictedThroughput = predictor.predict();
  const decisionContext = simulator.buildDecisionContext({
    predictedThroughput,
    previousBitrateIndex: simulator.getLastBitrateIndex(),
  });
  const bitrateIndex = controller.selectBitrateIndex(decisionContext);
  const chunkResult = simulator.downloadNextChunk({
    bitrateIndex,
    predictedThroughput,
  });
  predictor.pushSample(chunkResult.actualThroughputMbps);
  metrics.recordChunk(chunkResult);
  render();

  if (simulator.isFinished()) {
    pauseLoop();
  }
}

function render() {
  const snapshot = simulator.getSnapshot();
  const summary = formatSummaryMetrics(metrics.getSummary(snapshot));
  ui.currentBitrate.textContent = `${snapshot.currentBitrateMbps.toFixed(2)} Mbps`;
  ui.currentThroughput.textContent = `${snapshot.lastThroughputMbps.toFixed(2)} Mbps`;
  ui.currentBuffer.textContent = `${snapshot.bufferSeconds.toFixed(1)} s`;
  ui.playbackPosition.textContent = `Playback ${snapshot.playbackPosition.toFixed(1)} s`;
  ui.elapsedTime.textContent = `Elapsed ${snapshot.elapsedTime.toFixed(1)} s`;

  const traceDuration = snapshot.totalChunks * CHUNK_DURATION;
  ui.playbackProgress.style.width = `${Math.min(100, (snapshot.playbackPosition / traceDuration) * 100)}%`;
  ui.bufferProgress.style.width = `${Math.min(100, (snapshot.bufferSeconds / simulator.maxBuffer) * 100)}%`;

  const isStalling = snapshot.lastStallSeconds > 0;
  ui.stallIndicator.textContent = isStalling ? `Stalling ${snapshot.lastStallSeconds.toFixed(1)} s` : "Smooth";
  ui.stallIndicator.classList.toggle("stalling", isStalling);

  renderMetrics(summary);
  renderDecisionLog(snapshot.history);
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
    maxValue: simulator.maxBuffer,
    style: chartStyles.buffer,
    stalls: snapshot.history,
  });
}

function renderMetrics(summary) {
  ui.metricsGrid.innerHTML = "";
  summary.forEach((item) => {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong>`;
    ui.metricsGrid.appendChild(card);
  });
}

function renderComparison() {
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

async function init() {
  [traceCatalog, batchResults] = await Promise.all([
    loadTraceCatalog("../traces"),
    loadBatchResults(),
  ]);
  populateSelectors();
  ui.algorithmSelect.value = "soda";
  ui.scenarioSelect.value = traceCatalog[0].id;
  buildSession();

  ui.algorithmSelect.addEventListener("change", resetSession);
  ui.scenarioSelect.addEventListener("change", resetSession);
  ui.startBtn.addEventListener("click", startLoop);
  ui.pauseBtn.addEventListener("click", pauseLoop);
  ui.resetBtn.addEventListener("click", resetSession);
  window.addEventListener("resize", render);
}

init();
