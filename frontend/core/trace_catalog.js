export const TRACE_DEFINITIONS = [
  {
    id: "stable",
    label: "Stable",
    file: "stable_trace.csv",
    description:
      "Moderately high and mostly stable throughput with small oscillations. This scenario should favor steady bitrate ramps and very little rebuffering.",
  },
  {
    id: "volatile",
    label: "Volatile",
    file: "volatile_trace.csv",
    description:
      "Rapid throughput swings challenge over-aggressive adaptation. This scenario highlights switching behavior and predictor sensitivity.",
  },
  {
    id: "deep-drop",
    label: "Deep Drop",
    file: "deep_drop_trace.csv",
    description:
      "A healthy network that experiences a sustained collapse before recovering. This scenario is designed to expose rebuffer handling and recovery strategy.",
  },
];
