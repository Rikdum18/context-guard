import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GuardState, Npc, Pending } from '../types'
import {
  INITIAL_STATE,
  animate,
  decide,
  claudeMdDirs,
  currentGrimoire,
  externalLabel,
  grimoireAction,
  extractPrompt,
  isExternalTool,
  lineDiff,
  suspiciousReasons,
  knownSuffixes,
  projectFacts,
  verifyGrimoire,
  mergeHandoff,
  pickHandoffFile,
  forkPrompt,
  renderSection,
  safeFileName,
  spliceSection,
  splitReply,
  thresholdsOf,
} from './logic'
import type { Thresholds, Verdict } from './logic'
import { OWL, SPRITE_WIDTH, spriteRaster, spriteSvg } from './sprite'

type Config = { thresholds: Thresholds; handoffFile: string; updateClaudeMd: boolean }

const GUARD = { plugin: 'context-guard', key: 'guard' } as const
const NPC = { plugin: 'context-guard', key: 'npc' } as const
const EXTERNAL = { plugin: 'context-guard', key: 'external' } as const
const PENDING = { plugin: 'context-guard', key: 'pending' } as const
const PANE = 'context-guard-npc'
const MAX_REVIEW_LINES = 14
const TICK_MS = 50
const MAX_FRAMES = 400
const SVG_SCALE = 6
const RASTER = spriteRaster(OWL)
const SVG = spriteSvg(OWL, SVG_SCALE)

let ticker: Timer | undefined

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

async function getGuard($: EngineInterface): Promise<GuardState> {
  const { value } = await $.state.get(GUARD)
  return value ?? INITIAL_STATE
}

async function setGuard($: EngineInterface, fn: (s: GuardState) => GuardState): Promise<void> {
  await $.state.set(GUARD, fn(await getGuard($)))
}

async function percentNow($: EngineInterface): Promise<number | undefined> {
  return (await $.session.usage()).context.percent
}

/** True when `path` is a symbolic link: the mod never writes through one, so a write cannot land outside the project. */
async function isLink($: EngineInterface, path: string): Promise<boolean> {
  return (await $.fs.stat(path).catch(() => null))?.isLink === true
}

/** The nearest CLAUDE.md within the project (see claudeMdDirs); `${root}/CLAUDE.md` when none is found. */
async function findClaudeMd($: EngineInterface, root: string): Promise<string> {
  const repoRoot = (await $.session.repo().catch(() => null))?.root ?? null
  for (const dir of claudeMdDirs(root, repoRoot)) {
    const candidate = `${dir}/CLAUDE.md`
    if (await $.fs.exists(candidate)) return candidate
  }
  return `${root}/CLAUDE.md`
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

/** Advances the dialog one frame; stops when the pane is gone or the blink has run long enough. */
async function tick($: EngineInterface): Promise<void> {
  const { value } = await $.state.get(NPC)
  if (value === null || value === undefined || value.frame >= MAX_FRAMES) {
    stopTicker()
    return
  }
  await $.state.set(NPC, { ...value, frame: value.frame + 1 })
}

/** Pops the character out of the left edge with `message`, as a dialog pane the person dismisses. */
async function showNpc(
  $: EngineInterface,
  message: string,
  promptText: string | null,
  review: Npc['review'] = null,
): Promise<void> {
  stopTicker()
  const npc: Npc = { message, frame: 0, promptText, review }
  await $.state.set(NPC, npc)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Passaggio di chat',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: review === null ? 16 : 18 + Math.min(MAX_REVIEW_LINES, review.added.length + review.removed.length),
  })
  if (!opened.isPlaced) return
  ticker = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

