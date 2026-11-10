// Puzzle generator (Web Worker). Runs SudokuEngine.generate off the UI thread so the board never janks.
// Message in:  { id, difficulty, seed, budgetMs, maxAttempts, variant }   Message out: { id, ok:true, result } | { id, ok:false, error }
importScripts('sudoku.js');
self.onmessage = (e) => {
    const { id, difficulty, seed, budgetMs, maxAttempts, variant } = e.data;
    try {
        self.postMessage({ id, ok: true, result: self.SudokuEngine.generate(difficulty, { seed, budgetMs, maxAttempts, variant }) });
    } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
};
