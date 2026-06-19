// Turn a game's GenreThemePayload into CSS the web board can wear, so a web
// player matches the look the host picked on iOS.

export function gradientCss(g, fallback = 'linear-gradient(160deg,#08080C 0%,#101016 55%,#15121d 100%)') {
  if (!g || !Array.isArray(g.colors) || g.colors.length === 0) return fallback
  const angle = typeof g.angle === 'number' ? g.angle : 160
  return `linear-gradient(${angle}deg, ${g.colors.join(', ')})`
}

/** CSS custom properties for the game surface. New design language: ONE signature
 *  accent (the logo spectrum) app-wide — so we do NOT override --accent/--marked
 *  per genre. The genre only tints the backdrop, which `.game` then dims to a quiet
 *  atmospheric glow over the near-black ink base. */
export function themeVars(theme) {
  if (!theme) return {}
  return { '--bg-game': gradientCss(theme.backgroundGradient) }
}