async function hideNpc($: EngineInterface): Promise<void> {
  stopTicker()
  await $.state.set(NPC, null)
  await $.ui.close({ id: PANE })
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.vercel', '__pycache__', '.venv', 'venv', '.turbo', '.cache'])
const MAX_DIRS = 800
const MAX_DEPTH = 7

/** The project's paths relative to `root`, files and folders, breadth first and bounded so a huge tree stays cheap. */
async function projectPaths($: EngineInterface, root: string): Promise<string[]> {
  const paths: string[] = []
  let queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_DIRS) {
    const next: { rel: string; depth: number }[] = []
    for (const { rel, depth } of queue) {
      if (visited >= MAX_DIRS) break
      visited += 1
      const entries = await $.fs.list(rel === '' ? root : `${root}/${rel}`).catch(() => [])
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

type Project = { root: string; claudePath: string; claudeMd: string | null; known: ReadonlySet<string>; facts: string }

/** Everything the grimoire is checked against: where it goes, what is there now, and the project's own files. */
async function readProject($: EngineInterface, root: string): Promise<Project> {
  const claudePath = await findClaudeMd($, root)
  const claudeMd = (await $.fs.exists(claudePath)) ? await $.fs.read(claudePath) : null
  const paths = await projectPaths($, root)
  const repo = await $.session.repo().catch(() => null)
  let packageName: string | null = null
  if (await $.fs.exists(`${root}/package.json`)) {
    try {
      const pkg: unknown = JSON.parse(await $.fs.read(`${root}/package.json`))
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

function describeMissing(v: Verdict): string {
  const shown = v.missing.slice(0, 3).map(p => `\`${p}\``).join(', ')
  return `${v.missing.length} percorsi su ${v.checked} non esistono qui (es. ${shown})`
}

/** At session start: says so when the grimoire this project carries names paths the project does not have. */
async function checkExistingGrimoire($: EngineInterface): Promise<void> {
  const project = await readProject($, await $.session.root())
  const current = currentGrimoire(project.claudeMd)
  if (current === null) return
  const v = verifyGrimoire(current, project.known)
  if (v.isOk) return
  const where = project.claudePath.replace(project.root, '.')
  $.ui.log(`context-guard: il grimorio in ${where} sembra di un altro progetto: ${describeMissing(v)}. /ctx-handoff lo rigenera.`)
  $.ui.toast(`Il grimorio in ${where} sembra di un altro progetto. /ctx-handoff lo rigenera.`, { timeoutMs: 10000 })
}

/** Records that the session read content from outside the machine; the grimoire then waits for the person's ok. */
async function markExternal($: EngineInterface, label: string): Promise<void> {
  const { value } = await $.state.get(EXTERNAL)
  const list = value ?? []
  if (!list.includes(label)) await $.state.set(EXTERNAL, [...list, label].slice(-20))
}

/** What the project already says about itself: the text a grimoire's addresses are checked against. */
async function knownText($: EngineInterface, root: string, claudeMd: string | null): Promise<string> {
  const parts = [claudeMd ?? '']
  for (const name of ['README.md', 'AGENTS.md', 'package.json']) {
    const path = `${root}/${name}`
    if (await $.fs.exists(path)) parts.push(await $.fs.read(path).catch(() => ''))
  }
  return parts.join('\n')
}

/** Writes the waiting grimoire into its CLAUDE.md, read afresh so edits made meanwhile are kept. */
async function applyPending($: EngineInterface): Promise<void> {
  const { value: pending } = await $.state.get(PENDING)
  if (pending === null || pending === undefined) return
  if (await isLink($, pending.claudePath)) {
    $.ui.toast("context-guard: CLAUDE.md e' un link simbolico, non lo scrivo")
    return
  }
  const fresh = (await $.fs.exists(pending.claudePath)) ? await $.fs.read(pending.claudePath) : null
  await $.fs.write(pending.claudePath, spliceSection(fresh, renderSection(pending.text, pending.date)))
  await $.state.set(PENDING, null)
  $.ui.log(`context-guard: grimorio applicato in ${pending.claudePath} dopo la tua conferma`)
  $.ui.toast('Grimorio applicato in CLAUDE.md')
  await hideNpc($)
}

async function discardPending($: EngineInterface): Promise<void> {
  await $.state.set(PENDING, null)
  $.ui.log('context-guard: grimorio proposto scartato')
  $.ui.toast('Grimorio scartato: CLAUDE.md non toccato')
  await hideNpc($)
}

/** Reopens the dialog on the grimoire that waits, if any. */
async function showPending($: EngineInterface): Promise<string> {
  const { value: pending } = await $.state.get(PENDING)
  if (pending === null || pending === undefined) return 'context-guard: nessun grimorio in attesa di conferma.'
  const before = (await $.fs.exists(pending.claudePath)) ? currentGrimoire(await $.fs.read(pending.claudePath)) : null
  await showNpc(
    $,
    `Questo grimorio aspetta il tuo ok: nella sessione sono entrati contenuti da ${pending.sources.join(', ')}. Controlla le modifiche e premi A per applicarle o S per scartarle.`,
    null,
    lineDiff(before, pending.text),
  )
  return 'context-guard: grimorio in attesa mostrato.'
}

/** A compaction or a /clear empties the window: start the thresholds over. */
async function reset($: EngineInterface): Promise<void> {
  await setGuard($, () => ({ ...INITIAL_STATE }))
  $.ui.status(undefined)
}

/** Asks the model for the handoff and the grimoire over the session's own transcript, then writes both. */
async function writeFiles($: EngineInterface, cfg: Config, percent: number): Promise<string> {
  const state = await getGuard($)
  if (state.isWriting) return "context-guard: una scrittura e' gia' in corso."
  await setGuard($, s => ({ ...s, isWriting: true }))
  $.ui.status(`ctx ${percent}% | scrivo ${cfg.handoffFile}...`)

  try {
    const root = await $.session.root()
    const project = cfg.updateClaudeMd ? await readProject($, root) : null
    const current = project ? currentGrimoire(project.claudeMd) : null
    const validCurrent = project && current !== null && verifyGrimoire(current, project.known).isOk ? current : null
    const reply = await $.model.fork({
      prompt: forkPrompt({
        withGrimoire: cfg.updateClaudeMd,
        handoffFile: cfg.handoffFile,
        root,
        facts: project?.facts ?? `- Cartella: ${root}`,
        current: validCurrent,
      }),
    })
    if (!reply.isAnswered) {
      const why = reply.reason === 'api-error' ? `api-error ${reply.status}` : reply.reason
      $.ui.toast(`context-guard: handoff non scritto (${why})`)
      return `context-guard: il modello non ha risposto (${why}).`
    }

    const { handoff, grimoire } = splitReply(reply.text)
    const date = isoDate(await $.clock.now())
    const written: string[] = []

    const handoffFile = pickHandoffFile(await $.fs.list(root).catch(() => []), cfg.handoffFile)
    const handoffPath = `${root}/${handoffFile}`
    if (await isLink($, handoffPath)) {
      $.ui.toast(`context-guard: ${handoffFile} e' un link simbolico, non lo scrivo`)
      return `context-guard: ${handoffFile} e' un link simbolico: nessun file scritto.`
    }
    const previous = (await $.fs.exists(handoffPath)) ? await $.fs.read(handoffPath) : null
    await $.fs.write(
      handoffPath,
      mergeHandoff(previous, handoff, {
        date,
        percent,
        sessionId: await $.session.id(),
        model: await $.session.model(),
      }),
    )
    written.push(handoffFile)

    let refused: string | null = null
    let refusedNote = ''
    let review: Npc['review'] = null
    let reviewSources: string[] = []
    if (project !== null && grimoire !== null) {
      const v = verifyGrimoire(grimoire, project.known)
      const where = project.claudePath.replace(root, '.')
      const reasons = v.isOk ? suspiciousReasons(grimoire, await knownText($, root, project.claudeMd)) : []
      const external = (await $.state.get(EXTERNAL)).value ?? []
      const action = grimoireAction({
        isLink: await isLink($, project.claudePath),
        matchesProject: v.isOk,
        suspicious: reasons,
        external,
      })
      if (action === 'link') {
        refused = `grimorio NON scritto: ${where} e' un link simbolico`
        refusedNote = " Il grimorio pero' non l'ho scritto: CLAUDE.md e' un link simbolico."
        $.ui.log(`context-guard: ${refused}`)
      } else if (action === 'missing') {
        refused = `grimorio NON scritto in ${where}: ${describeMissing(v)}`
        refusedNote = " Il grimorio pero' non l'ho scritto: parlava di file che qui non esistono."
        $.ui.log(`context-guard: ${refused}. Percorsi mancanti: ${v.missing.join(', ')}`)
        $.ui.toast(`context-guard: ${refused}`, { timeoutMs: 10000 })
      } else if (action === 'blocked') {
        refused = `grimorio BLOCCATO in ${where}: ${reasons.join('; ')}`
        refusedNote = " Il grimorio pero' l'ho bloccato: conteneva testo sospetto, i motivi sono nella trascrizione."
        $.ui.log(`context-guard: ${refused}`)
        $.ui.toast(`context-guard: ${refused}`, { timeoutMs: 12000 })
      } else if (action === 'review') {
        const pending: Pending = { claudePath: project.claudePath, text: grimoire, date: date.slice(0, 10), sources: external }
        await $.state.set(PENDING, pending)
        review = lineDiff(currentGrimoire(project.claudeMd), grimoire)
        reviewSources = external
        $.ui.log(`context-guard: grimorio in attesa di conferma (sessione con contenuti da ${external.join(', ')}). /ctx-grimorio lo mostra.`)
      } else {
        await $.fs.write(project.claudePath, spliceSection(project.claudeMd, renderSection(grimoire, date.slice(0, 10))))
        written.push(`grimorio in ${where}`)
      }
    }

    await setGuard($, s => ({ ...s, lastWrittenAt: percent }))
    const line = `context-guard: scritti ${written.join(' e ')} al ${percent}% di contesto${refused ? `; ${refused}` : ''}`
    $.ui.log(line)

    const promptText = extractPrompt(handoff)
    await showNpc(
      $,
      `Ehi! Il contesto e' al ${percent}%. Ho scritto ${handoffFile}${
        written.length > 1 ? ' e aggiornato il grimorio in CLAUDE.md' : ''
      }.${refusedNote}${
        review !== null
          ? ` Il grimorio aspetta il tuo ok: in questa sessione sono entrati contenuti da ${reviewSources.join(', ')}. Controlla le modifiche qui sotto e premi A per applicarle o S per scartarle.`
          : ''
      } Quando sei pronto, apri una nuova chat e incolla il prompt${promptText ? ': premi C per copiarlo' : ' che trovi in fondo al file'}.`,
      promptText,
      review,
    )
    return line
  } finally {
    await setGuard($, s => ({ ...s, isWriting: false }))
    $.ui.status(`ctx ${percent}%`)
  }
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    thresholds: thresholdsOf(options),
    handoffFile: safeFileName(options.handoffFile, 'HANDOFF.md'),
    updateClaudeMd: options.updateClaudeMd !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ctx-handoff',
      description: `Scrive subito ${cfg.handoffFile} e il grimorio in CLAUDE.md`,
    })
    await $.command.register({
      name: 'ctx-grimorio',
      description: 'Mostra il grimorio in attesa di conferma, da applicare o scartare',
    })
    if (cfg.updateClaudeMd) {
      // Its own dispatch, so the walk of the project never delays the session's first prompt.
      $.clock.after(1500, () => {
        void checkExistingGrimoire($).catch(err => $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' }))
      })
    }
    return next(e)
  })

  on('command.run', { command: 'ctx-handoff' }, async $ => {
    const percent = (await percentNow($).catch(() => undefined)) ?? 0
    const text = await writeFiles($, cfg, percent)
    return { text }
  })

  on('command.run', { command: 'ctx-grimorio' }, async $ => ({ text: await showPending($) }))

  on('tool.call', async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    if (isExternalTool(e.tool, command)) await markExternal($, externalLabel(e.tool))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const percent = await percentNow($).catch(() => undefined)
    const state = await getGuard($)
    const d = decide(percent, state, cfg.thresholds)

    $.ui.status(d.status)
    if (d.warn) {
      await setGuard($, s => ({ ...s, warned: true }))
      $.ui.toast(
        `Contesto al ${percent}%: oltre il ${cfg.thresholds.writeAt}% scrivo ${cfg.handoffFile}. Valuta /compact o /ctx-handoff.`,
        { timeoutMs: 8000 },
      )
    }
    if (d.write && percent !== undefined) {
      // Its own dispatch: the turn ends now, and the fork is not cut by this hook's end.
      $.clock.after(50, () => {
        void writeFiles($, cfg, percent).catch(err =>
          $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' }),
        )
      })
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in r)) await reset($)
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await reset($)
      await $.state.set(EXTERNAL, [])
      await $.state.set(PENDING, null)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { value: npc } = await $.state.get(NPC)
    if (npc === null || npc === undefined) {
      return <Text dimColor>...</Text>
    }

    const a = animate(npc.message, npc.frame)
    const spriteWidth = SPRITE_WIDTH
    const boxWidth = Math.max(20, (e.props.bodyColumns ?? 80) - spriteWidth - a.marginLeft - 2)
    const sprite =
      e.surface === 'terminal'
        ? (() => {
            const { Raster } = $.ui.resolve(e)
            return <Raster key="owl" columns={RASTER.columns} rows={RASTER.rows} cells={RASTER.cells} />
          })()
        : (() => {
            const { Svg } = $.ui.resolve(e)
            return <Svg source={SVG} alt="Il Bibliotecario, un gufo in pixel art" width={SPRITE_WIDTH * SVG_SCALE} />
          })()

    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box flexDirection="row" alignItems="flex-end">
          <Box flexDirection="column" marginLeft={a.marginLeft} width={spriteWidth}>
            {sprite}
          </Box>
          <Box flexDirection="column" width={boxWidth} borderStyle="double" borderColor="white" paddingX={1}>
            <Text bold>Bibliotecario</Text>
            <Text wrap="wrap">
              {a.visible}
              {a.showCursor ? ' ▼' : ''}
            </Text>
          </Box>
        </Box>
        {a.isDone && npc.review !== null && (
          <Box flexDirection="column" marginLeft={spriteWidth + 1} marginTop={1} borderStyle="single" paddingX={1} width={boxWidth}>
            <Text bold>Modifiche al grimorio</Text>
            {npc.review.added.length + npc.review.removed.length === 0 && <Text dimColor>Nessuna modifica rispetto a ora.</Text>}
            {[
              ...npc.review.removed.map(l => ({ sign: '-', line: l })),
              ...npc.review.added.map(l => ({ sign: '+', line: l })),
            ]
              .slice(0, MAX_REVIEW_LINES)
              .map(d => (
                <Text color={d.sign === '+' ? 'green' : 'red'} wrap="truncate-end">
                  {d.sign} {d.line}
                </Text>
              ))}
            {npc.review.added.length + npc.review.removed.length > MAX_REVIEW_LINES && (
              <Text dimColor>
                ... altre {npc.review.added.length + npc.review.removed.length - MAX_REVIEW_LINES} righe
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="row" gap={1} marginLeft={spriteWidth + 1} marginTop={1}>
          {a.isDone && npc.review !== null && (
            <Button key="apply" label="Applica" hotkey="a" variant="primary" onPress={() => applyPending($)} />
          )}
          {a.isDone && npc.review !== null && (
            <Button key="discard" label="Scarta" hotkey="s" onPress={() => discardPending($)} />
          )}
          {a.isDone && npc.promptText !== null && (
            <Button
              key="copy"
              label="Copia prompt"
              hotkey="c"
              variant="primary"
              onPress={async press => {
                const r = await $.ui.copy({ text: npc.promptText ?? '', surface: press.surface })
                $.ui.toast(r.isCopied ? 'Prompt copiato negli appunti' : `Copia non riuscita (${r.reason})`)
              }}
            />
          )}
          {a.isDone && (
            <Button key="ok" label="Ok" hotkey="o" role="dismiss" onPress={() => hideNpc($)} />
          )}
        </Box>
      </Box>
    )
  })
}
