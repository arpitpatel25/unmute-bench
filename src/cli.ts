#!/usr/bin/env node
/**
 * unmute-bench — score how much work you hand to your AI agents.
 *
 *   curl -fsSL https://justunmute.me/unmute-bench.mjs | node --input-type=module -
 *
 * or download it once and run it:
 *
 *   node unmute-bench.mjs                      compare your last 30 days with the 30 before
 *   node unmute-bench.mjs --split 2026-08-10   compare 30 days before vs after a date
 *   node unmute-bench.mjs --card bench.png     also write a shareable black-and-white card
 *   node unmute-bench.mjs --json               machine-readable output
 *
 * Reads only local logs (Claude Code, Codex, and Unmute's index if present).
 * Sends nothing anywhere.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cleanSessions,
  compare,
  dayKey,
  firstUnmuteDay,
  type BenchComparison,
  type BenchMetrics,
} from './core.js'
import { mergeSessions, readClaudeSessions, readCodexSessions, readUnmuteIndex } from './sources.js'

const DAY_MS = 86_400_000

interface Args { split?: string; days: number; json: boolean; card?: string; index: boolean; help: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, json: false, index: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--split') args.split = argv[++i]
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--json') args.json = true
    else if (a === '--card') args.card = argv[++i]
    else if (a === '--no-index') args.index = false
    else if (a === '-h' || a === '--help') args.help = true
  }
  if (args.split && !/^\d{4}-\d{2}-\d{2}$/.test(args.split)) fail('--split must be YYYY-MM-DD')
  if (!Number.isFinite(args.days) || args.days < 7 || args.days > 90) fail('--days must be between 7 and 90')
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP); return }

  const log = (s: string) => { if (!args.json) process.stderr.write(s) }
  log('Reading your local Claude Code and Codex logs…\n')
  const raw = mergeSessions(readClaudeSessions(), readCodexSessions(), args.index ? readUnmuteIndex() : [])
  const { sessions, dropped } = cleanSessions(raw)
  if (!sessions.length) fail('No Claude Code or Codex sessions found in ~/.claude or ~/.codex.')

  // Today is still in progress, so the last full day is yesterday.
  const today = startOfDay(dayKey(Date.now())) - DAY_MS
  const splitKey = args.split ?? firstUnmuteDay(sessions) ?? dayKey(today - (args.days - 1) * DAY_MS)
  const split = startOfDay(splitKey)
  const before: [string, string] = [dayKey(split - args.days * DAY_MS), dayKey(split - DAY_MS)]
  const after: [string, string] = [dayKey(Math.max(split, today - (args.days - 1) * DAY_MS)), dayKey(today)]
  const result = compare(sessions, before, after)

  if (args.json) {
    process.stdout.write(JSON.stringify({ version: '0.1.0', split: splitKey, windows: { before, after }, dropped, sessionsRead: raw.length, ...result }, null, 2) + '\n')
  } else {
    process.stdout.write(report(result, splitKey, raw.length, dropped))
  }
  if (args.card) {
    log(`\n${writeCard(args.card, card(result))}\n`)
  }
}

function report(r: BenchComparison, split: string, read: number, dropped: { machineOnly: number; duplicates: number; bursts: number }): string {
  const b = r.before
  const a = r.after
  const row = (name: string, x: number, y: number, m: number | null) =>
    `  ${name.padEnd(30)} ${String(x).padStart(7)}  →  ${String(y).padStart(7)}   ${m === null ? '' : `${m}×`}\n`
  const thin = (m: BenchMetrics) => m.activeDays < 5
  let out = '\n  UNMUTE BENCH v0.1 · the benchmark that measures the human, not the model\n\n'
  out += `  ${'Median per active day'.padEnd(30)} ${'before'.padStart(7)}     ${'after'.padStart(7)}\n`
  out += `  ${''.padEnd(30)} ${range(b).padStart(7)}     ${range(a).padStart(7)}\n`
  out += '  ' + '─'.repeat(64) + '\n'
  out += row('SPD  agent sessions', b.spd.median, a.spd.median, r.multiplier.spd)
  out += row('MPD  messages to agents', b.mpd.median, a.mpd.median, r.multiplier.mpd)
  out += row('AHD  hours agents ran', b.ahd.median, a.ahd.median, r.multiplier.ahd)
  out += row('JPH  agents steered per hour', b.jph.median, a.jph.median, r.multiplier.jph)
  out += row('PAR  agents running at once', b.par.median, a.par.median, null)
  out += row('AD   active days', b.activeDays, a.activeDays, null)
  out += row('TTW  task types per week', round1(b.ttw), round1(a.ttw), null)
  out += '  ' + '─'.repeat(64) + '\n'
  const p = Math.max(r.pValue.spd, r.pValue.mpd)
  out += `  ${p < 0.001 ? 'Statistically significant (p < 0.001)' : p < 0.05 ? `Statistically significant (p = ${p.toFixed(3)})` : `Not statistically significant (p = ${p.toFixed(2)})`}\n`
  out += `  Split date: ${split} · ${read} sessions read · removed ${dropped.bursts} bursts, ${dropped.duplicates} repeats, ${dropped.machineOnly} automated\n`
  if (thin(b) || thin(a)) out += '  Fewer than 5 active days on one side: treat this as a preview, not a result.\n'
  out += leaderboard(a)
  out += '\n  Method and leaderboard: justunmute.me/bench · Nothing left this machine.\n\n'
  return out
}

/** A 1200×675 black-and-white card in the style of a model-launch chart. */
function card(r: BenchComparison): string {
  const rows: Array<[string, number, number, number | null]> = [
    ['Agent sessions / day', r.before.spd.median, r.after.spd.median, r.multiplier.spd],
    ['Messages to agents / day', r.before.mpd.median, r.after.mpd.median, r.multiplier.mpd],
    ['Hours agents ran / day', r.before.ahd.median, r.after.ahd.median, r.multiplier.ahd],
  ]
  const barX = 420
  const barMax = 560
  let body = ''
  rows.forEach(([label, x, y, m], i) => {
    const top = 190 + i * 140
    const max = Math.max(x, y, 1e-9)
    const wb = Math.max((x / max) * barMax, 40)
    const wa = Math.max((y / max) * barMax, 40)
    body += `<text x="72" y="${top + 38}" font-size="24" font-weight="600">${esc(label)}</text>`
    body += `<rect x="${barX}" y="${top}" width="${wb}" height="34" rx="4" fill="#d9d9d9"/>`
    body += `<text x="${barX + wb - 12}" y="${top + 24}" font-size="18" font-weight="600" text-anchor="end" fill="#333">${x}</text>`
    body += `<rect x="${barX}" y="${top + 42}" width="${wa}" height="34" rx="4" fill="#0b0b0c"/>`
    body += `<text x="${barX + wa - 12}" y="${top + 66}" font-size="18" font-weight="600" text-anchor="end" fill="#fff">${y}</text>`
    if (m !== null) body += `<text x="1128" y="${top + 52}" font-size="40" font-weight="700" text-anchor="end">${m}×</text>`
  })
  const p = Math.max(r.pValue.spd, r.pValue.mpd)
  const sig = p < 0.001 ? 'p &lt; 0.001' : `p = ${p.toFixed(3)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" font-family="Inter, Helvetica, Arial, sans-serif" fill="#0b0b0c">
<rect width="1200" height="675" fill="#fff"/>
<text x="72" y="96" font-size="44" font-weight="700">My Unmute Bench</text>
<text x="72" y="134" font-size="20" fill="#555">The benchmark that measures the human, not the model.</text>
<rect x="760" y="74" width="16" height="16" rx="3" fill="#d9d9d9"/><text x="784" y="88" font-size="17" fill="#333">Before</text>
<rect x="870" y="74" width="16" height="16" rx="3" fill="#0b0b0c"/><text x="894" y="88" font-size="17" fill="#333">After</text>
${body}
<line x1="72" y1="612" x2="1128" y2="612" stroke="#ececec"/>
<text x="72" y="642" font-size="15" fill="#8a8a8a">Median per active day · ${r.before.from} → ${r.after.to} · ${sig} · from my own local logs</text>
<text x="1128" y="642" font-size="15" fill="#8a8a8a" text-anchor="end">justunmute.me/bench</text>
</svg>
`
}

