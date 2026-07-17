import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureSession, joinGame, fetchGame, fetchPlayerStates, storeCard,
  markSquare, claimBingo, subscribeGame, recordSnap, recordRepeat, uploadSnap, joinWaitlist,
} from './lib/supabase'
import { buildCard, hasBingo, squaresAway, FREE_INDEX } from './lib/bingo'
import { themeVars } from './lib/theme'

const NAME_KEY = 'wpb-player-name'
const LAST_KEY = 'wpb-last-game'
/// A game is a NIGHT, not an account. We remember the code you're playing so a
/// reload drops you back at the join screen with it filled in instead of on the
/// marketing page — but only for the length of an evening. Come back on Saturday
/// and you get the front door, like anyone else.
const LAST_TTL_MS = 12 * 60 * 60 * 1000

function readLastCode() {
  try {
    const { code, ts } = JSON.parse(localStorage.getItem(LAST_KEY) || '{}')
    return code && Date.now() - ts < LAST_TTL_MS ? code : ''
  } catch { return '' }
}

export default function App() {
  const urlCode = useMemo(() => {
    const q = new URLSearchParams(location.search).get('code')
    // Take only the first path segment after /join/ so /join/ABCD/ (trailing
    // slash) or /join/ABCD/anything still yields a clean code.
    const path = decodeURIComponent((location.pathname.split('/join/')[1] || '').split('/')[0])
    return (q || path).trim().toUpperCase()
  }, [])
  // An explicit invite link always wins over the remembered one.
  const resumeCode = useMemo(() => urlCode || readLastCode(), [urlCode])

  const [phase, setPhase] = useState(resumeCode ? 'name' : 'landing')  // landing | name | live
  const [code, setCode] = useState(resumeCode)
  const [name, setName] = useState(localStorage.getItem(NAME_KEY) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [uid, setUid] = useState(null)
  const [game, setGame] = useState(null)
  const [players, setPlayers] = useState([])
  const [card, setCard] = useState([])
  const [marked, setMarked] = useState(new Set([FREE_INDEX]))
  /// Per-square dab counts {index: n} — the "3×" badge and the hot glow, which
  /// iOS has had and web never rendered, though `.cell .badge` has been styled
  /// this whole time. Repeats are the point engine; without this the tap that
  /// scores looks identical to a tap that does nothing, so guests stop doing it.
  /// LOCAL BY NECESSITY, exactly as on iOS: the server keeps extra_taps as one
  /// scalar and can't say WHICH square a repeat hit, so a rejoin seeds each
  /// marked square to 1 — loses the breakdown rather than inventing one.
  const [taps, setTaps] = useState({})
  const [pts, setPts] = useState({ total: 0, dabs: 0, snaps: 0, repeats: 0 })

  const [sheet, setSheet] = useState(null)            // tapped cell index
  const [snaps, setSnaps] = useState([])              // local My Snaps gallery
  const fileRef = useRef(null)
  const pendingSnap = useRef(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [won, setWon] = useState(false)
  const [playersOpen, setPlayersOpen] = useState(false)
  const [viewWinner, setViewWinner] = useState(null)   // winner entry whose card is on screen
  const seenWinners = useRef(null)                     // seeded at join; auto-show fires once per NEW win
  const [pulses, setPulses] = useState([])
  const [liveOn, setLiveOn] = useState(() => localStorage.getItem('wpb-live') !== '0')
  const session = useRef(null)
  const pulseSeq = useRef(0)
  const liveOnRef = useRef(liveOn)
  useEffect(() => () => session.current?.stop?.(), [])
  useEffect(() => { if (won) { chime(); buzz([0, 70, 50, 130]) } }, [won])
  useEffect(() => { localStorage.setItem('wpb-live', liveOn ? '1' : '0') }, [liveOn])

  // Preview mode (?preview=1): render the polished board with mock data so the UI
  // can be seen/felt without joining a live game. No backend calls.
  const isPreview = useMemo(() =>
    new URLSearchParams(location.search).get('preview') === '1' || location.pathname.includes('/preview'), [])
  useEffect(() => {
    if (!isPreview) return
    setUid('me'); setName('You'); setGame(PREVIEW_GAME)
    setCard(buildCard('preview', PREVIEW_TROPES.length)); setPlayers(PREVIEW_PLAYERS); setPhase('live')
  }, [isPreview])

  const tropes = game?.custom_tropes || []
  const pattern = game?.pattern || 'line'
  const playing = game?.status === 'playing'
  const finished = game?.status === 'finished'
  const winners = game?.winners || []
  const myAway = squaresAway(marked, pattern)
  const iWon = winners.some((w) => (w.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  // Public games: claim_bingo answers 'pending' and the server parks us in
  // pending_winners until the host approves — derived, so a reject clears it too.
  const iPending = !iWon && (game?.pending_winners || [])
    .some((w) => (w.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  const oneAway = playing && !iWon && !won && myAway === 1
  const me = players.find((p) => (p.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  liveOnRef.current = liveOn
  useEffect(() => { if (oneAway) buzz(25) }, [oneAway])

  // Hold the screen on while the game is live. You dab a square, then watch the
  // movie for ten minutes — phone auto-lock would black the board out between
  // every dab. Only a PLAYING game holds the lock; it drops on finish/unmount so
  // a forgotten tab can't sit there burning battery. Best-effort: the API is
  // unsupported on some browsers (notably iOS Safari before 16.4) and the request
  // rejects whenever the tab isn't visible — neither is an error worth surfacing,
  // the game just plays as it does today.
  useEffect(() => {
    if (!playing || !('wakeLock' in navigator)) return
    let sentinel = null
    let released = false
    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return
      try {
        sentinel = await navigator.wakeLock.request('screen')
        // The browser drops the lock on its own when the tab is hidden; take it
        // back on return rather than leaving the rest of the movie unprotected.
        sentinel.addEventListener('release', () => { sentinel = null })
      } catch { /* denied, unsupported, or hidden — play on without it */ }
    }
    const onVisible = () => { if (document.visibilityState === 'visible' && !sentinel) acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      sentinel?.release?.().catch(() => {})
    }
  }, [playing])
  // Celebrate on the server's word too (host-approved claims, or a lost claim
  // response) — `won` drives the chime + confetti exactly once.
  useEffect(() => { if (iWon) setWon(true) }, [iWon])

  // The winning-card moment: when someone ELSE bingos, show the room their
  // full card (the winner has their own confetti). Once per win, never replayed.
  useEffect(() => {
    if (!seenWinners.current) return
    for (const w of winners) {
      const key = (w.user_id || '').toLowerCase()
      if (seenWinners.current.has(key)) continue
      seenWinners.current.add(key)
      if (key !== (uid || '').toLowerCase() && Array.isArray(w.card) && w.card.length === 25) {
        setViewWinner(w)
        buzz([0, 60, 40, 60])
      }
    }
  }, [winners, uid])

  async function handleJoin() {
    if (!code.trim() || !name.trim()) return
    setBusy(true); setError('')
    try {
      const id = await ensureSession()
      setUid(id)
      localStorage.setItem(NAME_KEY, name.trim())
      const joinCode = code.trim().toUpperCase()
      const ps = await joinGame(joinCode, name.trim(), [])
      localStorage.setItem(LAST_KEY, JSON.stringify({ code: joinCode, ts: Date.now() }))
      const g = await fetchGame(ps.game_id)
      setGame(g)
      // Wins that happened before we joined aren't "news" — don't replay them.
      seenWinners.current = new Set((g.winners || []).map((w) => (w.user_id || '').toLowerCase()))
      const myCard = ps.card?.length === 25 ? ps.card : buildCard(g.id, (g.custom_tropes || []).length || 25)
      setCard(myCard)
      storeCard(g.id, myCard) // publish once so others can peek from the leaderboard
      // Rejoining (a reload, a dropped tab) must restore the board we already
      // have. join_game returns the EXISTING player_states row, marked and all —
      // reading only ps.card and leaving `marked` at its initial {FREE} meant the
      // next dab flushed that empty set straight over the server's copy via
      // `set marked = p_marked`. An hour of dabbing, gone, mid-movie.
      setMarked(new Set([FREE_INDEX, ...(ps.marked || [])]))
      setTaps(Object.fromEntries((ps.marked || []).map((i) => [i, 1])))
      setPlayers(await fetchPlayerStates(g.id))
      session.current = subscribeGame(g.id, {
        onGame: (row) => setGame((prev) => ({ ...prev, ...row })),
        onPlayers: (payload) => {
          // Splice the one changed row in by user_id instead of refetching the
          // whole roster on every mark — O(1) per event vs O(N), so big parties
          // (20-30 players) don't trigger a refetch storm during mark bursts.
          if (!payload || payload.eventType === 'DELETE' || !payload.new) {
            fetchPlayerStates(g.id).then(setPlayers).catch(() => {})
            return
          }
          const row = payload.new
          setPlayers((prev) => {
            const i = prev.findIndex((p) => p.user_id === row.user_id)
            if (i === -1) return [...prev, row]
            const next = prev.slice(); next[i] = { ...next[i], ...row }; return next
          })
        },
        onPulse: (pl) => showPulse(pl),
      })
      setPhase('live')
    } catch (e) {
      setError(humanize(e))
    } finally { setBusy(false) }
  }

  function persistMark(nextSet) {
    if (game?.preview) { if (!won && hasBingo(nextSet, pattern)) setWon(true); return }
    const arr = [...nextSet].filter((x) => x !== FREE_INDEX).sort((a, b) => a - b)
    markSquare(game.id, arr).catch(() => {})
    if (!iWon && !won && hasBingo(nextSet, pattern)) doClaim()
  }

  async function doClaim() {
    try {
      // Send the card: the server snapshots {card, marked} into the winners
      // entry so the whole room sees the winning card (saved with the game).
      const res = await claimBingo(game.id, card.length === 25 ? card : null)
      if (res?.status === 'won') setWon(true)
    } catch { /* server rejects a non-win; ignore */ }
  }

  function interact(i, kind) {
    buzz(kind === 'snap' ? 28 : 14)
    session.current?.pulse?.({ userId: uid, name, squareIndex: i, text: tropes[card[i]]?.text, kind })
    const already = marked.has(i)
    setMarked((prev) => {
      const next = new Set(prev)
      if (!already) { next.add(i); persistMark(next) }
      return next
    })
    // A snap proves the square happened but isn't a repeat — the server counts
    // photos separately, so it seeds the square at 1 and never bumps the badge.
    setTaps((prev) => ({ ...prev, [i]: kind === 'snap' ? Math.max(1, prev[i] || 0) : (prev[i] || 0) + 1 }))
    if (!game?.preview) {
      if (kind === 'snap') recordSnap(game.id).catch(() => {})
      else if (already) recordRepeat(game.id).catch(() => {})
    }
    setPts((p) => kind === 'snap'
      ? { ...p, total: p.total + 3, snaps: p.snaps + 1, repeats: p.repeats + (already ? 1 : 0) }
      : { ...p, total: p.total + 1, dabs: p.dabs + 1, repeats: p.repeats + (already ? 1 : 0) })
    setSheet(null)
  }

  /// Peek at ANY player's card from the leaderboard. Card preference: winner
  /// snapshot → server-published card (set_card) → local card (self). No card
  /// available (older client) → quietly do nothing.
  function openPlayerCard(p) {
    const k = (s) => (s || '').toLowerCase()
    const win = winners.find((w) => k(w.user_id) === k(p.user_id))
    const isSelf = k(p.user_id) === k(uid)
    const cardArr = (Array.isArray(win?.card) && win.card.length === 25) ? win.card
      : (Array.isArray(p.card) && p.card.length === 25) ? p.card
      : (isSelf && card.length === 25) ? card : null
    if (!cardArr) return
    const markedArr = win?.marked
      || (isSelf ? [...marked].filter((x) => x !== FREE_INDEX) : (p.marked || []))
    const away = squaresAway(new Set([...markedArr, FREE_INDEX]), pattern)
    const subtitle = win ? 'got BINGO! — the winning card'
      : away === 0 ? 'BINGO on the board!' : `current card — ${away} to go`
    setViewWinner({ name: isSelf ? 'You' : p.name, card: cardArr, marked: markedArr, subtitle, emoji: win ? '🏆' : '👀' })
  }

  /// A brief toast in the pulse stack. Same surface the live activity uses, so
  /// there's exactly one place transient messages appear.
  function toast(msg) {
    const id = ++pulseSeq.current
    setPulses((p) => [...p.slice(-2), { id, msg }])
    setTimeout(() => setPulses((p) => p.filter((x) => x.id !== id)), 2600)
  }

  async function share() {
    const link = `${location.origin}${import.meta.env.BASE_URL}join/${game.code}`
    const show = game.watching ? ` — we're watching ${game.watching}` : ''
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Watch Party Bingo', text: `Join my game${show}`, url: link })
      } catch { /* the user dismissed the sheet; not an error */ }
      return
    }
    // Desktop has no navigator.share, and this used to copy game.code — so the
    // laptop host handed out a code and made six people go find the site and
    // type it. Copy the LINK, and say so: a button that looks inert gets pressed
    // again, and nobody can see a clipboard.
    try {
      await navigator.clipboard.writeText(link)
      toast('🔗 Invite link copied')
    } catch {
      toast(`Code: ${game.code}`)
    }
  }

  // A teammate just marked a square — show a brief, opt-out-able activity toast.
  function showPulse(pl) {
    if (!liveOnRef.current) return
    const who = pl?.name || 'Someone'
    const text = pl?.text || pl?.trope
    const verb = pl?.kind === 'snap' ? 'snapped' : 'marked'
    const id = ++pulseSeq.current
    setPulses((p) => [...p.slice(-2), { id, msg: `${who} ${verb}${text ? ` ${text}` : ' a square'}` }])
    setTimeout(() => setPulses((p) => p.filter((x) => x.id !== id)), 3200)
  }

  // Snap = capture a photo, then mark + score (+3). Preview has no camera.
  function startSnap(i) {
    setSheet(null)
    if (game?.preview) { interact(i, 'snap'); return }
    pendingSnap.current = { index: i, trope: tropes[card[i]]?.text }
    fileRef.current?.click()
  }
  function onSnapFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const pend = pendingSnap.current
    pendingSnap.current = null
    if (!file || !pend) return
    const url = URL.createObjectURL(file)
    setSnaps((s) => [{ id: url, url, trope: pend.trope }, ...s])
    interact(pend.index, 'snap')   // mark + record_snap (+3) + pulse
    uploadSnap(game.id, uid, file, { squareIndex: pend.index, tropeText: pend.trope, name }).catch(() => {})
  }

  // ---- LANDING (marketing front door) ----
  if (phase === 'landing') {
    return <Landing onJoin={(c) => { setCode(c); setPhase('name') }} />
  }

  // ---- NAME / JOIN GATE ----
  if (phase === 'name') {
    return (
      <div className="screen"><div className="wrap"><div className="center">
        <div className="brand-text">Watch Party Bingo</div>
        <h1>Join the game</h1>
        <p className="dim">Pop in the code your host shared, and pick a name — make it fun.</p>
        <input className="field code-field" placeholder="CODE" value={code} maxLength={12}
          onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" />
        <input className="field" placeholder="Your player name" value={name} maxLength={24}
          onChange={(e) => setName(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button className="btn" disabled={busy || !code.trim() || !name.trim()} onClick={handleJoin}>
          {busy ? 'Joining…' : 'Join game'}
        </button>
      </div></div></div>
    )
  }

  // ---- GAME ----
  return (
    <div className="game" style={themeVars(game?.theme)}>
      <div className="topbar">
        <button className="icon-btn" onClick={() => location.reload()} aria-label="Home">⌂</button>
        <div className="title">
          <div className="sub">{game?.watching || 'Watch Party Bingo'}</div>
          <div className="name">{game?.watching || 'Bingo'}</div>
          <button className="code-pill" onClick={share}>#{game?.code} ⤴</button>
        </div>
        <button className="people" onClick={() => setPlayersOpen((o) => !o)} aria-label="Show players">👥 {players.length || 1}</button>
      </div>

      {iWon && !finished && (
        <div className="win-banner">
          🎉 BINGO! You won{rankSuffix(winners, uid)}. Keep dabbing — the show&apos;s not over!
        </div>
      )}
      {!iWon && winners.length > 0 && !finished && (
        <div className="win-banner" style={{ background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer' }}
          onClick={() => { const w = winners.find((x) => Array.isArray(x.card)); if (w) setViewWinner(w) }}>
          🏆 {winners[0]?.name} got bingo{winners.length > 1 ? ` +${winners.length - 1} more` : ''} — still anyone&apos;s game for 2nd!
        </div>
      )}
      {iPending && (
        <div className="win-banner" style={{ background: 'rgba(255,255,255,0.06)', color: '#fff' }}>
          🕐 Bingo claim sent — waiting for the host to confirm.
        </div>
      )}

      {finished ? (
        <GameOver players={players} winners={winners} pattern={pattern} uid={uid} watching={game?.watching}
          onViewWinner={setViewWinner} />
      ) : !playing ? (
        <Lobby game={game} players={players} pattern={pattern} share={share} />
      ) : (
        <div className="board-area">
          {oneAway && <div className="oneaway">🔥 One square from bingo!</div>}
          <div className="bingo-head">{['B', 'I', 'N', 'G', 'O'].map((l) => <div key={l}>{l}</div>)}</div>
          <div className={`board${oneAway ? ' glow' : ''}`}>
            {card.map((tIdx, i) => {
              const free = i === FREE_INDEX
              const isMarked = marked.has(i)
              const trope = free ? null : tropes[tIdx]
              // Same thresholds as iOS TileView: badge above 1, hot at 3.
              const n = free ? 0 : (taps[i] || 0)
              return (
                <button key={i} className={`cell${isMarked ? ' marked' : ''}${free ? ' free' : ''}${n >= 3 ? ' hot' : ''}`}
                  onClick={() => { if (!free && playing) setSheet(i) }}>
                  {n > 1 && <span className="badge">{n}×</span>}
                  {free ? <><span className="emoji">★</span><span className="label">FREE</span></>
                    : <><span className="emoji">{trope?.emoji}</span><span className="label">{trope?.text}</span></>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="footer-cta">
        <button className="btn-ghost" style={{ width: 'auto', padding: '12px 22px' }} onClick={() => setStatsOpen(true)}>
          Stats &amp; Snaps
        </button>
      </div>
      <div className="wordmark-foot">WatchPartyBingo</div>

      {pulses.length > 0 && (
        <div className="pulse-stack">
          {pulses.map((p) => <div className="pulse-toast" key={p.id}>🟢 {p.msg}</div>)}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="environment"
        style={{ display: 'none' }} onChange={onSnapFile} />

      {sheet != null && (
        <TileSheet trope={tropes[card[sheet]]} marked={marked.has(sheet)}
          onClose={() => setSheet(null)}
          onDab={() => interact(sheet, 'dab')} onSnap={() => startSnap(sheet)} />
      )}

      {statsOpen && (
        <StatsSheet pts={pts} away={myAway} marked={marked} me={me} snaps={snaps} liveOn={liveOn}
          onToggleLive={() => setLiveOn((v) => !v)} onClose={() => setStatsOpen(false)} />
      )}

      {playersOpen && (
        <PlayersSheet players={players} pattern={pattern} uid={uid} myMarked={marked}
          hostId={game?.host_id} winners={winners} onClose={() => setPlayersOpen(false)}
          onViewPlayer={(p) => { setPlayersOpen(false); openPlayerCard(p) }} />
      )}

      {viewWinner && (
        <WinnerCardSheet winner={viewWinner} tropes={tropes} onClose={() => setViewWinner(null)} />
      )}

      {won && <Celebration />}
    </div>
  )
}

function PlayersSheet({ players, pattern, uid, myMarked, hostId, winners, onClose, onViewPlayer }) {
  const key = (s) => (s || '').toLowerCase()
  const winRank = (id) => winners.findIndex((w) => key(w.user_id) === key(id))
  const awayOf = (p) => squaresAway(key(p.user_id) === key(uid) ? [...myMarked] : (p.marked || []), pattern)
  // A row is peekable when SOME 25-cell card exists for that player.
  const peekable = (p, win) =>
    (Array.isArray(winners[win]?.card) && winners[win].card.length === 25) ||
    (Array.isArray(p.card) && p.card.length === 25) ||
    key(p.user_id) === key(uid)
  const rows = players.map((p) => ({ p, away: awayOf(p), win: winRank(p.user_id), score: p.score ?? 0 }))
    .sort((a, b) => {
      if ((a.win >= 0) !== (b.win >= 0)) return a.win >= 0 ? -1 : 1
      if (a.win >= 0 && b.win >= 0) return a.win - b.win
      if (b.score !== a.score) return b.score - a.score
      return a.away - b.away
    })
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet sheet-dark" style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <h2>Leaderboard ({players.length})</h2>
        <div className="dim tiny" style={{ marginBottom: 12 }}>Most points first · tap a player to see their card</div>
        <div className="winner-list">
          {rows.map(({ p, away, win, score }, idx) => {
            const canPeek = !!onViewPlayer && peekable(p, win)
            return (
              <div className="winner-row" key={p.id || p.user_id}
                style={canPeek ? { cursor: 'pointer' } : undefined}
                onClick={canPeek ? () => onViewPlayer(p) : undefined}>
                <div className="rank">{win >= 0 ? '🏆' : idx + 1}</div>
                <div className="avatar">{(p.name || '?')[0].toUpperCase()}</div>
                <div className="grow">
                  {p.name}
                  {key(p.user_id) === key(uid) && <span className="dim"> (you)</span>}
                  {key(p.user_id) === key(hostId) && <span className="tag-host" style={{ marginLeft: 8 }}>HOST</span>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="away">{win >= 0 ? (['1st', '2nd', '3rd'][win] || `${win + 1}th`) : `${score} pts`}</div>
                  {win < 0 && <div className="dim" style={{ fontSize: 11 }}>{away === 0 ? 'BINGO' : `${away} away`}</div>}
                </div>
                {canPeek && <div className="dim" style={{ fontSize: 14, marginLeft: 6 }}>›</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Celebration() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 40 }).map((_, i) => (
        <span key={i} style={{
          left: `${(i * 2.5) % 100}%`,
          background: i % 2 ? 'var(--accent)' : 'var(--accent-2)',
          animationDelay: `${(i % 10) * 0.07}s`,
        }} />
      ))}
    </div>
  )
}

/// A player's full card, presented CENTER SCREEN. Winners get the trophy
/// treatment (their {card, marked} snapshot frozen at the moment of the win);
/// anyone else shows their live card + progress ("current card — N to go").
/// Rendered with the SAME .board/.cell styling as the live board (square
/// aspect-ratio cells), so it keeps its bingo-card shape at any width.
function WinnerCardSheet({ winner, tropes, onClose }) {
  const markedSet = new Set([...(winner.marked || []), FREE_INDEX])
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ textAlign: 'center', fontSize: 40, lineHeight: '44px' }}>{winner.emoji || '🏆'}</div>
        <h2 style={{ textAlign: 'center', margin: '6px 0 0', fontSize: 26, fontWeight: 800 }}>{winner.name}</h2>
        <div className="dim" style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, margin: '2px 0 14px' }}>
          {winner.subtitle || 'got BINGO! — the winning card'}
        </div>
        <div className="board">
          {(winner.card || []).map((tIdx, i) => {
            const free = i === FREE_INDEX
            const isMarked = markedSet.has(i)
            const trope = free ? null : tropes[tIdx]
            return (
              <div key={i} className={`cell${isMarked ? ' marked' : ''}${free ? ' free' : ''}`}>
                <span className="emoji">{free ? '★' : trope?.emoji}</span>
                <span className="label">{free ? 'FREE' : trope?.text}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/// The wrap-up screen — a finished game shows closing credits, not a fake lobby.
/// Standings: bingo order first (claim order = rank), then points. Winner rows
/// with a card snapshot open the winning card.
function GameOver({ players, winners, pattern, uid, watching, onViewWinner }) {
  const key = (s) => (s || '').toLowerCase()
  const winRank = (id) => winners.findIndex((w) => key(w.user_id) === key(id))
  const rows = players
    .map((p) => ({ p, win: winRank(p.user_id), score: p.score ?? 0, away: squaresAway(p.marked || [], pattern) }))
    .sort((a, b) => {
      if ((a.win >= 0) !== (b.win >= 0)) return a.win >= 0 ? -1 : 1
      if (a.win >= 0 && b.win >= 0) return a.win - b.win
      if (b.score !== a.score) return b.score - a.score
      return a.away - b.away
    })
  const medal = (win, idx) => (win === 0 ? '🏆' : win === 1 ? '🥈' : win === 2 ? '🥉' : `${idx + 1}`)
  const ord = (n) => ['1st', '2nd', '3rd'][n] || `${n + 1}th`
  return (
    <div className="wrap">
      <div className="code-card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 44 }}>🏁</div>
        <h1 style={{ margin: '6px 0' }}>That&apos;s a wrap!</h1>
        <div className="dim tiny">
          {winners.length === 0
            ? 'No bingos this round — the TV won this one.'
            : `${winners[0]?.name} was first to bingo${watching ? ` on ${watching}` : ''}.`}
        </div>
      </div>
      <div style={{ height: 16 }} />
      <div className="dim tiny" style={{ marginBottom: 8 }}>Final standings</div>
      <div className="winner-list">
        {rows.map(({ p, win, score }, idx) => {
          const entry = win >= 0 ? winners[win] : null
          const hasCard = Array.isArray(entry?.card) && entry.card.length === 25
          return (
            <div className="winner-row" key={p.id || p.user_id}
              style={hasCard ? { cursor: 'pointer' } : undefined}
              onClick={hasCard ? () => onViewWinner?.(entry) : undefined}>
              <div className="rank">{medal(win, idx)}</div>
              <div className="avatar">{(p.name || '?')[0].toUpperCase()}</div>
              <div className="grow">
                {p.name}
                {key(p.user_id) === key(uid) && <span className="dim"> (you)</span>}
                {hasCard && <span className="dim tiny"> · view card</span>}
              </div>
              <div className="away">{win >= 0 ? `${ord(win)} · ${score} pts` : `${score} pts`}</div>
            </div>
          )
        })}
      </div>
      <div className="spacer" />
      <div className="toast">🍿 Thanks for playing — see you at the next watch party.</div>
    </div>
  )
}

function Lobby({ game, players, pattern, share }) {
  return (
    <div className="wrap">
      <div className="code-card">
        <div className="dim tiny">Game code</div>
        <div className="code-big">{game?.code}</div>
        <button className="btn btn-brand" onClick={share}>Invite friends</button>
      </div>
      <div style={{ height: 16 }} />
      <div className="dim tiny" style={{ marginBottom: 8 }}>Win pattern: {prettyPattern(pattern)} · {players.length} in the room</div>
      <div className="roster">
        {players.map((p) => (
          <div className="roster-row" key={p.id}>
            <div className="avatar">{(p.name || '?')[0].toUpperCase()}</div>
            <div className="grow">{p.name}</div>
          </div>
        ))}
      </div>
      <div className="spacer" />
      <div className="toast">⏳ Waiting for the host to start… get comfy.</div>
    </div>
  )
}

function TileSheet({ trope, marked, onClose, onDab, onSnap }) {
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="big-emoji">{trope?.emoji || '⭐'}</div>
        <h2>{trope?.text || 'Square'}</h2>
        <p className="def">{trope?.description || 'Spot this on screen, then mark it.'}</p>
        <button className="action action-snap" onClick={onSnap}>
          <span>📸 Snap It</span><span className="pts">+3 pt</span>
        </button>
        <button className={`action action-dab${marked ? ' done' : ''}`} onClick={onDab}>
          <span>{marked ? '✓ Dab again' : 'Dab It'}</span><span className="pts">+1 pt</span>
        </button>
      </div>
    </div>
  )
}

function StatsSheet({ pts, away, marked, me, snaps = [], liveOn, onToggleLive, onClose }) {
  const contentMarked = [...marked].filter((x) => x !== FREE_INDEX).length
  const total = me?.score ?? pts.total
  const snapped = me?.photos_taken ?? pts.snaps
  const repeats = me?.extra_taps ?? pts.repeats
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet sheet-dark" style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <h2>My Stats</h2>
        <div className="dim tiny">{away === 0 ? 'BINGO!' : `${away} away`} · {contentMarked}/24 marked</div>
        <div className="points-hero"><div className="dim">Total Points</div><div className="n">{total}</div></div>
        <div className="stat-grid">
          <div className="stat"><div className="n">{contentMarked}</div><div className="lbl">Dabbed</div></div>
          <div className="stat"><div className="n">{snapped}</div><div className="lbl">Snapped</div></div>
          <div className="stat"><div className="n">{repeats}</div><div className="lbl">Repeats</div></div>
        </div>
        <button className="toggle-row" onClick={onToggleLive}>
          <div><div style={{ fontWeight: 700 }}>Live activity</div>
            <div className="dim tiny">See when others mark squares</div></div>
          <div className={`switch${liveOn ? ' on' : ''}`}><span /></div>
        </button>
        <div className="snaps-head">📸 My Snaps ({snaps.length})</div>
        {snaps.length === 0
          ? <div className="snaps-empty">No snaps yet — tap a square → Snap It for +3.</div>
          : <div className="snaps-grid">
              {snaps.map((s) => (
                <div className="snap-thumb" key={s.id}>
                  <img src={s.url} alt={s.trope || 'snap'} />
                  {s.trope && <span>{s.trope}</span>}
                </div>
              ))}
            </div>}
      </div>
    </div>
  )
}

function rankSuffix(winners, uid) {
  const idx = winners.findIndex((w) => (w.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  if (idx < 0) return ''
  const ord = ['1st', '2nd', '3rd'][idx] || `${idx + 1}th`
  return ` — ${ord} to bingo`
}
function prettyPattern(p) {
  return { line: 'Line', four_corners: 'Four Corners', x_pattern: 'X', blackout: 'Blackout' }[p] || 'Line'
}
function humanize(e) {
  const m = (e?.message || '').toLowerCase()
  if (m.includes('recursion')) return 'Server hiccup — try again in a sec.'
  if (m.includes('not_authenticated')) return 'Could not start your session — refresh and try again.'
  if (m.includes('not_joinable')) return 'This game is no longer taking new players.'
  if (m.includes('not_found') || m.includes('invalid') || m.includes('no rows')) return "That code didn't match a game."
  if (m.includes('full')) return 'That room is full.'
  if (m.includes('name')) return 'Someone already has that name — try another.'
  return "Couldn't join. Double-check the code and try again."
}

// ---- Preview mode mock data (NBA, matches the screenshots) ----
const PREVIEW_TROPES = [
  { emoji: '🤕', text: 'Injury Timeout', description: 'Play stops for an injury on the court.' },
  { emoji: '😤', text: 'Ejection!', description: 'A player or coach gets tossed.' },
  { emoji: '🎯', text: 'Corner Three', description: 'A three drained from the corner.' },
  { emoji: '😱', text: 'Flagrant Foul', description: 'An over-the-top foul gets reviewed.' },
  { emoji: '🗣️', text: 'Trash Talk', description: 'Players jaw at each other.' },
  { emoji: '📈', text: 'MVP Discussion', description: 'Announcers debate the MVP race.' },
  { emoji: '✈️', text: 'Poster Dunk', description: 'A dunk right over a defender.' },
  { emoji: '🤸', text: 'Obvious Flop', description: 'A player flops for a call.' },
  { emoji: '👴', text: 'Back In My Day', description: 'Announcer compares to old-school era.' },
  { emoji: '🧊', text: 'Missed Free Throws', description: 'A player bricks free throws.' },
  { emoji: '🧹', text: 'Clear Path Foul', description: 'A clear-path foul is called.' },
  { emoji: '⏰', text: 'Shot Clock Violation', description: 'The shot clock expires.' },
  { emoji: '🎩', text: 'Triple-Double Alert', description: "Someone's chasing a triple-double." },
  { emoji: '🧱', text: 'Big Man Three', description: 'A center shoots from deep.' },
  { emoji: '💪', text: 'Flex After Dunk', description: 'A player flexes after a slam.' },
  { emoji: '🦾', text: 'Arm Talent Talk', description: 'Commentators praise "length."' },
  { emoji: '📺', text: 'TV Timeout', description: 'A scheduled broadcast timeout.' },
  { emoji: '📊', text: 'Random Stats', description: 'An oddly specific stat appears.' },
  { emoji: '👔', text: 'Coach Loses It', description: 'A coach erupts at the refs.' },
  { emoji: '💨', text: 'Fast Break Bucket', description: 'An easy bucket in transition.' },
  { emoji: '🤝', text: 'Jump Ball', description: 'A jump ball is called.' },
  { emoji: '⭕', text: 'Airball', description: 'A shot misses everything.' },
  { emoji: '🙅', text: 'Foul Trouble', description: 'A star sits with foul trouble.' },
  { emoji: '🤬', text: 'Technical Foul', description: 'A technical foul is assessed.' },
  { emoji: '🔥', text: 'Heat Check', description: 'A hot shooter pulls up from way out.' },
]
const PREVIEW_GAME = {
  id: 'preview', preview: true, code: 'DRAMA84', status: 'playing', pattern: 'line',
  watching: 'NBA Games', winners: [], custom_tropes: PREVIEW_TROPES,
  theme: {
    accentPrimary: '#F0820F', accentSecondary: '#1D428A', accentTertiary: '#C8102E',
    markedSquareColor: 'linear-gradient(135deg,#F0820F,#C8102E)', decorativeEmojis: ['🏀', '🔥', '🏆'],
    backgroundGradient: { angle: 160, colors: ['#0a0a0f', '#0e1430', '#3a1d0a'] },
  },
}
const PREVIEW_PLAYERS = [{ id: 'me', user_id: 'me', name: 'You', marked: [] }]

// Premium feel: a haptic buzz (mobile) + a short triumphant chime on bingo.
function buzz(pattern) { try { navigator.vibrate?.(pattern) } catch { /* unsupported */ } }
function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    ;[523.25, 659.25, 783.99].forEach((f, i) => {     // C–E–G
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'triangle'; o.frequency.value = f
      o.connect(g); g.connect(ctx.destination)
      const t = ctx.currentTime + i * 0.12
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
      o.start(t); o.stop(t + 0.42)
    })
  } catch { /* ignore */ }
}

// ---- Marketing landing page (the front door) ----
function Landing({ onJoin }) {
  const [code, setCode] = useState('')
  return (
    <div className="screen landing">
      <div className="wrap lp">
        <header className="lp-hero">
          <div className="lp-wordmark">
            <span className="w">Watch</span><span className="p">Party</span><span className="b">Bingo!</span>
          </div>
          <p className="lp-tag">Live bingo for your watch parties — spot the tropes as they happen, snap the moments, and race your friends to a bingo.</p>
        </header>

        <section className="lp-card">
          <div className="lp-card-title">Got a game code?</div>
          <form className="hub-join" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onJoin(code.trim().toUpperCase()) }}>
            <input className="field code-field" placeholder="GAME CODE" value={code} maxLength={12}
              autoCapitalize="characters" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <button className="btn" type="submit" disabled={!code.trim()}>Join</button>
          </form>
          <a className="lp-link" href="?preview=1">See a sample card →</a>
        </section>

        <section className="lp-how">
          <h2 className="display">How it works</h2>
          <div className="how-grid">
            {[
              ['🎬', 'Pick a theme', 'NBA, reality TV, holiday movies & more.'],
              ['🔗', 'Share a link', 'Friends tap and play — no app required.'],
              ['📸', 'Spot & snap', 'Dab a trope for a point, snap a photo for three.'],
              ['🏆', 'Race to bingo', 'Live leaderboard — first to the pattern wins.'],
            ].map(([e, t, d]) => (
              <div className="how-cell" key={t}>
                <div className="how-ic">{e}</div>
                <div className="how-t">{t}</div>
                <div className="how-d">{d}</div>
              </div>
            ))}
          </div>
        </section>

        <BetaSignup />
        <footer className="lp-foot display">WatchPartyBingo</footer>
      </div>
    </div>
  )
}

function BetaSignup() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  async function submit(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    try { await joinWaitlist(email.trim()); setDone(true) } catch { /* keep form for retry */ } finally { setBusy(false) }
  }
  return (
    <section className="lp-card lp-beta">
      <div className="lp-card-title">Want to host your own?</div>
      <p className="dim" style={{ margin: '4px 0 14px' }}>The iOS app — pick a theme, create a game, AI-made cards — is in beta. Get notified when it lands.</p>
      {done
        ? <div className="lp-done">🎉 You're on the list — we'll be in touch.</div>
        : <form onSubmit={submit}>
            <input className="field" type="email" inputMode="email" placeholder="you@email.com"
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-brand" type="submit" disabled={busy || !email.trim()} style={{ marginTop: 10 }}>
              {busy ? 'Joining…' : 'Join the beta'}
            </button>
          </form>}
    </section>
  )
}
