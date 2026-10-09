import { expect, test } from 'claude-code/testing'

import {
  SECTION_END,
  SECTION_START,
  currentGrimoire,
  knownSuffixes,
  pathRefs,
  projectFacts,
  verifyGrimoire,
} from './logic'

// Two grimoires in the shape of a real swap between two projects: a static study site and a shift-planning app.
const STUDY_SITE = [
  '- `notes-agent/sito/`: sorgenti. `tools/build.py` costruisce `sito/dist/`; `tools/render.py` contiene i template.',
  '- Characters: `assets/js/roster/<id>.js` plus `roster/elenco.json`.',
  '- Test: `node --test sito/tests/js/*.test.js` e `python3 -m unittest discover -s sito/tests -p "test_*.py"`.',
  '- Deploy: `npx --yes vercel deploy --prod --cwd "<assoluto>/sito/dist"`, poi `python3 sito/tools/export_page.py`.',
  '- `main` si porta avanti con `git fetch . <branch>:main`. Channel `site:map`, API `/api/progress/`.',
].join('\n')

const SHIFT_APP = [
  '- Motore: `src/lib/scheduler.ts`; regole in `settings.ts`; cap in `employee-cap.ts`.',
  '- API in `src/app/api/**` con zod (`schemas.ts`). Dashboard: `src/app/dashboard/page.tsx` + `_components/<Nome>.tsx`.',
  '- Verifica: `npm run check`, `npx tsx scripts/test-invariants.ts 10`; test in `src/lib/__tests__/` su `fixtures/team.json`.',
  '- CI: `.github/workflows/ci.yml`. Container: `Dockerfile` + `scripts/start.sh`. DB in `/data/dev.db`.',
].join('\n')

const SHIFT_APP_FILES = [
  'src/lib/scheduler.ts', 'src/lib/settings.ts', 'src/lib/__tests__', 'src/app/api/shifts/route.ts',
  'src/app/dashboard/page.tsx', 'scripts/test-invariants.ts', 'scripts/start.sh', 'fixtures/team.json',
  '.github/workflows/ci.yml', 'package.json',
]

const STUDY_SITE_FILES = [
  'notes-agent/sito/tools/build.py', 'notes-agent/sito/tools/render.py', 'notes-agent/sito/tools/export_page.py',
  'notes-agent/sito/dist', 'notes-agent/sito/assets/js/roster/elenco.json', 'notes-agent/sito/tests/js',
  'notes-agent/sito/tests/test_build.py',
]

test('pathRefs: keeps multi-segment relative paths, cuts globs, drops urls, routes, flags and placeholders', () => {
  expect(pathRefs(STUDY_SITE).sort()).toEqual(
    [
      'notes-agent/sito', 'roster/elenco.json', 'sito/dist', 'sito/tests',
      'sito/tests/js', 'sito/tools/export_page.py', 'tools/build.py', 'tools/render.py',
    ].sort(),
  )
  expect(pathRefs('`https://x.dev/a/b` `/api/x/` `../vecchie/` `-s sito/x` `a`')).toEqual(['sito/x'])
})

test('knownSuffixes: a ref may start at any segment of a project path', () => {
  const k = knownSuffixes(['notes-agent/sito/tools/build.py'])
  expect(k.has('tools/build.py')).toBe(true)
  expect(k.has('notes-agent/sito/tools/build.py')).toBe(true)
  expect(k.has('build.py')).toBe(false)
})

test('verifyGrimoire: the study-site grimoire is refused in the shift-app repo', () => {
  const v = verifyGrimoire(STUDY_SITE, knownSuffixes(SHIFT_APP_FILES))
  expect(v.isOk).toBe(false)
  expect(v.missing).toContain('tools/build.py')
})

test('verifyGrimoire: the shift-app grimoire is refused in the study-site folder', () => {
  expect(verifyGrimoire(SHIFT_APP, knownSuffixes(STUDY_SITE_FILES)).isOk).toBe(false)
})

test('verifyGrimoire: each grimoire passes in its own project', () => {
  expect(verifyGrimoire(SHIFT_APP, knownSuffixes(SHIFT_APP_FILES)).isOk).toBe(true)
  expect(verifyGrimoire(STUDY_SITE, knownSuffixes(STUDY_SITE_FILES)).isOk).toBe(true)
})

test('verifyGrimoire: too few paths to judge passes', () => {
  expect(verifyGrimoire('usa `npm run check` e `foo/bar`', new Set()).isOk).toBe(true)
})

test('currentGrimoire: reads the body between the markers', () => {
  expect(currentGrimoire(`@AGENTS.md\n\n${SECTION_START}\n## G\ncorpo\n${SECTION_END}\n`)).toBe('## G\ncorpo')
  expect(currentGrimoire('@AGENTS.md\n')).toBe(null)
  expect(currentGrimoire(null)).toBe(null)
})

test('projectFacts: names the folder, the repo and what it holds', () => {
  const f = projectFacts({ root: '/p/shift-planner', topLevel: ['src', 'prisma'], packageName: 'shift-planner', repoName: 'shift-planner' })
  expect(f).toContain('- Cartella: /p/shift-planner')
  expect(f).toContain('package.json name: shift-planner')
  expect(f).toContain('src, prisma')
})
