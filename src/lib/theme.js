// Turn a game's GenreThemePayload into CSS the web board can wear, so a web
// player matches the look the host picked on iOS.

export function gradientCss(g, fallback = 'linear-gradient(160deg,#0a0a0f 0%,#15131f 55%,#2a1d3a 100%)') {
  if (!g || !Array.isArray(g.colors) || g.colors.length === 0) return fallback
  const angle = typeof g.angle === 'number' ? g.angle : 160
  return `linear-gradient(${angle}deg, ${g.colors.join(', ')})`
}

/** Marked-tile fill: theme may give a hex or a full gradient string; both work. */
function markedFill(c) {
  if (!c) return 'linear-gradient(135deg,#6C4DFF,#FF2EA6)'
  return c
}

/** CSS custom properties to spread onto the root game element via style={}. */
export function themeVars(theme) {
  if (!theme) return {}
  return {
    '--accent': theme.accentPrimary || '#6C4DFF',
    '--accent-2': theme.accentSecondary || '#FF2EA6',
    '--marked': markedFill(theme.markedSquareColor),
    // A page backdrop: near-black at top easing into the theme's gradient below
    // (matches the iOS screens).
    '--bg-game': gradientCss(theme.backgroundGradient),
  }
}
