import { TRACE_DEFINITIONS } from "./trace_catalog.js";

async function loadCsvSamples(url) {
  const response = await fetch(url);
  const text = await response.text();
  return text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [, throughputMbps] = line.split(",");
      return Number.parseFloat(throughputMbps);
    });
}

export async function loadTraceCatalog(basePath) {
  const traces = [];
  for (const definition of TRACE_DEFINITIONS) {
    const samples = await loadCsvSamples(`${basePath}/${definition.file}`);
    traces.push({
      ...definition,
      samples,
    });
  }
  return traces;
}
