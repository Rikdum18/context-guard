import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GuardState, Npc, Pending } from '../types'
import { applyApproved, checkExisting, generate } from './flow'
import type { Deps, Outcome } from './flow'
import {
  INITIAL_STATE,
  SECOND_OPINION_SYSTEM,
  animate,
  currentGrimoire,
  decide,
  externalLabel,
  externalReadLabel,
  isExternalTool,
  lineDiff,
  parseSecondOpinion,
  safeFileName,
  secondOpinionPrompt,
  thresholdsOf,
} from './logic'
import type { Thresholds } from './logic'
import { OWL, SPRITE_WIDTH, spriteRaster, spriteSvg } from './sprite'

type Config = { thresholds: Thresholds; handoffFile: string; updateClaudeMd: boolean; aiCheck: boolean }

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

/** The independent check: a small model with no session, no tools and no history judges the grimoire as data. */
async function askSecondOpinion($: EngineInterface, grimoire: string): Promise<string | null> {
  const r = await $.model.complete({
    model: 'haiku',
    system: SECOND_OPINION_SYSTEM,
    prompt: secondOpinionPrompt(grimoire),
    maxTokens: 120,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!r.isAnswered) {
    $.ui.log(`context-guard: controllo indipendente non disponibile (${r.reason})`, { to: 'debug' })
    return null
  }
  return parseSecondOpinion(r.text)
}

/** What the write path needs from the engine, as closures over `$`. */
function engineDeps($: EngineInterface, cfg: Config): Deps {
  return {
    root: () => $.session.root(),
    repo: async () => {
      const r = await $.session.repo()
      return r === null ? null : { root: r.root, name: r.name }
    },
    sessionId: () => $.session.id(),
    model: () => $.session.model(),
    now: () => $.clock.now(),
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    isLink: async path => (await $.fs.stat(path).catch(() => null))?.isLink === true,
    fork: async prompt => {
      const r = await $.model.fork({ prompt })
      if (r.isAnswered) return { ok: true, text: r.text }
      return { ok: false, why: r.reason === 'api-error' ? `api-error ${r.status}` : r.reason }
    },
    secondOpinion: grimoire => (cfg.aiCheck ? askSecondOpinion($, grimoire) : Promise.resolve(null)),
    external: async () => (await $.state.get(EXTERNAL)).value ?? [],
  }
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

/** At session start: says so when the grimoire this project carries names paths the project does not have. */
async function checkExistingGrimoire($: EngineInterface, cfg: Config): Promise<void> {
  const problem = await checkExisting(engineDeps($, cfg))
  if (problem === null) return
  $.ui.log(`context-guard: ${problem}. /ctx-handoff lo rigenera.`)
  $.ui.toast('Il grimorio in CLAUDE.md sembra di un altro progetto. /ctx-handoff lo rigenera.', { timeoutMs: 10000 })
}

/** Records that the session read content its author did not write; the grimoire then waits for the person's ok. */
async function markExternal($: EngineInterface, label: string): Promise<void> {
  const { value } = await $.state.get(EXTERNAL)
  const list = value ?? []
  if (!list.includes(label)) await $.state.set(EXTERNAL, [...list, label].slice(-20))
}

async function applyPending($: EngineInterface, cfg: Config): Promise<void> {
  const { value: pending } = await $.state.get(PENDING)
  if (pending === null || pending === undefined) return
  if ((await applyApproved(engineDeps($, cfg), pending)) === 'link') {
    $.ui.toast("context-guard: CLAUDE.md e' un link simbolico, non lo scrivo")
    return
  }
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

function waitingLine(pending: Pending): string {
  return `Il grimorio aspetta il tuo ok (${pending.why.join('; ')}). Controlla le modifiche e premi A per applicarle o S per scartarle.`
}

/** Reopens the dialog on the grimoire that waits, if any. */
async function showPending($: EngineInterface): Promise<string> {
  const { value: pending } = await $.state.get(PENDING)
  if (pending === null || pending === undefined) return 'context-guard: nessun grimorio in attesa di conferma.'
  const before = (await $.fs.exists(pending.claudePath)) ? currentGrimoire(await $.fs.read(pending.claudePath)) : null
  await showNpc($, waitingLine(pending), null, lineDiff(before, pending.text))
  return 'context-guard: grimorio in attesa mostrato.'
}

/** A compaction or a /clear empties the window: start the thresholds over. */
async function reset($: EngineInterface): Promise<void> {
  await setGuard($, () => ({ ...INITIAL_STATE }))
  $.ui.status(undefined)
}

const REFUSED_NOTE = {
  link: " Il grimorio pero' non l'ho scritto: CLAUDE.md e' un link simbolico.",
  missing: " Il grimorio pero' non l'ho scritto: parlava di file che qui non esistono.",
  blocked: " Il grimorio pero' l'ho bloccato: conteneva testo sospetto, i motivi sono nella trascrizione.",
} as const

/** Tells the person what the write path did: the transcript line, the toasts and the Librarian. */
async function report($: EngineInterface, out: Outcome, percent: number): Promise<string> {
  if (out.kind === 'no-reply') {
    $.ui.toast(`context-guard: handoff non scritto (${out.why})`)
    return `context-guard: il modello non ha risposto (${out.why}).`
  }
  if (out.kind === 'handoff-is-link') {
    $.ui.toast(`context-guard: ${out.handoffFile} e' un link simbolico, non lo scrivo`)
    return `context-guard: ${out.handoffFile} e' un link simbolico: nessun file scritto.`
  }

  const g = out.grimoire
  let note = ''
  let review: Npc['review'] = null
  let tail = ''
  if (g.kind === 'written') {
    tail = ` e grimorio in ${g.where}`
  } else if (g.kind === 'refused') {
    note = REFUSED_NOTE[g.reason]
    tail = `; grimorio ${g.reason === 'blocked' ? 'BLOCCATO' : 'NON scritto'} in ${g.where}: ${g.detail}`
    $.ui.toast(`context-guard: grimorio ${g.reason === 'blocked' ? 'bloccato' : 'non scritto'}: ${g.detail}`, { timeoutMs: 12000 })
  } else if (g.kind === 'review') {
    await $.state.set(PENDING, g.pending)
    review = g.diff
    note = ` ${waitingLine(g.pending)}`
    tail = `; grimorio in attesa di conferma (${g.pending.why.join('; ')}), /ctx-grimorio lo mostra`
  }

  const line = `context-guard: scritto ${out.handoffFile}${tail} al ${percent}% di contesto`
  $.ui.log(line)
  await showNpc(
    $,
    `Ehi! Il contesto e' al ${percent}%. Ho scritto ${out.handoffFile}${
      g.kind === 'written' ? ' e aggiornato il grimorio in CLAUDE.md' : ''
    }.${note} Quando sei pronto, apri una nuova chat e incolla il prompt${out.promptText ? ': premi C per copiarlo' : ' che trovi in fondo al file'}.`,
    out.promptText,
    review,
  )
  return line
}

/** Runs the write path once: never twice at the same time, always leaving the status line as it found it. */
async function writeFiles($: EngineInterface, cfg: Config, percent: number): Promise<string> {
  const state = await getGuard($)
  if (state.isWriting) return "context-guard: una scrittura e' gia' in corso."
  await setGuard($, s => ({ ...s, isWriting: true }))
  $.ui.status(`ctx ${percent}% | scrivo ${cfg.handoffFile}...`)
  try {
    const out = await generate(engineDeps($, cfg), cfg, percent)
    if (out.kind === 'done') await setGuard($, s => ({ ...s, lastWrittenAt: percent }))
    return await report($, out, percent)
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
    aiCheck: options.aiCheck !== false,
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
        void checkExistingGrimoire($, cfg).catch(err => $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' }))
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
    if (isExternalTool(e.tool, command)) {
      await markExternal($, externalLabel(e.tool))
    } else {
      const path =
        'file_path' in e && typeof e.file_path === 'string'
          ? e.file_path
          : 'notebook_path' in e && typeof e.notebook_path === 'string'
            ? e.notebook_path
            : 'path' in e && typeof e.path === 'string'
              ? e.path
              : undefined
      const label = path === undefined ? null : externalReadLabel(e.tool, path, await $.session.root())
      if (label !== null) await markExternal($, label)
    }
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
            <Button key="apply" label="Applica" hotkey="a" variant="primary" onPress={() => applyPending($, cfg)} />
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
