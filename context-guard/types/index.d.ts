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
  /** The grimoire change waiting for the person's ok, shown as a diff; null when nothing waits. */
  review: { added: string[]; removed: string[] } | null
}

/** A grimoire written in a session that read outside content: held until the person applies or discards it. */
export type Pending = {
  claudePath: string
  text: string
  date: string
  /** Why it waits: the outside sources the session read, and the independent check's reason when it had one. */
  why: string[]
}

/** One line of the chat with the Librarian. */
export type ChatLine = { who: 'tu' | 'bibliotecario'; text: string }

/** The chat with the Librarian: its lines, and whether an answer is on its way. */
export type Chat = { lines: ChatLine[]; isThinking: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-guard': { guard: GuardState; npc: Npc | null; external: string[]; pending: Pending | null; chat: Chat }
  }
}
