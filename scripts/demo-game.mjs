// Creates a live NBA demo game you can join from the web player to see the
// polished board immediately (no simulator needed). Also verifies that joining a
// game that's already 'playing' works. Run: node scripts/demo-game.mjs
import { createClient } from '@supabase/supabase-js'

const URL = 'https://xyahxwtxwspqpeuvoeak.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI'
const mk = (t) => createClient(URL, KEY, { auth: { storageKey: `sb-${t}`, persistSession: false, autoRefreshToken: false } })

const tropes = [
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
const theme = {
  accentPrimary: '#F0820F', accentSecondary: '#1D428A', accentTertiary: '#C8102E',
  markedSquareColor: 'linear-gradient(135deg,#F0820F,#C8102E)', decorativeEmojis: ['🏀', '🔥', '🏆'],
  backgroundGradient: { angle: 160, colors: ['#0a0a0f', '#0e1430', '#3a1d0a'] },
}

const host = mk('demo-host')
await host.auth.signInAnonymously()
await host.rpc('ensure_player')
const { data: game, error: ce } = await host.rpc('create_game', {
  p_genre_id: null, p_pattern: 'line', p_is_public: false, p_max_players: 8,
  p_theme: theme, p_custom_tropes: tropes, p_watching: 'NBA Games',
})
if (ce) { console.error('create failed', ce.message); process.exit(1) }
await host.rpc('start_game', { p_game_id: game.id })

// verify a second client can join while the game is already playing
const probe = mk('demo-probe')
await probe.auth.signInAnonymously()
await probe.rpc('ensure_player')
const { error: je } = await probe.rpc('join_game', { p_code: game.code, p_name: 'Probe', p_card: [] })

console.log(`\nDEMO CODE:  ${game.code}`)
console.log(`JOIN URL:   http://localhost:5173/join/${game.code}`)
console.log(`join-while-playing: ${je ? '❌ ' + je.message : '✅ works'}`)
process.exit(0)
