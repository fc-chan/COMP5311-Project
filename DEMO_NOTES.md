# Demo Notes

## What is realistic about this demo

This project captures several core ingredients of real ABR streaming:

- decisions are made chunk by chunk rather than once for the entire session
- throughput varies according to replayed traces instead of staying constant
- chunk download time depends on both chunk bitrate and network capacity
- the player buffer evolves over time and can drain into rebuffering
- multiple ABR strategies can be compared on the same underlying conditions

These elements are enough to demonstrate the main tradeoffs between caution,
quality, smoothness, and robustness.

## What is still simplified

The current demo does not yet emulate a full DASH stack. In particular:

- no encoded video segments are downloaded
- no manifest parsing or real media playback occurs
- no TCP dynamics, RTT variation, loss model, or request overhead is modeled
- the predictor is a simple moving average
- the SODA controller reproduces the paper’s planning objective, but not the
  full production player environment described in the paper

So the project is realistic at the control-loop level, but still lighter than a
full networking or dash.js evaluation environment.

## Scenario expectations

### Stable

The stable scenario should let all algorithms converge toward relatively high
quality. The main comparison is whether they climb smoothly and avoid needless
switching.

### Volatile

The volatile scenario should trigger visibly different adaptation styles:

- greedy throughput control may chase short-term peaks
- buffer-based control may lag network changes but remain simple
- the reproduced SODA controller should appear more conservative when the
  buffer is at risk and switch less aggressively than the throughput-driven
  baselines

### Deep Drop

The deep-drop scenario should make the contrast easiest to explain in a live
presentation. A good controller should reduce bitrate before the sustained
collapse causes severe stalls, then recover without oscillating too wildly.

## Limitations

- one trace sample currently represents one chunk interval
- startup behavior is simplified with an initial prefilled buffer
- QoE follows the paper-style utility/rebuffer/switching formulation
- the implemented baselines are representative reproductions, not exact ports of
  dash.js or vendor production rules

## Future extensions

- connect the policy modules to a dash.js custom ABR rule
- replace synthetic playback visuals with an actual video element
- add trace import from measured bandwidth logs
- support side-by-side runs of multiple algorithms at the same time
- integrate Linux `tc netem` or containerized network shaping for real transport experiments
