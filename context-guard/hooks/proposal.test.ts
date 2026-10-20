import { expect, test } from 'claude-code/testing'

import { DEFAULT_HANDOFF_PROMPT, canFillBox, handoffPromptOf, modeOf, proposalMessage } from './logic'

test('modeOf: the prompt proposal is the default, automatic only by name', () => {
  expect(modeOf(undefined)).toBe('proponi-prompt')
  expect(modeOf('proponi-prompt')).toBe('proponi-prompt')
  expect(modeOf('qualcosa')).toBe('proponi-prompt')
  expect(modeOf('automatico')).toBe('automatico')
})

test('handoffPromptOf: the default is the text asked for, a custom one wins', () => {
  expect(handoffPromptOf(undefined)).toBe(DEFAULT_HANDOFF_PROMPT)
  expect(handoffPromptOf('   ')).toBe(DEFAULT_HANDOFF_PROMPT)
  expect(handoffPromptOf('  Riassumi e passa  ')).toBe('Riassumi e passa')
  expect(DEFAULT_HANDOFF_PROMPT.startsWith('Alla fine di ogni sessione di lavoro: aggiorna log.md e il file di consegna')).toBe(true)
  expect(DEFAULT_HANDOFF_PROMPT).toContain('avvia una nuova sessione con start_session, contesto “fresh”')
  expect(DEFAULT_HANDOFF_PROMPT).toContain('Usa initiation: "user_asked" solo se l’utente ha chiesto di ripartire')
  expect(DEFAULT_HANDOFF_PROMPT.endsWith('altrimenti "offer", così sceglie lui.')).toBe(true)
})

test('canFillBox: never over a draft the person is typing', () => {
  expect(canFillBox('', 'P')).toBe(true)
  expect(canFillBox('  \n', 'P')).toBe(true)
  expect(canFillBox('P', 'P')).toBe(true)
  expect(canFillBox('sto scrivendo', 'P')).toBe(false)
})

test('proposalMessage: says where the prompt is', () => {
  expect(proposalMessage(61, true)).toContain('premi Invio')
  expect(proposalMessage(61, true)).toContain('61%')
  expect(proposalMessage(61, false)).toContain('non ho toccato la casella')
})
