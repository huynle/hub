export const THEMES = ["light", "system", "dark"] as const
export type Theme = (typeof THEMES)[number]
export const THEME_KEY = "hub.theme"

export function parseTheme(value: string | null): Theme {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme
}