/** Reference rows from the v0.1 leaderboard, so every run shows where the
 *  person sits. Keep in sync with justunmute.me/bench. */
const LEADERBOARD: Array<[string, number, number, number]> = [
  ['Claude Code + Codex, desktop apps', 3, 46, 4.9],
  ['Claude Code + Codex, via Unmute', 10, 144, 9.4],
]

function leaderboard(you: BenchMetrics): string {
  const row = (name: string, s: number, m: number, h: number) =>
    `  ${name.padEnd(36)} ${String(s).padStart(8)} ${String(m).padStart(9)} ${String(h).padStart(7)}\n`
  let out = '\n  Where you sit, median per active day (leaderboard v0.1, n=1 per row)\n'
  out += `  ${''.padEnd(36)} ${'sessions'.padStart(8)} ${'messages'.padStart(9)} ${'hours'.padStart(7)}\n`
  out += row(`You, ${range(you)}`, you.spd.median, you.mpd.median, you.ahd.median)
  for (const [name, s, m, h] of LEADERBOARD) out += row(name, s, m, h)
  return out
}

/** SVG always; PNG by drawing the SVG in a headless Chrome/Chromium, because
 *  X and most apps won't take an SVG. */
function writeCard(path: string, svg: string): string {
  if (!path.toLowerCase().endsWith('.png')) {
    writeFileSync(path, svg)
    return `Share card written to ${path}`
  }
  const chrome = findChrome()
  const fallback = path.replace(/\.png$/i, '.svg')
  if (!chrome) {
    writeFileSync(fallback, svg)
    return `No Chrome or Chromium found, so the card is an SVG: ${fallback} (open it in a browser and screenshot it)`
  }
  const dir = mkdtempSync(join(tmpdir(), 'unmute-bench-'))
  try {
    const src = join(dir, 'card.svg')
    writeFileSync(src, svg)
    const out = resolve(path)
    spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1200,675', `--screenshot=${out}`, `file://${src}`], { stdio: 'ignore', timeout: 30_000 })
    if (existsSync(out)) return `Share card written to ${path}`
    writeFileSync(fallback, svg)
    return `Could not draw the PNG, so the card is an SVG: ${fallback}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function findChrome(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

function range(m: BenchMetrics): string {
  const f = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${f(m.from)}–${f(m.to)}`
}

function round1(x: number): number { return Math.round(x * 10) / 10 }
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;') }
function startOfDay(key: string): number { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
function fail(msg: string): never { process.stderr.write(`unmute-bench: ${msg}\n`); process.exit(1) }

const HELP = `unmute-bench v0.1 — the benchmark that measures the human, not the model

Usage: node unmute-bench.mjs [--split YYYY-MM-DD] [--days N] [--card file.png] [--json] [--no-index]
   or: curl -fsSL https://justunmute.me/unmute-bench.mjs | node --input-type=module - [options]

  --split   first day of "after" (default: your first Unmute session, else ${30} days ago)
  --days    length of each window, 7–90 (default 30)
  --card    write a shareable 1200×675 card (.png needs Chrome or Chromium; .svg always works)
  --json    print machine-readable results
  --no-index  ignore Unmute's session index even if present

Reads ~/.claude/projects and ~/.codex (zstd archives need the zstd binary).
Nothing is uploaded. Method: https://justunmute.me/bench
`

main()
