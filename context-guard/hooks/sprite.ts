/** The Librarian owl: a 20x20 pixel sprite, Game Boy Advance era style (black outline, three shades, a belly, a highlight in each eye). */

export const PALETTE: Readonly<Record<string, number | null>> = {
  '.': null, // transparent
  k: 0x1c1410, // outline
  d: 0x5a3a22, // dark brown
  b: 0x8c5a30, // brown
  l: 0xc48a4f, // light brown
  c: 0xf1dfb6, // cream belly
  s: 0xd9c08f, // belly shade
  w: 0xffffff, // eye white
  o: 0xf08a24, // beak and feet
}

export const OWL: readonly string[] = [
  '...kk..........kk...',
  '..kddk........kddk..',
  '..kdbbk......kbbdk..',
  '..kdbbbkkkkkkbbbdk..',
  '..kdlbbbbbbbbbbbdk..',
  '.kdlbbbbbbbbbbbbbdk.',
  '.kdbkkkkkbbkkkkkbdk.',
  '.kdkwwwwwbbwwwwwkdk.',
  '.kdkwwkkwoowwkkwkdk.',
  '.kdkwkkkwoowkkkwkdk.',
  '.kdkwwwwwbbwwwwwkdk.',
  '.kdbkkkkkbbkkkkkbdk.',
  '.kdbbkcccccccckbbdk.',
  '.kdbkcccccccccckbdk.',
  '.kdbkcscscscscsckbdk',
  '.kdbkcccccccccckbdk.',
  '..kdkcccccccccckdk..',
  '...kkkkkkkkkkkkkk...',
  '.....koo......ook...',
  '.....kkk......kkk...',
]

export const SPRITE_WIDTH = 20
export const SPRITE_HEIGHT = 20

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

/** The sprite as an SVG document, `scale` CSS pixels per sprite pixel; horizontal runs of one colour share a rect. */
export function spriteSvg(grid: readonly string[], scale: number): string {
  const rects: string[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x] ?? '.'
      const color = PALETTE[ch] ?? null
      let run = 1
      while (x + run < row.length && row[x + run] === ch) run += 1
      if (color !== null) rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(color)}"/>`)
      x += run
    }
  })
  const w = grid[0]?.length ?? 0
  const h = grid.length
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">` +
    rects.join('') +
    '</svg>'
  )
}

const DEFAULT = 0x01000000
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20

/** Standard base64 of bytes; the plugin environment has no Buffer, and Uint8Array#toBase64 is not everywhere yet. */
export function base64(bytes: Uint8Array): string {
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += T[(n >> 18) & 63]! + T[(n >> 12) & 63]!
    out += b === undefined ? '=' : T[(n >> 6) & 63]!
    out += c === undefined ? '=' : T[n & 63]!
  }
  return out
}

/** The sprite as terminal cells for a `Raster`: two sprite rows per cell with the half-block glyphs, so 20 columns by 10 rows. */
export function spriteRaster(grid: readonly string[]): { columns: number; rows: number; cells: string } {
  const columns = grid[0]?.length ?? 0
  const rows = Math.ceil(grid.length / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = PALETTE[grid[2 * r]?.[x] ?? '.'] ?? null
      const bottom = PALETTE[grid[2 * r + 1]?.[x] ?? '.'] ?? null
      const i = (r * columns + x) * 3
      if (top === null && bottom === null) {
        words[i] = SPACE; words[i + 1] = DEFAULT; words[i + 2] = DEFAULT
      } else if (top === null) {
        words[i] = LOWER; words[i + 1] = bottom!; words[i + 2] = DEFAULT
      } else {
        words[i] = UPPER; words[i + 1] = top; words[i + 2] = bottom ?? DEFAULT
      }
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(words.buffer)) }
}
