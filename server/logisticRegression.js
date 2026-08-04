// Phase 3 (2026-08-04): pure logistic-regression training math, extracted from confidenceModel.js.
// No I/O, no state — just sigmoid + plain batch gradient descent with L2 regularization, so the
// model module stays under 150 lines. confidenceModel.js imports these and owns the data plumbing
// (feature extraction, labeled-example collection, retrain orchestration).
export function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

const EPOCHS = 400;
const LEARNING_RATE = 0.3;
const L2 = 0.01;

/**
 * Plain batch gradient-descent logistic regression — no ML library needed for a handful of
 * features over what will realistically be dozens to low hundreds of examples for a single-user
 * tool. L2-regularized so it doesn't swing wildly on a small dataset.
 */
export function trainLogisticRegression(X, y, { epochs = EPOCHS, lr = LEARNING_RATE, l2 = L2 } = {}) {
  const n = X.length;
  const d = X[0].length;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = bias + X[i].reduce((s, x, j) => s + x * weights[j], 0);
      const pred = sigmoid(z);
      const err = pred - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }
  return { weights, bias };
}
