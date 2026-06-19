// Data layer for the web player — talks to the SAME Supabase backend + RPCs as
// the iOS app. Signatures confirmed against the live DB:
//   join_game(p_code text, p_name text, p_card jsonb)  -> player_states
//   mark_square(p_game_id uuid, p_marked jsonb)        -> player_states
//   claim_bingo(p_game_id uuid)                        -> jsonb
//   start_game / approve_winner / leave_game / ensure_player / list_public_games
// Realtime mirrors the iOS RealtimeService: channel topic `game:<id>`, postgres
// changes on `games` (id=eq) and `player_states` (game_id=eq).

import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
})

/** Ensure an anonymous session + a players row; returns the auth user id. */
export async function ensureSession() {
  let { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    const { error } = await supabase.auth.signInAnonymously()
    if (error) throw error
  }
  // Best-effort: make sure a players row exists for this user (display_name etc).
  await supabase.rpc('ensure_player').catch(() => {})
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

/** Join by code. Pass an empty card — like iOS, each client generates its own
 *  card locally (wins are positional, validated server-side). Returns the
 *  player_states row (carries game_id). */
export async function joinGame(code, name, card = []) {
  const { data, error } = await supabase.rpc('join_game', {
    p_code: code, p_name: name, p_card: card,
  })
  if (error) throw error
  return data
}

export async function fetchGame(gameId) {
  const { data, error } = await supabase.from('games').select('*').eq('id', gameId).single()
  if (error) throw error
  return data
}

export async function fetchPlayerStates(gameId) {
  const { data, error } = await supabase.from('player_states').select('*').eq('game_id', gameId)
  if (error) throw error
  return data ?? []
}

/** Persist the full intended marked set (array of cell indices 0..24). */
export async function markSquare(gameId, marked) {
  const { data, error } = await supabase.rpc('mark_square', {
    p_game_id: gameId, p_marked: marked,
  })
  if (error) throw error
  return data
}

/** Client detects a likely bingo; server recomputes + decides (.won/.pending). */
export async function claimBingo(gameId) {
  const { data, error } = await supabase.rpc('claim_bingo', { p_game_id: gameId })
  if (error) throw error
  return data
}

/** Snap (photo) — +2 bonus on top of the square's dab point (= 3 total). */
export async function recordSnap(gameId) {
  const { data, error } = await supabase.rpc('record_snap', { p_game_id: gameId })
  if (error) throw error
  return data
}

/** Repeat tap on an already-marked square — +1. */
export async function recordRepeat(gameId) {
  const { data, error } = await supabase.rpc('record_repeat', { p_game_id: gameId })
  if (error) throw error
  return data
}

/** Upload a Snap photo to the private members-only bucket + record metadata.
 *  Scoring (+3) is handled by record_snap via the interaction flow, not here. */
export async function uploadSnap(gameId, userId, file, { squareIndex, tropeText, name }) {
  const ext = (file.type?.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
  const path = `${gameId}/${userId}/${crypto.randomUUID()}.${ext}`
  const up = await supabase.storage.from('snaps').upload(path, file, { contentType: file.type || 'image/jpeg' })
  if (up.error) throw up.error
  await supabase.from('snaps').insert({
    game_id: gameId, user_id: userId, name, square_index: squareIndex, trope_text: tropeText, path,
  })
  return path
}

export async function leaveGame(gameId) {
  await supabase.rpc('leave_game', { p_game_id: gameId }).catch(() => {})
}

/** Subscribe to a game's live changes. Calls onGame(newGameRow) on any games
 *  change and onPlayers() whenever a player_states row changes (caller refetches).
 *  Returns an unsubscribe function. */
export function subscribeGame(gameId, { onGame, onPlayers, onStatus, onPulse } = {}) {
  const channel = supabase
    .channel(`game:${gameId}`, { config: { broadcast: { self: false } } })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => onGame?.(payload.new))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'player_states', filter: `game_id=eq.${gameId}` },
      () => onPlayers?.())
    .on('broadcast', { event: 'tap_pulse' }, ({ payload }) => onPulse?.(payload))
    .subscribe((status) => onStatus?.(status))
  return {
    stop: () => { supabase.removeChannel(channel) },
    // Ephemeral "I just marked a square" ping (matches iOS tap_pulse broadcast).
    pulse: (payload) => { channel.send({ type: 'broadcast', event: 'tap_pulse', payload }) },
  }
}
