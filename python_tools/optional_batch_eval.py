from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    print("Delegating to the canonical evaluator: npm run eval")
    completed = subprocess.run(["npm", "run", "eval"], cwd=ROOT)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
