// Verifies points scoring: Dab +1, Snap +3 (=+2 bonus), repeat +1. Run after the
// points_scoring migration. node scripts/points-smoke.mjs
import { createClient } from '@supabase/supabase-js'
const URL = 'https://xyahxwtxwspqpeuvoeak.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI'
const mk = (t) => createClient(URL, KEY, { auth: { storageKey: `sb-${t}`, persistSession: false, autoRefreshToken: false } })
const ok = (l, { error, data }) => { if (error) { console.error(`❌ ${l}:`, error.message); process.exit(1) } return data }
const tropes = Array.from({ length: 25 }, (_, i) => ({ emoji: '⭐', text: `T${i}` }))

const host = mk('p-host'), p = mk('p-join')
await host.auth.signInAnonymously(); await host.rpc('ensure_player')
const game = ok('create', await host.rpc('create_game', { p_genre_id: null, p_pattern: 'blackout', p_is_public: false, p_max_players: 8, p_theme: {}, p_custom_tropes: tropes, p_watching: 'Points' }))
await p.auth.signInAnonymously(); await p.rpc('ensure_player')
ok('join', await p.rpc('join_game', { p_code: game.code, p_name: 'Scorer', p_card: [] }))
ok('start', await host.rpc('start_game', { p_game_id: game.id }))

const s1 = ok('dab [0,1]', await p.rpc('mark_square', { p_game_id: game.id, p_marked: [0, 1] }))
console.log(`  after dab x2 → score ${s1.score} (expect 2)`)
const s2 = ok('snap', await p.rpc('record_snap', { p_game_id: game.id }))
console.log(`  after snap → score ${s2.score} (expect 4), photos ${s2.photos_taken}`)
const s3 = ok('repeat', await p.rpc('record_repeat', { p_game_id: game.id }))
console.log(`  after repeat → score ${s3.score} (expect 5), extra_taps ${s3.extra_taps}`)

await host.rpc('end_game', { p_game_id: game.id }).catch(() => {})
const pass = s1.score === 2 && s2.score === 4 && s3.score === 5
console.log(pass ? '\n✅ POINTS SCORING CORRECT' : '\n❌ scoring mismatch')
process.exit(pass ? 0 : 1)
