// Root-cause probe for "web player can't join". Reproduces App.jsx handleJoin
// exactly with TWO independent anon sessions (host + web joiner) against the LIVE
// db. Tests both the status-gating path and the cross-session RLS SELECT on games
// + player_states that fetchGame/fetchPlayerStates depend on right after join.
// Throwaway rows only; host ends the game at the end. Run: node scripts/join-rootcause.mjs
import { createClient } from '@supabase/supabase-js'

const URL = 'https://xyahxwtxwspqpeuvoeak.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI'
const mk = (t) => createClient(URL, KEY, { auth: { storageKey: `sb-${t}`, persistSession: false, autoRefreshToken: false } })
const tropes = Array.from({ length: 25 }, (_, i) => ({ emoji: '⭐', text: `T${i + 1}` }))
const theme = { accentPrimary: '#6C4DFF', backgroundGradient: { angle: 135, colors: ['#000', '#111'] } }

const r = (label, { error, data }) => {
  if (error) { console.log(`   ${label}: ERROR ${error.code || ''} ${error.message || error}`); return null }
  console.log(`   ${label}: OK`)
  return data
}

async function joinFlow(joiner, code, label) {
  // mirrors App.jsx handleJoin: join_game -> fetchGame -> fetchPlayerStates
  const { data: ps, error: je } = await joiner.rpc('join_game', { p_code: code, p_name: label, p_card: [] })
  if (je) return { stage: 'join_game', err: je }
  const { data: g, error: ge } = await joiner.from('games').select('*').eq('id', ps.game_id).single()
  if (ge) return { stage: 'fetchGame(SELECT games)', err: ge, ps }
  const { data: pls, error: pe } = await joiner.from('player_states').select('*').eq('game_id', ps.game_id)
  if (pe) return { stage: 'fetchPlayerStates(SELECT player_states)', err: pe, ps, g }
  return { stage: 'complete', ps, g, players: pls }
}

async function main() {
  const host = mk('rc-host')
  console.log('— HOST sets up a throwaway game —')
  r('host anon sign-in', await host.auth.signInAnonymously())
  await host.rpc('ensure_player')
  const { data: game } = await host.rpc('create_game', {
    p_genre_id: null, p_pattern: 'line', p_is_public: false, p_max_players: 8,
    p_theme: theme, p_custom_tropes: tropes, p_watching: 'ROOTCAUSE TEST',
  })
  console.log(`   code=${game.code} status=${game.status} id=${game.id}`)

  console.log('\n— CASE A: web joiner joins while status=waiting (lobby) —')
  const jA = mk('rc-joinA')
  r('joinerA anon sign-in', await jA.auth.signInAnonymously())
  await jA.rpc('ensure_player')
  const a = await joinFlow(jA, game.code, 'WebA')
  if (a.err) console.log(`   ==> FAILED at ${a.stage}: ${a.err.code || ''} ${a.err.message}`)
  else console.log(`   ==> SUCCESS through ${a.stage}; joiner sees game.watching="${a.g.watching}", players=${a.players.length}`)

  console.log('\n— Host starts the game (status -> playing) —')
  const { data: started } = await host.rpc('start_game', { p_game_id: game.id })
  console.log(`   status now: ${started?.status}`)

  console.log('\n— CASE B: a NEW web joiner joins the SAME code while status=playing —')
  const jB = mk('rc-joinB')
  r('joinerB anon sign-in', await jB.auth.signInAnonymously())
  await jB.rpc('ensure_player')
  const b = await joinFlow(jB, game.code, 'WebB')
  if (b.err) console.log(`   ==> FAILED at ${b.stage}: ${b.err.code || ''} ${b.err.message}`)
  else console.log(`   ==> SUCCESS through ${b.stage}`)

  console.log('\n— CASE C: anon SELECT on games for a NON-member (RLS visibility of a private game) —')
  const jC = mk('rc-joinC')
  await jC.auth.signInAnonymously()
  await jC.rpc('ensure_player')
  const { data: cRows, error: cErr } = await jC.from('games').select('*').eq('id', game.id)
  if (cErr) console.log(`   ==> SELECT errored: ${cErr.message}`)
  else console.log(`   ==> non-member anon got ${cRows.length} row(s) (0 = RLS hides private game from non-members)`)

  console.log('\n— cleanup —')
  try { await host.rpc('end_game', { p_game_id: game.id }) } catch { /* ignore */ }
  console.log('   game ended (status=finished).')
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
