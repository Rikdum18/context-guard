export type GuardState = {
  /** The warn toast was shown once for this fill of the window. */
  warned: boolean
  /** The context percent at which the files were last written; null before the first write. */
  lastWrittenAt: number | null
  /** A write (fork + file writes) is in flight. */
  isWriting: boolean
}

/** The character's dialog, while it is up. */
export type Npc = {
  /** What the character says. */
  message: string
  /** Animation frame, advanced by a timer. */
  frame: number
  /** The prompt for the next chat, for the copy button; null when none was found. */
  promptText: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-guard': { guard: GuardState; npc: Npc | null }
  }
}
