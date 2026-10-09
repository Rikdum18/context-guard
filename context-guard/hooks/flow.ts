import type { Pending } from '../types'
import {
  claudeMdDirs,
  currentGrimoire,
  extractPrompt,
  forkPrompt,
  grimoireAction,
  knownSuffixes,
  lineDiff,
  mergeHandoff,
  pickHandoffFile,
  projectFacts,
  renderSection,
  spliceSection,
  splitReply,
  suspiciousReasons,
  verifyGrimoire,
} from './logic'
import type { Verdict } from './logic'

// The whole write path, from the fork to the files, over the few things it needs from the engine. The hooks module
// hands these in as closures over `$`; the tests hand in memory.

export type Entry = { name: string; kind: string; mtimeMs: number }

export type ForkReply = { ok: true; text: string } | { ok: false; why: string }

export type Deps = {
  root: () => Promise<string>
  repo: () => Promise<{ root: string; name: string | null } | null>
  sessionId: () => Promise<string>
  model: () => Promise<string>
  now: () => Promise<number>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<readonly Entry[]>
  isLink: (path: string) => Promise<boolean>
  fork: (prompt: string) => Promise<ForkReply>
  /** The independent check: a reason when the text looks injected, null when it looks fine or could not run. */
  secondOpinion: (grimoire: string) => Promise<string | null>
  /** Labels of the outside sources the session read so far. */
  external: () => Promise<readonly string[]>
}

export type Settings = { handoffFile: string; updateClaudeMd: boolean }

export type GrimoireOutcome =
  | { kind: 'none' }
  | { kind: 'written'; where: string }
  | { kind: 'refused'; reason: 'link' | 'missing' | 'blocked'; where: string; detail: string }
  | { kind: 'review'; where: string; pending: Pending; diff: { added: string[]; removed: string[] } }

export type Outcome =
  | { kind: 'no-reply'; why: string }
  | { kind: 'handoff-is-link'; handoffFile: string }
  | { kind: 'done'; handoffFile: string; promptText: string | null; grimoire: GrimoireOutcome }

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.vercel', '__pycache__', '.venv', 'venv', '.turbo', '.cache'])
const MAX_DIRS = 800
const MAX_DEPTH = 7

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** The nearest CLAUDE.md within the project (see claudeMdDirs); `${root}/CLAUDE.md` when none is found. */
export async function findClaudeMd(d: Deps, root: string): Promise<string> {
  const repoRoot = (await d.repo().catch(() => null))?.root ?? null
  for (const dir of claudeMdDirs(root, repoRoot)) {
    const candidate = `${dir}/CLAUDE.md`
    if (await d.exists(candidate)) return candidate
  }
  return `${root}/CLAUDE.md`
}

/** The project's paths relative to `root`, files and folders, breadth first and bounded so a huge tree stays cheap. */
export async function projectPaths(d: Deps, root: string): Promise<string[]> {
  const paths: string[] = []
  let queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_DIRS) {
    const next: { rel: string; depth: number }[] = []
    for (const { rel, depth } of queue) {
      if (visited >= MAX_DIRS) break
      visited += 1
      const entries = await d.list(rel === '' ? root : `${root}/${rel}`).catch(() => [])
      for (const entry of entries) {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        paths.push(path)
        if (entry.kind === 'dir' && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) next.push({ rel: path, depth: depth + 1 })
      }
    }
    queue = next
  }
  return paths
}

export type Project = { root: string; claudePath: string; claudeMd: string | null; known: ReadonlySet<string>; facts: string }

