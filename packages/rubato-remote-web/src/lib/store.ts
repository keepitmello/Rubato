import { create } from "zustand"
import type { RegisteredHost } from "./types"

interface Preferences {
  darkMode: "system" | "light" | "dark"
  reducedTransparency: boolean
  terminalFontSize: number
  pushEnabled: boolean
  favorites: readonly string[]
}

interface AppState {
  hosts: readonly RegisteredHost[]
  preferences: Preferences
  setHosts: (hosts: readonly RegisteredHost[]) => void
  updatePreferences: (next: Partial<Preferences>) => void
  toggleFavorite: (path: string) => void
}

const storedPreferences = (): Preferences => {
  try {
    const value = JSON.parse(localStorage.getItem("rubato.preferences") ?? "null") as Partial<Preferences> | null
    return { darkMode: "system", reducedTransparency: false, terminalFontSize: 14, pushEnabled: false, favorites: [], ...value }
  } catch {
    return { darkMode: "system", reducedTransparency: false, terminalFontSize: 14, pushEnabled: false, favorites: [] }
  }
}

export const useAppStore = create<AppState>((set) => ({
  hosts: [],
  preferences: storedPreferences(),
  setHosts: (hosts) => set({ hosts }),
  updatePreferences: (next) => set((state) => {
    const preferences = { ...state.preferences, ...next }
    localStorage.setItem("rubato.preferences", JSON.stringify(preferences))
    return { preferences }
  }),
  toggleFavorite: (path) => set((state) => {
    const favorites = state.preferences.favorites.includes(path) ? state.preferences.favorites.filter((item) => item !== path) : [...state.preferences.favorites, path]
    const preferences = { ...state.preferences, favorites }
    localStorage.setItem("rubato.preferences", JSON.stringify(preferences))
    return { preferences }
  }),
}))
