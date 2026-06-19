// Bingo card + win detection for a 5x5 board (cell indices 0..24, FREE center=12).
// The CLIENT only DETECTS a likely bingo to decide when to call claim_bingo; the
// server (`claim_bingo`/`_evaluate_pattern`) is authoritative. Pattern keys match
// the backend: 'line' | 'four_corners' | 'x_pattern' | 'blackout'.
// NOTE: exact index sets to be reconciled against the iOS BingoEngine spec.

export const CARD_SIZE = 25
export const FREE_INDEX = 12
export const CONTENT_SQUARES = 24

const ROWS = [
  [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
]
const COLS = [
  [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
]
const DIAGS = [[0, 6, 12, 18, 24], [4, 8, 12, 16, 20]]
const LINES = [...ROWS, ...COLS, ...DIAGS]
const FOUR_CORNERS = [0, 4, 20, 24]
const X_PATTERN = [0, 6, 12, 18, 24, 4, 8, 16, 20]
const ALL = Array.from({ length: CARD_SIZE }, (_, i) => i)

const has = (m, cells) => cells.every((c) => m.has(c))

/** True if `marked` (iterable of cell indices) completes `pattern`. FREE always counts. */
export function hasBingo(marked, pattern) {
  const m = new Set(marked)
  m.add(FREE_INDEX)
  switch (pattern) {
    case 'four_corners': return has(m, FOUR_CORNERS)
    case 'x_pattern': return has(m, X_PATTERN)
    case 'blackout': return has(m, ALL)
    case 'line':
    default: return LINES.some((line) => has(m, line))
  }
}

/** How many squares a player is away from completing `pattern` (0 = bingo). Drives
 *  the live "N away" standings. FREE always counts as marked. */
export function squaresAway(marked, pattern) {
  const m = new Set(marked)
  m.add(FREE_INDEX)
  const missing = (cells) => cells.reduce((n, c) => n + (m.has(c) ? 0 : 1), 0)
  switch (pattern) {
    case 'four_corners': return missing(FOUR_CORNERS)
    case 'x_pattern': return missing(X_PATTERN)
    case 'blackout': return missing(ALL)
    case 'line':
    default: return Math.min(...LINES.map(missing))
  }
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Build a 25-cell card: center is FREE (null); the other 24 are distinct trope
 *  indices into the game's custom_tropes. Persisted to localStorage per game so a
 *  reload keeps the same card. */
export function buildCard(gameId, tropeCount) {
  const key = `wpb-card-${gameId}`
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (Array.isArray(saved) && saved.length === CARD_SIZE) return saved
  } catch { /* ignore */ }

  const picks = shuffle(Array.from({ length: tropeCount }, (_, i) => i)).slice(0, CONTENT_SQUARES)
  const card = []
  let t = 0
  // FREE center is encoded as -1 (matches iOS CardGenerator + the old web card).
  for (let i = 0; i < CARD_SIZE; i++) card.push(i === FREE_INDEX ? -1 : picks[t++])
  try { localStorage.setItem(key, JSON.stringify(card)) } catch { /* ignore */ }
  return card
}
