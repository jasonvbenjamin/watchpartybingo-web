// Headless 2-client backend smoke test: proves a web client can create, join,
// play, and win a game on the live Supabase backend — no browser/simulator.
// Two independent anonymous sessions = host + joiner. Run: node scripts/smoke.mjs
import { createClient } from '@supabase/supabase-js'

const URL = 'https://xyahxwtxwspqpeuvoeak.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI'

const mk = (tag) =>
  createClient(URL, KEY, { auth: { storageKey: `sb-${tag}`, persistSession: false, autoRefreshToken: false } })

const tropes = Array.from({ length: 25 }, (_, i) => ({ emoji: '⭐', text: `Trope ${i + 1}` }))
const theme = {
  accentPrimary: '#6C4DFF', accentSecondary: '#FF2EA6', accentTertiary: '#165B33',
  markedSquareColor: '#10b981', decorativeEmojis: ['🎬'],
  backgroundGradient: { angle: 135, colors: ['#6C4DFF', '#FF2EA6'] },
}

const ok = (label, { error, data }) => {
  if (error) { console.error(`❌ ${label}:`, error.message || error); process.exit(1) }
  console.log(`✅ ${label}`)
  return data
}

async function main() {
  const host = mk('host'), joiner = mk('join')

  console.log('— HOST —')
  ok('host anon sign-in', await host.auth.signInAnonymously())
  await host.rpc('ensure_player')
  const game = ok('create_game', await host.rpc('create_game', {
    p_genre_id: null, p_pattern: 'line', p_is_public: false, p_max_players: 8,
    p_theme: theme, p_custom_tropes: tropes, p_watching: 'Node Smoke Test',
  }))
  console.log(`   → code ${game.code}, status ${game.status}, players ${game.player_count}`)

  console.log('— JOINER —')
  ok('joiner anon sign-in', await joiner.auth.signInAnonymously())
  await joiner.rpc('ensure_player')
  const ps = ok('join_game by code', await joiner.rpc('join_game', { p_code: game.code, p_name: 'Joiner', p_card: [] }))
  console.log(`   → joined game ${ps.game_id} as ${ps.name}`)

  const g2 = ok('joiner fetch game', await joiner.from('games').select('*').eq('id', game.id).single())
  console.log(`   → joiner sees ${g2.player_count} players, watching "${g2.watching}", ${(g2.custom_tropes||[]).length} tropes`)

  console.log('— PLAY —')
  const started = ok('host start_game', await host.rpc('start_game', { p_game_id: game.id }))
  console.log(`   → status ${started.status}`)
  ok('joiner mark a line (row 0)', await joiner.rpc('mark_square', { p_game_id: game.id, p_marked: [0, 1, 2, 3, 4] }))
  const claim = ok('joiner claim_bingo', await joiner.rpc('claim_bingo', { p_game_id: game.id }))
  console.log(`   → claim result: ${JSON.stringify(claim)}`)

  const final = ok('final game state', await joiner.from('games').select('status,winners,pending_winners').eq('id', game.id).single())
  console.log(`   → winners: ${JSON.stringify(final.winners)}`)

  // cleanup
  try { await host.rpc('end_game', { p_game_id: game.id }) } catch { /* ignore */ }

  const won = (final.winners || []).length > 0
  console.log(`\n${won ? '🎉 SMOKE TEST PASSED — web client can create, join, play, and win.' : '⚠️  Flow ran but no winner recorded — check claim_bingo.'}`)
  process.exit(won ? 0 : 2)
}

main().catch((e) => { console.error('💥 ERROR', e); process.exit(1) })
