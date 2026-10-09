import { expect, test } from 'claude-code/testing'

import { OWL, PALETTE, SPRITE_HEIGHT, SPRITE_WIDTH, base64, spriteRaster, spriteSvg } from './sprite'

test('owl: every row is 20 wide and uses only palette characters', () => {
  expect(OWL.length).toBe(SPRITE_HEIGHT)
  for (const row of OWL) {
    expect(row.length).toBe(SPRITE_WIDTH)
    for (const ch of row) expect(ch in PALETTE).toBe(true)
  }
})

test('spriteSvg: one rect per run, transparent pixels skipped, sized by scale', () => {
  const svg = spriteSvg(['.k.', 'kkk'], 4)
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width="12" height="8"')).toBe(true)
  expect(svg.match(/<rect /g)?.length).toBe(2)
  expect(svg).toContain('<rect x="0" y="1" width="3" height="1" fill="#1c1410"/>')
})

test('base64: matches the standard encoding with padding', () => {
  expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
  expect(base64(new Uint8Array([77, 97]))).toBe('TWE=')
  expect(base64(new Uint8Array([77]))).toBe('TQ==')
})

test('spriteRaster: half-block cells, 20 by 10, one u32 triplet each', () => {
  const r = spriteRaster(OWL)
  expect(r.columns).toBe(20)
  expect(r.rows).toBe(10)
  expect(r.cells.length).toBe(Math.ceil((20 * 10 * 12) / 3) * 4)
  const first = spriteRaster(['.', 'k'])
  const bytes = Uint8Array.from(atob(first.cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  expect(words[0]).toBe(0x2584)
  expect(words[1]).toBe(0x1c1410)
  expect(words[2]).toBe(0x01000000)
})
