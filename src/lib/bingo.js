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

/// Deterministic PRNG (mulberry32 over an FNV-1a hash of the seed string).
/// The deal must be a pure function of (game, player, draft) — same as iOS —
/// so a toggle-and-back restores your exact card and re-rolling the draft can
/// never be farmed for a better layout.
function seededRand(seedStr) {
  let h = 0x811c9dc5
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let s = h >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(arr, rand = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Draft caps — mirror iOS CardGenerator exactly: up to 6 squares guaranteed on,
// up to 4 promised off, and the avoid cap shrinks when the pool barely covers a
// card so a benched square is truly benched, never silently dealt back in.
export const WANT_CAP = 6
export const AVOID_CAP = 4
export function effectiveAvoidCap(poolSize) {
  return Math.max(0, Math.min(AVOID_CAP, poolSize - CONTENT_SQUARES))
}

/** Build a 25-cell card: center is FREE (-1); the other 24 are distinct trope
 *  indices into the game's custom_tropes. Persisted to localStorage per game so a
 *  reload keeps the same card.
 *
 *  `want` indices are guaranteed on the card; `avoid` indices stay off it (the
 *  cap math above makes the last-resort refill unreachable for capped callers).
 *  Pass `fresh: true` on a draft change to re-deal past the cached card — the
 *  cache then stores the new deal, so a reload keeps the drafted board.
 *
 *  `seedKey` (game + player) makes the deal DETERMINISTIC: the same draft always
 *  produces the same card, so toggling a pick and toggling it back restores the
 *  exact board — and re-dealing can't be farmed for a better layout. */
export function buildCard(gameId, tropeCount, { want = [], avoid = [], fresh = false, seedKey = '' } = {}) {
  const key = `wpb-card-${gameId}`
  if (!fresh) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null')
      if (Array.isArray(saved) && saved.length === CARD_SIZE) return saved
    } catch { /* ignore */ }
  }

  const rand = seedKey
    ? seededRand(`${seedKey}|w:${[...want].sort((a, b) => a - b)}|a:${[...avoid].sort((a, b) => a - b)}`)
    : Math.random
  const wantSet = new Set(want.filter((i) => i >= 0 && i < tropeCount))
  const avoidSet = new Set(avoid.filter((i) => i >= 0 && i < tropeCount && !wantSet.has(i)))
  const rest = shuffle(Array.from({ length: tropeCount }, (_, i) => i)
    .filter((i) => !wantSet.has(i) && !avoidSet.has(i)), rand)
  let picks = [...wantSet].sort((a, b) => a - b).slice(0, CONTENT_SQUARES)
  picks = picks.concat(rest.slice(0, CONTENT_SQUARES - picks.length))
  if (picks.length < CONTENT_SQUARES) {
    // Pool minus avoids can't fill a card (uncapped caller) — refill from avoids
    // rather than deal a broken board.
    const chosen = new Set(picks)
    picks = picks.concat(shuffle([...avoidSet].filter((i) => !chosen.has(i)), rand)
      .slice(0, CONTENT_SQUARES - picks.length))
  }
  // A pool below 24 can't fill a card at all (unreachable through real create
  // flows) — wrap rather than publish a card with holes in it.
  while (picks.length < CONTENT_SQUARES && tropeCount > 0) picks.push(picks.length % tropeCount)
  picks = shuffle(picks, rand) // placement
  const card = []
  let t = 0
  // FREE center is encoded as -1 (matches iOS CardGenerator + the old web card).
  for (let i = 0; i < CARD_SIZE; i++) card.push(i === FREE_INDEX ? -1 : picks[t++])
  try { localStorage.setItem(key, JSON.stringify(card)) } catch { /* ignore */ }
  return card
}
