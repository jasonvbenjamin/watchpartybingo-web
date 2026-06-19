import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureSession, joinGame, fetchGame, fetchPlayerStates,
  markSquare, claimBingo, subscribeGame, recordSnap, recordRepeat, uploadSnap, joinWaitlist,
} from './lib/supabase'
import { buildCard, hasBingo, squaresAway, FREE_INDEX } from './lib/bingo'
import { themeVars } from './lib/theme'

const NAME_KEY = 'wpb-player-name'

export default function App() {
  const urlCode = useMemo(() => (
    new URLSearchParams(location.search).get('code')
    || decodeURIComponent(location.pathname.split('/join/')[1] || '')
  ).toUpperCase(), [])

  const [phase, setPhase] = useState(urlCode ? 'name' : 'landing')  // landing | name | live
  const [code, setCode] = useState(urlCode)
  const [name, setName] = useState(localStorage.getItem(NAME_KEY) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [uid, setUid] = useState(null)
  const [game, setGame] = useState(null)
  const [players, setPlayers] = useState([])
  const [card, setCard] = useState([])
  const [marked, setMarked] = useState(new Set([FREE_INDEX]))
  const [pts, setPts] = useState({ total: 0, dabs: 0, snaps: 0, repeats: 0 })

  const [sheet, setSheet] = useState(null)            // tapped cell index
  const [snaps, setSnaps] = useState([])              // local My Snaps gallery
  const fileRef = useRef(null)
  const pendingSnap = useRef(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [won, setWon] = useState(false)
  const [playersOpen, setPlayersOpen] = useState(false)
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
  const winners = game?.winners || []
  const myAway = squaresAway(marked, pattern)
  const iWon = winners.some((w) => (w.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  const oneAway = playing && !iWon && !won && myAway === 1
  const me = players.find((p) => (p.user_id || '').toLowerCase() === (uid || '').toLowerCase())
  liveOnRef.current = liveOn
  useEffect(() => { if (oneAway) buzz(25) }, [oneAway])

  async function handleJoin() {
    if (!code.trim() || !name.trim()) return
    setBusy(true); setError('')
    try {
      const id = await ensureSession()
      setUid(id)
      localStorage.setItem(NAME_KEY, name.trim())
      const ps = await joinGame(code.trim().toUpperCase(), name.trim(), [])
      const g = await fetchGame(ps.game_id)
      setGame(g)
      setCard(buildCard(g.id, (g.custom_tropes || []).length || 25))
      setPlayers(await fetchPlayerStates(g.id))
      session.current = subscribeGame(g.id, {
        onGame: (row) => setGame((prev) => ({ ...prev, ...row })),
        onPlayers: async () => setPlayers(await fetchPlayerStates(g.id)),
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
      const res = await claimBingo(game.id)
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
    if (!game?.preview) {
      if (kind === 'snap') recordSnap(game.id).catch(() => {})
      else if (already) recordRepeat(game.id).catch(() => {})
    }
    setPts((p) => kind === 'snap'
      ? { ...p, total: p.total + 3, snaps: p.snaps + 1, repeats: p.repeats + (already ? 1 : 0) }
      : { ...p, total: p.total + 1, dabs: p.dabs + 1, repeats: p.repeats + (already ? 1 : 0) })
    setSheet(null)
  }

  function share() {
    const link = `${location.origin}${import.meta.env.BASE_URL}join/${game.code}`
    if (navigator.share) navigator.share({ title: 'Watch Party Bingo', text: `Join my game — code ${game.code}`, url: link }).catch(() => {})
    else navigator.clipboard?.writeText(game.code)
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

      {iWon && <div className="win-banner">🎉 BINGO! You won{rankSuffix(winners, uid)}.</div>}
      {!iWon && winners.length > 0 && (
        <div className="win-banner" style={{ background: 'rgba(255,255,255,0.06)', color: '#fff' }}>
          🏆 {winners[0]?.name} got bingo{winners.length > 1 ? ` +${winners.length - 1} more` : ''}
        </div>
      )}

      {!playing ? (
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
              return (
                <button key={i} className={`cell${isMarked ? ' marked' : ''}${free ? ' free' : ''}`}
                  onClick={() => { if (!free && playing) setSheet(i) }}>
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
          hostId={game?.host_id} winners={winners} onClose={() => setPlayersOpen(false)} />
      )}

      {won && <Celebration />}
    </div>
  )
}

function PlayersSheet({ players, pattern, uid, myMarked, hostId, winners, onClose }) {
  const key = (s) => (s || '').toLowerCase()
  const winRank = (id) => winners.findIndex((w) => key(w.user_id) === key(id))
  const awayOf = (p) => squaresAway(key(p.user_id) === key(uid) ? [...myMarked] : (p.marked || []), pattern)
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
        <div className="dim tiny" style={{ marginBottom: 12 }}>Most points first · closeness as tiebreak</div>
        <div className="winner-list">
          {rows.map(({ p, away, win, score }, idx) => (
            <div className="winner-row" key={p.id || p.user_id}>
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
            </div>
          ))}
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
            <span className="w">Watch</span>
            <span className="p">Party</span>
            <span className="b">Bingo!</span>
          </div>
          <p className="lp-tag">Live bingo for your watch parties. Spot the tropes as they happen, snap the moments, and race your friends to a bingo.</p>
        </header>

        <section className="lp-card">
          <div className="lp-card-title">Got a game code?</div>
          <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) onJoin(code.trim().toUpperCase()) }}>
            <input className="field code-field" placeholder="CODE" value={code} maxLength={12}
              autoCapitalize="characters" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <button className="btn" type="submit" disabled={!code.trim()} style={{ marginTop: 10 }}>Join the game</button>
          </form>
          <a className="lp-link" href="?preview=1">Peek at a live board →</a>
        </section>

        <GenreCarousel />

        <section className="lp-how">
          <h2 className="display">How it works</h2>
          <div className="lp-steps">
            {[
              ['🎬', 'Pick a theme', 'NBA, reality TV, holiday movies & more.'],
              ['🔗', 'Share a link', 'Friends tap and play — no app required.'],
              ['📸', 'Spot & snap', 'Dab a trope for a point, snap a photo for three.'],
              ['🏆', 'Race to bingo', 'Live leaderboard — first to the pattern wins.'],
            ].map(([e, t, d]) => (
              <div className="lp-step" key={t}>
                <div className="lp-emoji">{e}</div>
                <div><div className="lp-step-t">{t}</div><div className="lp-step-d">{d}</div></div>
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

// Fun genre cards for the landing showcase — the humor IS the pitch.
const GENRE_CARDS = [
  { name: 'Rom-Com', emoji: '💘', tint: '#FF5FA2', tropes: [
    ['🛫', 'Airport dash'], ['🌧️', 'Rain kiss'], ['😤', 'Hate → love'],
    ['🙅', 'Wrong guy first'], ['🤦', 'Big misunderstanding'], ['💄', 'Makeover reveal'] ] },
  { name: 'Reality TV', emoji: '📺', tint: '#7D3BFF', tropes: [
    ['😈', "Not here to make friends"], ['🎙️', "Producer's voice"], ['😭', 'Dramatic confessional'],
    ['🍷', 'Drink gets thrown'], ['🎬', 'Villain edit'], ['⏭️', 'To be continued…'] ] },
  { name: 'NBA', emoji: '🏀', tint: '#F0820F', tropes: [
    ['👴', 'Back in my day'], ['😱', 'Flagrant review'], ['👔', 'Coach loses it'],
    ['🗣️', 'And-one yell'], ['✈️', 'Poster dunk'], ['📣', 'Ref gets booed'] ] },
  { name: 'Horror', emoji: '🔪', tint: '#34C759', tropes: [
    ['🚪', "Don't go in there"], ['👻', "It's behind you"], ['🚗', "Car won't start"],
    ['👥', 'Splits the group'], ['🔪', "Killer's not dead"], ['📵', 'No signal'] ] },
  { name: 'Holiday Movies', emoji: '🎄', tint: '#E23B5A', tropes: [
    ['🏙️', 'Quits the big city'], ['❄️', 'Snow on cue'], ['🎄', 'Tree lighting'],
    ['🤴', 'Secret prince'], ['🍪', 'Bake-off save'], ['😬', 'Almost-kiss'] ] },
  { name: 'Cooking Shows', emoji: '👨‍🍳', tint: '#FFB000', tropes: [
    ['🥩', 'Raw in the middle'], ['🚪', 'Walks out'], ['🍡', '"Deconstructed…"'],
    ['⏸️', "Judge's dramatic pause"], ['⏰', 'Out of time'], ['😢', 'Crying backstory'] ] },
  { name: 'Award Shows', emoji: '🏆', tint: '#B43BFF', tropes: [
    ['🎵', 'Played off stage'], ['👯', 'Surprise reunion'], ['✊', 'Political speech'],
    ['📷', 'Camera on the loser'], ['👗', 'Wardrobe slip'], ['🕯️', 'In Memoriam tears'] ] },
]

function GenreCarousel() {
  const ref = useRef(null)
  const idx = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let stopped = false
    const stop = () => { stopped = true }
    el.addEventListener('pointerdown', stop, { once: true })   // yield to the user
    const id = setInterval(() => {
      const node = ref.current
      if (stopped || !node) return
      idx.current = (idx.current + 1) % node.children.length
      const card = node.children[idx.current]
      if (!card) return
      const delta = card.getBoundingClientRect().left - node.getBoundingClientRect().left
        - (node.clientWidth - card.clientWidth) / 2
      node.scrollBy({ left: delta, behavior: 'smooth' })
    }, 3800)
    return () => { clearInterval(id); el.removeEventListener('pointerdown', stop) }
  }, [])
  return (
    <section className="lp-genres">
      <h2 className="display">Spot these live</h2>
      <div className="genre-row" ref={ref}>
        {GENRE_CARDS.map((g) => (
          <article className="genre-card" key={g.name} style={{ '--tint': g.tint }}>
            <div className="genre-head">
              <span className="genre-emoji">{g.emoji}</span>
              <span className="genre-name display">{g.name}</span>
            </div>
            <div className="genre-tiles">
              {g.tropes.map(([e, t]) => (
                <div className="genre-tile" key={t}><span className="ge">{e}</span><span className="gt">{t}</span></div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="genre-hint dim">swipe through the chaos →</div>
    </section>
  )
}
