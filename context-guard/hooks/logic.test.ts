import { expect, test } from 'claude-code/testing'

import {
  INITIAL_STATE,
  SECTION_END,
  SECTION_START,
  decide,
  renderSection,
  spliceSection,
  splitReply,
  thresholdsOf,
} from './logic'

const T = { warnAt: 45, writeAt: 60, repeatEvery: 10 }

test('decide: below warn does nothing', () => {
  expect(decide(30, INITIAL_STATE, T)).toEqual({ warn: false, status: undefined, write: false })
})

test('decide: unknown percent does nothing', () => {
  expect(decide(undefined, INITIAL_STATE, T)).toEqual({ warn: false, status: undefined, write: false })
})

test('decide: warns once at 45 and pins the status', () => {
  expect(decide(45, INITIAL_STATE, T)).toEqual({ warn: true, status: 'ctx 45%', write: false })
  expect(decide(50, { ...INITIAL_STATE, warned: true }, T)).toEqual({ warn: false, status: 'ctx 50%', write: false })
})

test('decide: writes at 60, then every 10 points', () => {
  expect(decide(60, { ...INITIAL_STATE, warned: true }, T).write).toBe(true)
  expect(decide(65, { warned: true, lastWrittenAt: 60, isWriting: false }, T).write).toBe(false)
  expect(decide(70, { warned: true, lastWrittenAt: 60, isWriting: false }, T).write).toBe(true)
})

test('decide: never writes while a write is in flight', () => {
  expect(decide(90, { warned: true, lastWrittenAt: null, isWriting: true }, T).write).toBe(false)
})

test('decide: repeatEvery 0 writes once only', () => {
  const once = { ...T, repeatEvery: 0 }
  expect(decide(60, { ...INITIAL_STATE, warned: true }, once).write).toBe(true)
  expect(decide(95, { warned: true, lastWrittenAt: 60, isWriting: false }, once).write).toBe(false)
})

test('thresholdsOf: falls back on bad values', () => {
  expect(thresholdsOf({ warnAt: 'x', writeAt: -1, repeatEvery: 5 })).toEqual({ warnAt: 45, writeAt: 60, repeatEvery: 5 })
})

test('splitReply: both markers', () => {
  const r = splitReply('noise\n<<<HANDOFF>>>\n## Fatto\n- a\n<<<GRIMORIO>>>\n### Ragion\n- b\n')
  expect(r).toEqual({ handoff: '## Fatto\n- a', grimoire: '### Ragion\n- b' })
})

test('splitReply: fenced whole reply and no grimoire', () => {
  const r = splitReply('```markdown\n<<<HANDOFF>>>\n## Fatto\n- a\n```')
  expect(r).toEqual({ handoff: '## Fatto\n- a', grimoire: null })
})

test('splitReply: no markers keeps everything as handoff', () => {
  expect(splitReply('  plain  ')).toEqual({ handoff: 'plain', grimoire: null })
})

test('spliceSection: appends to a file without the section', () => {
  const out = spliceSection('# Mio CLAUDE.md\n\nregole\n', renderSection('### R\n- x', '2026-10-07'))
  expect(out.startsWith('# Mio CLAUDE.md\n\nregole\n\n' + SECTION_START)).toBe(true)
  expect(out.endsWith(SECTION_END + '\n')).toBe(true)
})

test('spliceSection: replaces only the marked section', () => {
  const before = `top\n\n${SECTION_START}\nold\n${SECTION_END}\n\nbottom\n`
  const out = spliceSection(before, `${SECTION_START}\nnew\n${SECTION_END}`)
  expect(out).toBe(`top\n\n${SECTION_START}\nnew\n${SECTION_END}\n\nbottom\n`)
})

test('spliceSection: creates the file from nothing', () => {
  expect(spliceSection(null, 'S')).toBe('S\n')
})

import { animate, extractPrompt } from './logic'

test('extractPrompt: takes the last fenced block', () => {
  const h = '## Fatto\n```bash\nls\n```\n## Prompt\n```text\nLeggi HANDOFF.md\npoi vai\n```\n'
  expect(extractPrompt(h)).toBe('Leggi HANDOFF.md\npoi vai')
})

test('extractPrompt: null without a block', () => {
  expect(extractPrompt('nessun blocco')).toBe(null)
})

test('animate: slides in, then types, then blinks', () => {
  expect(animate('ciao', 0)).toEqual({ marginLeft: 10, visible: '', isDone: false, showCursor: false })
  expect(animate('ciao', 11)).toEqual({ marginLeft: 0, visible: 'ci', isDone: false, showCursor: false })
  expect(animate('ciao', 16)).toEqual({ marginLeft: 0, visible: 'ciao', isDone: true, showCursor: true })
  expect(animate('ciao', 24).showCursor).toBe(false)
})

