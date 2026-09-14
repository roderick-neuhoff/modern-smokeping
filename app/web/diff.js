// Small dependency-free line diff (classic LCS) for previewing raw config
// edits before saving. No context-collapsing - these config files are
// small, so a full listing is simpler and still easy to scan.

const MAX_LINES = 3000;

export function diffLines(a, b) {
  const A = (a || '').split(/\r\n|\r|\n/);
  const B = (b || '').split(/\r\n|\r|\n/);
  if (A.length + B.length > MAX_LINES) {
    return [{ type: 'same', text: '(file too large for inline diff)' }];
  }

  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}
