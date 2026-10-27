import { createSignal } from "solid-js"
import { THEME_KEY, parseTheme, themeAttribute, type Theme } from "../core/theme"

function load(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return "system"
  }
}

const [theme, updateTheme] = createSignal<Theme>(load())

export { theme }

export function setTheme(value: Theme): void {
  const attr = themeAttribute(value)
  if (attr) document.documentElement.dataset.theme = attr
  else delete document.documentElement.dataset.theme
  try {
    if (value === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, value)
  } catch {}
  updateTheme(value)
}
