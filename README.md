# Sudoku

A clean, modern Sudoku: play the daily puzzle or pick a difficulty and solve a fresh puzzle
generated right in your browser — with pencil-mark notes, hints, undo, dark mode, and local stats.

**Play it live: https://iamyvj.github.io/sudoku/**

## Features

- **Four difficulties, graded by technique** — not just by clue count.
  - **Easy** — about 40 clues; every step is a single.
  - **Medium** — about 32 clues; still singles only, but you'll have to hunt for them.
  - **Hard** — needs pointing pairs, box/line reduction, or naked/hidden pairs.
  - **Expert** — near-minimal grids that go beyond pairs (think X-Wings and chains).
- **Daily puzzle** — one puzzle a day, the same for everyone, with the difficulty rotating
  through the week. Solve it on consecutive days to build a streak, then share your time.
- **Challenge a friend** — after a win, share a link to the exact same puzzle with your time
  to beat. The link carries the grid itself, so it opens instantly on any device.
- **Exactly one solution, every time** — each puzzle is checked for uniqueness before you see it.
- **Pencil-mark notes** — toggle Notes (or hold Shift) to jot candidates; placing a digit
  clears it from the notes in its row, column, and box. **Fill** pencils in every candidate
  at once when you'd rather start from full notes (one undo takes it back).
- **Gentle feedback** — clashing digits turn red, and the selected cell's row, column, box,
  and matching digits are highlighted. By default the game never peeks at the answer for you.
- **Strict mode** — an optional setting for a tougher game: any wrong digit is marked at
  once, and three mistakes end the puzzle (you can retry the same grid).
- **Hints that teach** — a hint fixes a mistake first; otherwise it fills the next logical
  step and says why ("Box 5 needs a 7, and this is the only cell where 7 fits"), naming any
  pairs or locked candidates it used. Best times only count hint-free solves.
- **Undo, redo and erase** — step back and forward through every move.
- **Haptics** — on phones that support it, a light tap confirms each digit and a short buzz
  flags a clash or mistake (switch it off in Settings).
- **Cell-first or digit-first** — tap a cell then a number, or switch to digit-first in
  Settings: pick a number once, then tap every cell it belongs in.
- **Timer with pause** — pausing hides the board; the clock stops when you switch tabs.
- **Picks up where you left off** — your game is saved as you play.
- **Local stats per difficulty** — played, win rate, best and average time, plus daily streaks.
- **Works offline, installable** — after the first visit the game and puzzle generator run
  without a connection, and it can be added to your home screen as an app.
- **Dark / light theme**, remembered across visits.
- **Built for phones and keyboards** — big tap targets, a layout that fits any screen, and
  full keyboard play.

### Keyboard

| Key | Action |
|---|---|
| `1`–`9` | Place a digit (or a note in Notes mode) |
| `Shift` + `1`–`9` | Toggle a note |
| Arrow keys | Move |
| `Backspace` / `Delete` / `0` | Erase |
| `N` | Notes mode |
| `Z` / `Ctrl+Z` | Undo |
| `Y` / `Shift+Z` / `Ctrl+Y` | Redo |
| `F` | Fill all notes |
| `H` | Hint |
| `P` | Pause |

## How it works

A pure static site — HTML, CSS, and vanilla JavaScript, with no framework and no runtime
dependencies.

- **Puzzles are made on your device.** `sudoku.js` fills a random solved grid by
  backtracking, then removes clues one at a time, keeping each removal only if the puzzle
  still has exactly one solution.
- **Difficulty comes from a human-style solver.** A grader replays the puzzle using the
  techniques people use — singles, then pointing pairs, box/line reduction, and naked/hidden
  pairs — and the hardest technique it needs decides the level. Easy and Medium are also
  dug in symmetric pairs, for the classic look.
- **The daily puzzle needs no server.** The date is hashed into a seed, and the generator runs
  a fixed number of attempts instead of racing the clock, so every device builds the same grid.
- **Generation stays off the UI thread.** `generator.worker.js` runs the engine in a Web
  Worker, and the next puzzle is prepared in the background, so "New Game" is usually instant.
- **One engine, shared everywhere.** The page, the worker, and the tests all load the same
  `sudoku.js`, so they can never disagree about what counts as a valid puzzle.

## Project structure

```
index.html             Markup + screens (home, game, modals)
style.css              Theme tokens and all styling
script.js              Game state, input, rendering, timer, stats
sudoku.js              Engine: generator, uniqueness solver, difficulty grader
generator.worker.js    Runs the generator off the main thread
tests/sudoku.test.mjs  Uniqueness and difficulty checks for the generator
```

## Tests

```sh
node --test
```

Generates puzzles at every difficulty and checks each one against an independent solver:
valid solution, exactly one solution, clue count, and difficulty grade.

## License

MIT — see [LICENSE](LICENSE).
