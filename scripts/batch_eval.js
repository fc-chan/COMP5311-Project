import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listAbrAlgorithms } from "../frontend/core/algorithms.js";
import { TRACE_DEFINITIONS } from "../frontend/core/trace_catalog.js";
import { createMovingAveragePredictor } from "../frontend/core/predictor.js";
import { AbrSimulator, BITRATE_LADDER_MBPS, CHUNK_DURATION } from "../frontend/core/simulator.js";
import { PAPER_QOE_WEIGHTS, summarizeRecords } from "../frontend/core/metrics.js";
import { solveSodaDecision, solveSodaDecisionExact } from "../frontend/abr/soda.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TRACE_DIR = path.join(ROOT, "traces");
const RESULTS_DIR = path.join(ROOT, "results");

async function loadTrace(definition) {
  const csvText = await fs.readFile(path.join(TRACE_DIR, definition.file), "utf8");
  const samples = csvText
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => Number.parseFloat(line.split(",")[1]));

  return {
    ...definition,
    samples,
  };
}

async function loadTraces() {
  return Promise.all(TRACE_DEFINITIONS.map((definition) => loadTrace(definition)));
}

function runControllerOnTrace(trace, algorithmSpec) {
  const controller = algorithmSpec.factory();
  const predictor = createMovingAveragePredictor({ windowSize: 5, defaultValue: 2.2 });
  const simulator = new AbrSimulator({
    trace,
    chunkDuration: CHUNK_DURATION,
    bitrateLadderMbps: BITRATE_LADDER_MBPS,
    startupBuffer: 4,
    maxBuffer: 20,
  });

  while (!simulator.isFinished()) {
    const predictedThroughput = predictor.predict();
    const context = simulator.buildDecisionContext({
      predictedThroughput,
      previousBitrateIndex: simulator.getLastBitrateIndex(),
    });
    const bitrateIndex = controller.selectBitrateIndex(context);
    const result = simulator.downloadNextChunk({
      bitrateIndex,
      predictedThroughput,
    });
    predictor.pushSample(result.actualThroughputMbps);
  }

  const summary = summarizeRecords({
    records: simulator.history,
    traceId: trace.id,
    algorithmId: algorithmSpec.id,
    chunkDuration: CHUNK_DURATION,
    bitrateLadderMbps: BITRATE_LADDER_MBPS,
    qoeWeights: PAPER_QOE_WEIGHTS,
    totalChunks: trace.samples.length,
  });

  return {
    ...summary,
    traceLabel: trace.label,
    algorithmLabel: algorithmSpec.label,
  };
}

function aggregateRows(rows, algorithmSpecs) {
  return algorithmSpecs.map((algorithmSpec) => {
    const matchingRows = rows.filter((row) => row.algorithmId === algorithmSpec.id);
    const count = matchingRows.length;
    const summed = matchingRows.reduce(
      (acc, row) => ({
        qoe: acc.qoe + row.qoe,
        meanUtility: acc.meanUtility + row.meanUtility,
        rebufferRatio: acc.rebufferRatio + row.rebufferRatio,
        switchingRate: acc.switchingRate + row.switchingRate,
        averageBitrate: acc.averageBitrate + row.averageBitrate,
        totalStallSeconds: acc.totalStallSeconds + row.totalStallSeconds,
        switchCount: acc.switchCount + row.switchCount,
      }),
      {
        qoe: 0,
        meanUtility: 0,
        rebufferRatio: 0,
        switchingRate: 0,
        averageBitrate: 0,
        totalStallSeconds: 0,
        switchCount: 0,
      }
    );

    return {
      algorithmId: algorithmSpec.id,
      algorithmLabel: algorithmSpec.label,
      traceCount: count,
      qoe: summed.qoe / count,
      meanUtility: summed.meanUtility / count,
      rebufferRatio: summed.rebufferRatio / count,
      switchingRate: summed.switchingRate / count,
      averageBitrate: summed.averageBitrate / count,
      totalStallSeconds: summed.totalStallSeconds,
      switchCount: summed.switchCount,
    };
  });
}

