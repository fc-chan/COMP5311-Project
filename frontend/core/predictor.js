export function createMovingAveragePredictor({ windowSize = 5, defaultValue = 2.0 } = {}) {
  const samples = [];

  return {
    pushSample(sampleMbps) {
      samples.push(sampleMbps);
      if (samples.length > windowSize) {
        samples.shift();
      }
    },
    predict() {
      if (samples.length === 0) {
        return defaultValue;
      }
      const sum = samples.reduce((acc, value) => acc + value, 0);
      return sum / samples.length;
    },
  };
}
