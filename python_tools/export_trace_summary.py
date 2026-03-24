from __future__ import annotations

import csv
import json
from pathlib import Path
from statistics import mean


ROOT = Path(__file__).resolve().parents[1]
TRACE_DIR = ROOT / "traces"
RESULTS_DIR = ROOT / "results"


def load_trace(path: Path) -> list[float]:
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return [float(row["throughput_mbps"]) for row in reader]


def summarize_trace(samples: list[float]) -> dict[str, float]:
    return {
        "count": len(samples),
        "min_mbps": min(samples),
        "max_mbps": max(samples),
        "avg_mbps": mean(samples),
        "below_2mbps_ratio": sum(value < 2.0 for value in samples) / len(samples),
    }


def main() -> None:
    RESULTS_DIR.mkdir(exist_ok=True)
    summary = {}
    for path in sorted(TRACE_DIR.glob("*.csv")):
        summary[path.stem] = summarize_trace(load_trace(path))

    output_path = RESULTS_DIR / "trace_summary.json"
    output_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
