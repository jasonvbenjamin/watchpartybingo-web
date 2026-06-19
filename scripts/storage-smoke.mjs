// Verifies photo-Snap storage RLS: a member can upload + read; a non-member is
// denied. node scripts/storage-smoke.mjs
import { createClient } from '@supabase/supabase-js'
const URL = 'https://xyahxwtxwspqpeuvoeak.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI'
const mk = (t) => createClient(URL, KEY, { auth: { storageKey: `sb-${t}`, persistSession: false, autoRefreshToken: false } })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
let fails = 0
const check = (cond, label) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) fails++ }

const host = mk('st-host'), joiner = mk('st-join'), outsider = mk('st-out')
await host.auth.signInAnonymously(); await host.rpc('ensure_player')
const { data: game } = await host.rpc('create_game', { p_genre_id: null, p_pattern: 'line', p_is_public: false, p_max_players: 8, p_theme: {}, p_custom_tropes: [], p_watching: 'Snap test' })
await joiner.auth.signInAnonymously(); await joiner.rpc('ensure_player')
await joiner.rpc('join_game', { p_code: game.code, p_name: 'Joiner', p_card: [] })
await outsider.auth.signInAnonymously(); await outsider.rpc('ensure_player')

const uid = (await joiner.auth.getUser()).data.user.id
const path = `${game.id}/${uid}/test.png`

const up = await joiner.storage.from('snaps').upload(path, png, { contentType: 'image/png', upsert: true })
check(!up.error, `member uploads photo${up.error ? ' — ' + up.error.message : ''}`)

const ins = await joiner.from('snaps').insert({ game_id: game.id, user_id: uid, name: 'Joiner', square_index: 5, trope_text: 'Corner Three', path })
check(!ins.error, `member inserts snap row${ins.error ? ' — ' + ins.error.message : ''}`)

const hostRows = await host.from('snaps').select('*').eq('game_id', game.id)
check(!hostRows.error && (hostRows.data || []).length >= 1, `host (member) reads ${(hostRows.data || []).length} snap(s)`)

const signed = await host.storage.from('snaps').createSignedUrl(path, 60)
check(!signed.error && !!signed.data?.signedUrl, `host (member) gets signed URL${signed.error ? ' — ' + signed.error.message : ''}`)

const outRows = await outsider.from('snaps').select('*').eq('game_id', game.id)
check(!outRows.error && (outRows.data || []).length === 0, `outsider sees 0 snap rows (RLS blocks)`)

const outSign = await outsider.storage.from('snaps').createSignedUrl(path, 60)
check(!!outSign.error, `outsider denied signed URL (RLS blocks)`)

// cleanup
await joiner.storage.from('snaps').remove([path])
try { await host.rpc('end_game', { p_game_id: game.id }) } catch { /* ignore */ }

console.log(fails === 0 ? '\n✅ STORAGE RLS CORRECT — members only.' : `\n❌ ${fails} check(s) failed.`)
process.exit(fails === 0 ? 0 : 1)
