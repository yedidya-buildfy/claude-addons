export type Draft = string

declare module 'claude-code' {
  interface PluginState {
    'hebrew-rtl': { draft: Draft }
  }
}
