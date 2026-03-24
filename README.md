# SODA Paper Reproduction with Trace-Replayed Network Scenarios

## Project overview

This project is a browser-based reproduction of the SODA paper for a course
presentation. Instead of starting with full network emulation, it replays
predefined throughput traces chunk by chunk and shows how four ABR algorithms
respond over time:

- a SODA controller with time-based horizon planning
- a HYB-like throughput baseline
- a BOLA-like buffer baseline
- a greedy throughput baseline

The demo is designed to be realistic enough for discussion, while staying
simple to run locally from a static server.

## Folder structure

```text
frontend/
  index.html
  style.css
  app.js
  abr/
    soda.js
    hyb.js
    bola_like.js
    greedy.js
  core/
    algorithms.js
    predictor.js
    simulator.js
    metrics.js
    trace_catalog.js
    traces.js
  assets/
traces/
  stable_trace.csv
  volatile_trace.csv
  deep_drop_trace.csv
python_tools/
  export_trace_summary.py
  optional_batch_eval.py
scripts/
  batch_eval.js
results/
README.md
DEMO_NOTES.md
```

## How to run locally

1. Open a terminal in the project root.
2. Generate the paper-style comparison artifacts:

```bash
npm run eval
```

3. Start a static server:

```bash
python -m http.server 8000
```

4. Open `http://localhost:8000/frontend/` in a browser.

The frontend uses ES modules and `fetch()` for the CSV traces, so it should be
served over HTTP rather than opened directly as a file.

## Demo behavior

The session progresses one chunk at a time with:

- bitrate ladder: `[0.3, 0.75, 1.2, 1.85, 2.85, 4.3, 6.0]` Mbps
- chunk duration: `2.0` seconds
- moving-average throughput prediction
- chunk download timing derived from `chunk_size / trace_throughput`
- buffer updates and rebuffer events computed after every chunk

The UI includes:

- algorithm selector
- scenario selector
- local video upload for visual playback demonstration
- side-by-side SODA vs baseline video showdown
- start, pause, and reset controls
- playback panel with timeline and status
- live charts for throughput, bitrate, and buffer
- chunk decision log
- summary metrics using the paper-style utility/rebuffer/switching QoE

## Local video demonstration

To make the algorithm differences easier to present, the frontend supports a
single local video upload that feeds both the main player and a synchronized
side-by-side showdown:

1. Open `http://localhost:8000/frontend/`
2. Upload a local video from the `Local video preview` control
3. Choose a trace
4. Choose an algorithm
5. Press `Start`

The main playback panel follows the currently selected algorithm. The showdown
panel keeps SODA on the left and places the selected non-SODA algorithm on the
right so both panes replay the same local video under the same trace timing.
If you leave the selector on SODA, the right lane stays in standby.
The demo maps simulated bitrate decisions to visual quality degradation while
freezing playback during rebuffer events. This is meant for presentation and
intuition; it is not a full multi-rendition DASH playback stack.

## ABR algorithms

### SODA paper reproduction

The reproduced SODA controller follows the paper at a practical demo level:

- a time-based objective over a 5-step prediction horizon
- distortion minimization through bitrate-dependent cost
- asymmetric buffer stabilization around a target level
- explicit switching cost against the previous bitrate
- monotonic sequence search as the polynomial-time approximation

Only the first bitrate in the planned horizon is committed, matching the
paper’s receding-horizon design.

### HYB-like throughput baseline

The HYB-like baseline chooses the highest bitrate whose predicted download time
fits inside the currently available buffer.

### BOLA-like buffer baseline

The BOLA-like baseline maps normalized buffer occupancy to bitrate utility while
discouraging aggressive switching.

### Greedy throughput baseline

The greedy baseline predicts throughput using a moving average and selects the
highest bitrate that is below a safety-adjusted predicted throughput.

## Scenarios

- `Stable`: modest variations around a comfortable operating region
- `Volatile`: frequent sharp swings that test responsiveness and stability
- `Deep Drop`: a pronounced sustained degradation followed by recovery

Switch scenarios from the dropdown in the control panel. Switch algorithms from
the adjacent selector, then use `Start`, `Pause`, or `Reset`.

## Metrics shown

The demo reports:

- estimated throughput
- selected bitrate
- current buffer
- stall/rebuffer status
- paper QoE score
- mean utility
- rebuffer ratio
- switching rate
- average bitrate
- total stall time
- number of bitrate switches

## Offline evaluation

The canonical offline evaluator is:

- `scripts/batch_eval.js`
  - reuses the same controller implementations as the frontend
  - writes `results/batch_eval.json` for the comparison panel
  - writes `results/batch_eval.csv` for tabular inspection

The Python scripts remain optional helpers for trace inspection.

## Extension path

This demo is intentionally modular so it can be extended later in two directions.

### dash.js custom ABR integration

- reuse the adaptation logic in `frontend/abr/`
- replace the browser-side simulator with real segment download observations
- map dash.js player metrics to the same controller input fields
- keep the visualization layer for live debugging and presentation

### Linux `tc netem` integration

- keep the same trace files as scenario definitions
- translate traces into bandwidth-delay-loss schedules
- run a real DASH player or local video server through those network conditions
- compare simulator outcomes against real-player behavior

## Notes on reproducibility

- no frontend framework is required
- traces are plain CSV files
- no external package installation is needed for the browser demo
- the implementation prioritizes readability and course-demo clarity over a full
  production ABR stack