/** Everything the grimoire is checked against: where it goes, what is there now, and the project's own files. */
export async function readProject(d: Deps, root: string): Promise<Project> {
  const claudePath = await findClaudeMd(d, root)
  const claudeMd = (await d.exists(claudePath)) ? await d.read(claudePath) : null
  const paths = await projectPaths(d, root)
  const repo = await d.repo().catch(() => null)
  let packageName: string | null = null
  if (await d.exists(`${root}/package.json`)) {
    try {
      const pkg: unknown = JSON.parse(await d.read(`${root}/package.json`))
      const name = typeof pkg === 'object' && pkg !== null ? (pkg as { name?: unknown }).name : undefined
      packageName = typeof name === 'string' ? name.slice(0, 100) : null
    } catch {
      packageName = null
    }
  }
  const facts = projectFacts({
    root,
    topLevel: paths.filter(p => !p.includes('/')),
    packageName,
    repoName: repo && repo.root === root ? (repo.name ?? root.replace(/^.*\//, '')) : null,
  })
  return { root, claudePath, claudeMd, known: knownSuffixes(paths), facts }
}

/** What the project already says about itself: the text a grimoire's addresses are checked against. */
export async function knownText(d: Deps, root: string, claudeMd: string | null): Promise<string> {
  const parts = [claudeMd ?? '']
  for (const name of ['README.md', 'AGENTS.md', 'package.json']) {
    const path = `${root}/${name}`
    if (await d.exists(path)) parts.push(await d.read(path).catch(() => ''))
  }
  return parts.join('\n')
}

export function describeMissing(v: Verdict): string {
  const shown = v.missing.slice(0, 3).map(p => `\`${p}\``).join(', ')
  return `${v.missing.length} percorsi su ${v.checked} non esistono qui (es. ${shown})`
}

/** Asks the model for the handoff and the grimoire, writes the handoff, and decides what happens to the grimoire. */
export async function generate(d: Deps, s: Settings, percent: number): Promise<Outcome> {
  const root = await d.root()
  const project = s.updateClaudeMd ? await readProject(d, root) : null
  const current = project ? currentGrimoire(project.claudeMd) : null
  const validCurrent = project && current !== null && verifyGrimoire(current, project.known).isOk ? current : null

  const reply = await d.fork(
    forkPrompt({
      withGrimoire: s.updateClaudeMd,
      handoffFile: s.handoffFile,
      root,
      facts: project?.facts ?? `- Cartella: ${root}`,
      current: validCurrent,
    }),
  )
  if (!reply.ok) return { kind: 'no-reply', why: reply.why }

  const { handoff, grimoire } = splitReply(reply.text)
  const date = isoDate(await d.now())

  const handoffFile = pickHandoffFile(await d.list(root).catch(() => []), s.handoffFile)
  const handoffPath = `${root}/${handoffFile}`
  if (await d.isLink(handoffPath)) return { kind: 'handoff-is-link', handoffFile }
  const previous = (await d.exists(handoffPath)) ? await d.read(handoffPath) : null
  await d.write(
    handoffPath,
    mergeHandoff(previous, handoff, { date, percent, sessionId: await d.sessionId(), model: await d.model() }),
  )
  const promptText = extractPrompt(handoff)

  if (project === null || grimoire === null) return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'none' } }

  const where = project.claudePath.replace(root, '.')
  const v = verifyGrimoire(grimoire, project.known)
  const isLink = await d.isLink(project.claudePath)
  const suspicious = v.isOk && !isLink ? suspiciousReasons(grimoire, await knownText(d, root, project.claudeMd)) : []
  const external = [...(await d.external())]
  // The independent check costs a small model call: only for a grimoire that passed everything cheaper.
  const opinion = v.isOk && !isLink && suspicious.length === 0 ? await d.secondOpinion(grimoire).catch(() => null) : null

  const action = grimoireAction({ isLink, matchesProject: v.isOk, suspicious, external, secondOpinion: opinion })
  const day = date.slice(0, 10)

  switch (action) {
    case 'link':
      return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'refused', reason: 'link', where, detail: `${where} e' un link simbolico` } }
    case 'missing':
      return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'refused', reason: 'missing', where, detail: describeMissing(v) } }
    case 'blocked':
      return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'refused', reason: 'blocked', where, detail: suspicious.join('; ') } }
    case 'review': {
      const why = [
        ...(external.length > 0 ? [`contenuti da ${external.join(', ')}`] : []),
        ...(opinion !== null ? [`controllo indipendente: ${opinion}`] : []),
      ]
      const pending: Pending = { claudePath: project.claudePath, text: grimoire, date: day, why }
      return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'review', where, pending, diff: lineDiff(current, grimoire) } }
    }
    case 'write':
      await d.write(project.claudePath, spliceSection(project.claudeMd, renderSection(grimoire, day)))
      return { kind: 'done', handoffFile, promptText, grimoire: { kind: 'written', where } }
  }
}

/** Writes a grimoire the person approved, into its CLAUDE.md read afresh so edits made meanwhile are kept. */
export async function applyApproved(d: Deps, pending: Pending): Promise<'written' | 'link'> {
  if (await d.isLink(pending.claudePath)) return 'link'
  const fresh = (await d.exists(pending.claudePath)) ? await d.read(pending.claudePath) : null
  await d.write(pending.claudePath, spliceSection(fresh, renderSection(pending.text, pending.date)))
  return 'written'
}

/** At session start: a message when the grimoire this project carries names paths the project does not have. */
export async function checkExisting(d: Deps): Promise<string | null> {
  const project = await readProject(d, await d.root())
  const current = currentGrimoire(project.claudeMd)
  if (current === null) return null
  const v = verifyGrimoire(current, project.known)
  if (v.isOk) return null
  const where = project.claudePath.replace(project.root, '.')
  return `il grimorio in ${where} sembra di un altro progetto: ${describeMissing(v)}`
}