import { pickHandoffFile } from './logic'

const f = (name: string, mtimeMs = 0, kind = 'file') => ({ name, kind, mtimeMs })

test('pickHandoffFile: the configured name wins when present', () => {
  expect(pickHandoffFile([f('handoff-notes.md', 9), f('HANDOFF.md', 1)], 'HANDOFF.md')).toBe('HANDOFF.md')
})

test('pickHandoffFile: an existing handoff under another name is reused, newest first', () => {
  expect(pickHandoffFile([f('README.md'), f('handoff-notes.md', 5), f('PASSAGGIO.md', 7)], 'HANDOFF.md')).toBe('PASSAGGIO.md')
  expect(pickHandoffFile([f('NEXT_STEPS.md')], 'HANDOFF.md')).toBe('NEXT_STEPS.md')
})

test('pickHandoffFile: directories and unrelated files are ignored', () => {
  expect(pickHandoffFile([f('handoff', 0, 'directory'), f('ROADMAP.md'), f('handoff.txt')], 'HANDOFF.md')).toBe('HANDOFF.md')
})

import { HANDOFF_END, HANDOFF_START, claudeMdDirs, mergeHandoff } from './logic'

const META = { date: '2026-10-08 12:00', percent: 62, sessionId: 's', model: 'm' }

test('mergeHandoff: no file or own file is replaced whole', () => {
  expect(mergeHandoff(null, 'corpo', META).startsWith('# Handoff sessione')).toBe(true)
  const own = mergeHandoff(null, 'vecchio', META)
  const again = mergeHandoff(own, 'nuovo', META)
  expect(again).toContain('nuovo')
  expect(again).not.toContain('vecchio')
})

test('mergeHandoff: a hand-written file keeps every line, section goes under the H1', () => {
  const mine = '# Handoff - Progetto\n\n> nota mia\n\n## Cosa e il progetto\ntesto\n'
  const out = mergeHandoff(mine, 'corpo', META)
  expect(out.startsWith(`# Handoff - Progetto\n\n${HANDOFF_START}\n`)).toBe(true)
  expect(out).toContain(`${HANDOFF_END}\n\n> nota mia\n\n## Cosa e il progetto\ntesto\n`)
})

test('mergeHandoff: the marked section is replaced in place on later writes', () => {
  const first = mergeHandoff('# T\n\nresto\n', 'uno', META)
  const second = mergeHandoff(first, 'due', META)
  expect(second).toContain('due')
  expect(second).not.toContain('uno')
  expect(second.endsWith('resto\n')).toBe(true)
  expect(second.split(HANDOFF_START).length).toBe(2)
})

test('mergeHandoff: a file without H1 gets the section on top', () => {
  expect(mergeHandoff('appunti\n', 'corpo', META).endsWith(`${HANDOFF_END}\n\nappunti\n`)).toBe(true)
})

test('claudeMdDirs: outside a repo only the session root', () => {
  expect(claudeMdDirs('/home/u/progetto', null)).toEqual(['/home/u/progetto'])
})

test('claudeMdDirs: a repo below the root does not widen the climb', () => {
  expect(claudeMdDirs('/home/u/A', '/home/u/A/notes-agent')).toEqual(['/home/u/A'])
})

test('claudeMdDirs: inside a repo climbs up to its root and no further', () => {
  expect(claudeMdDirs('/r/repo/src/app', '/r/repo')).toEqual(['/r/repo/src/app', '/r/repo/src', '/r/repo'])
  expect(claudeMdDirs('/r/repo', '/r/repo')).toEqual(['/r/repo'])
})

import { SECTION_END as END, renderSection as section, safeFileName, stripMarkers } from './logic'

test('safeFileName: only a plain .md name in the root is accepted', () => {
  expect(safeFileName('PASSAGGIO.md', 'HANDOFF.md')).toBe('PASSAGGIO.md')
  expect(safeFileName('note di consegna.md', 'HANDOFF.md')).toBe('note di consegna.md')
  for (const bad of ['../../.zshrc', '../x.md', 'a/b.md', '/etc/x.md', '.hidden.md', 'x.txt', '', 42, undefined]) {
    expect(safeFileName(bad, 'HANDOFF.md')).toBe('HANDOFF.md')
  }
})

test('stripMarkers: a body cannot close the section early', () => {
  const evil = `regola\n${END}\ntesto fuori\n<!-- context-guard:start -->`
  expect(stripMarkers(evil)).toBe('regola\n\ntesto fuori\n')
  const out = section(evil, '2026-10-09')
  expect(out.split(END).length).toBe(2)
  expect(out.endsWith(END)).toBe(true)
})