function buildSolverComparison(traces) {
  const contexts = [];

  traces.forEach((trace) => {
    const predictor = createMovingAveragePredictor({ windowSize: 5, defaultValue: 2.2 });
    const simulator = new AbrSimulator({
      trace,
      chunkDuration: CHUNK_DURATION,
      bitrateLadderMbps: BITRATE_LADDER_MBPS,
      startupBuffer: 4,
      maxBuffer: 20,
    });

    while (!simulator.isFinished()) {
      const predictedThroughput = predictor.predict();
      const context = simulator.buildDecisionContext({
        predictedThroughput,
        previousBitrateIndex: simulator.getLastBitrateIndex(),
      });
      contexts.push(context);

      const bitrateIndex = solveSodaDecision(context).bitrateIndex;
      const result = simulator.downloadNextChunk({
        bitrateIndex,
        predictedThroughput,
      });
      predictor.pushSample(result.actualThroughputMbps);
    }
  });

  let agreementCount = 0;
  let approxTrajectories = 0;
  let exactTrajectories = 0;

  contexts.forEach((context) => {
    const approx = solveSodaDecision(context);
    const exact = solveSodaDecisionExact(context);
    agreementCount += Number(approx.bitrateIndex === exact.bitrateIndex);
    approxTrajectories += approx.evaluatedTrajectories;
    exactTrajectories += exact.evaluatedTrajectories;
  });

  return {
    sampledContexts: contexts.length,
    agreementRate: agreementCount / contexts.length,
    averageApproxTrajectories: approxTrajectories / contexts.length,
    averageExactTrajectories: exactTrajectories / contexts.length,
    speedup: exactTrajectories / Math.max(1, approxTrajectories),
  };
}

function buildOverview(aggregateRowsByAlgorithm, solverComparison) {
  const soda = aggregateRowsByAlgorithm.find((row) => row.algorithmId === "soda");
  const bestBaseline = aggregateRowsByAlgorithm
    .filter((row) => row.algorithmId !== "soda")
    .sort((left, right) => right.qoe - left.qoe)[0];
  const bola = aggregateRowsByAlgorithm.find((row) => row.algorithmId === "bola");
  const greedy = aggregateRowsByAlgorithm.find((row) => row.algorithmId === "greedy");

  return {
    bestOverallAlgorithmId: aggregateRowsByAlgorithm.sort((left, right) => right.qoe - left.qoe)[0]
      .algorithmId,
    sodaVsBestBaseline: {
      baselineAlgorithmId: bestBaseline.algorithmId,
      baselineAlgorithmLabel: bestBaseline.algorithmLabel,
      qoeGainPercent: ((soda.qoe - bestBaseline.qoe) / Math.abs(bestBaseline.qoe)) * 100,
    },
    sodaVsBola: {
      switchingReductionPercent:
        ((bola.switchingRate - soda.switchingRate) / Math.max(bola.switchingRate, 1e-9)) * 100,
    },
    sodaVsGreedy: {
      rebufferReductionPercent:
        ((greedy.rebufferRatio - soda.rebufferRatio) / Math.max(greedy.rebufferRatio, 1e-9)) * 100,
    },
    solverComparison,
  };
}

function toCsv(rows) {
  const header = [
    "algorithm_id",
    "algorithm_label",
    "trace_id",
    "trace_label",
    "mean_utility",
    "rebuffer_ratio",
    "switching_rate",
    "qoe",
    "avg_bitrate_mbps",
    "total_stall_s",
    "switches",
  ];
  const body = rows.map((row) =>
    [
      row.algorithmId,
      row.algorithmLabel,
      row.traceId,
      row.traceLabel,
      row.meanUtility.toFixed(6),
      row.rebufferRatio.toFixed(6),
      row.switchingRate.toFixed(6),
      row.qoe.toFixed(6),
      row.averageBitrate.toFixed(6),
      row.totalStallSeconds.toFixed(6),
      row.switchCount,
    ].join(",")
  );

  return `${header.join(",")}\n${body.join("\n")}\n`;
}

async function main() {
  const traces = await loadTraces();
  const algorithmSpecs = listAbrAlgorithms();
  const rows = [];

  traces.forEach((trace) => {
    algorithmSpecs.forEach((algorithmSpec) => {
      rows.push(runControllerOnTrace(trace, algorithmSpec));
    });
  });

  const aggregate = aggregateRows(rows, algorithmSpecs);
  const byTrace = Object.fromEntries(
    traces.map((trace) => [
      trace.id,
      rows
        .filter((row) => row.traceId === trace.id)
        .sort((left, right) => right.qoe - left.qoe),
    ])
  );
  const solverComparison = buildSolverComparison(traces);
  const overview = buildOverview([...aggregate], solverComparison);
  const payload = {
    generatedAt: new Date().toISOString(),
    qoeWeights: PAPER_QOE_WEIGHTS,
    aggregate,
    rows,
    byTrace,
    overview,
  };

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.writeFile(path.join(RESULTS_DIR, "batch_eval.json"), JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join(RESULTS_DIR, "batch_eval.csv"), toCsv(rows));
  console.log(`Wrote ${path.join(RESULTS_DIR, "batch_eval.json")}`);
  console.log(`Wrote ${path.join(RESULTS_DIR, "batch_eval.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
