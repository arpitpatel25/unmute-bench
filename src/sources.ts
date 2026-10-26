/**
 * Unmute Bench — reading the logs the harnesses already keep.
 *
 * Three sources, all local, all read-only:
 *   - Claude Code transcripts   ~/.claude/projects/<project>/<session>.jsonl
 *   - Codex rollouts            ~/.codex/sessions/**, ~/.codex/archived_sessions/**
 *                               (archived ones are zstd-compressed; read only
 *                               when the `zstd` binary is on PATH)
 *   - Unmute's session index    ~/.unmute/remote/session-index/ — the person's
 *                               own turns, kept after the harness deletes its
 *                               transcript (Claude Code prunes at ~30 days), so
 *                               it is the longest history on an Unmute Mac.
 *
 * Only the person's own messages are kept: timestamp and text. Tool output,
 * agent replies and file contents are never read into memory past the line
 * they sit on, and nothing here writes or sends anything.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BenchMessage, BenchSession, LaunchSource } from './core.js'

export interface SourceOptions {
  home?: string
}

export function readClaudeSessions(opts: SourceOptions = {}): BenchSession[] {
  const root = join(opts.home ?? homedir(), '.claude', 'projects')
  const out: BenchSession[] = []
  for (const project of safeReaddir(root)) {
    const dir = join(root, project)
    if (!isDir(dir)) continue
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const session = parseClaudeTranscript(readText(join(dir, file)), file.replace(/\.jsonl$/, ''))
      if (session) out.push(session)
    }
  }
  return out
}

export function parseClaudeTranscript(text: string, id: string): BenchSession | null {
  let entrypoint: string | undefined
  let cwd = ''
  const messages: BenchMessage[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const d = parseLine(line)
    if (!d || d.isSidechain) continue
    entrypoint ??= typeof d.entrypoint === 'string' ? d.entrypoint : undefined
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (d.type !== 'user' || d.isMeta || typeof d.timestamp !== 'string') continue
    const content = d.message?.content
    let body: string | null = null
    if (typeof content === 'string') body = content
    else if (Array.isArray(content)) {
      if (content.some((c: { type?: string }) => c?.type === 'tool_result')) continue
      const texts = content.filter((c: { type?: string }) => c?.type === 'text').map((c: { text?: string }) => c.text ?? '')
      if (texts.length) body = texts.join(' ')
    }
    if (body && body.trim()) messages.push({ t: Date.parse(d.timestamp), text: body.slice(0, 400) })
  }
  if (!messages.length) return null
  return { id, provider: 'claude', source: claudeSource(entrypoint), cwd, messages }
}

function claudeSource(entrypoint: string | undefined): LaunchSource {
  if (entrypoint === 'cli') return 'terminal'
  if (entrypoint === 'claude-desktop') return 'desktop-app'
  // The Agent SDK is how Unmute starts Claude Code, but other apps use it too.
  if (entrypoint === 'sdk-cli' || entrypoint === 'sdk-ts' || entrypoint === 'sdk-py') return 'sdk'
  return 'other'
}

export function readCodexSessions(opts: SourceOptions = {}): BenchSession[] {
  const home = opts.home ?? homedir()
  const files = [
    ...walk(join(home, '.codex', 'sessions')),
    ...walk(join(home, '.codex', 'archived_sessions')),
  ].filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'))
  const haveZstd = files.some((f) => f.endsWith('.zst')) && spawnSync('zstd', ['--version']).status === 0
  const out: BenchSession[] = []
  for (const file of files) {
    let text: string
    if (file.endsWith('.zst')) {
      if (!haveZstd) continue
      const r = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
      if (r.status !== 0) continue
      text = r.stdout.toString('utf8')
    } else text = readText(file)
    const session = parseCodexRollout(text, file)
    if (session) out.push(session)
  }
  return out
}

export function parseCodexRollout(text: string, fallbackId: string): BenchSession | null {
  let id = fallbackId
  let cwd = ''
  let originator = ''
  const messages: BenchMessage[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const d = parseLine(line)
    if (!d) continue
    const p = d.payload ?? {}
    if (d.type === 'session_meta') {
      if (typeof p.id === 'string') id = p.id
      if (typeof p.cwd === 'string') cwd = p.cwd
      if (typeof p.originator === 'string') originator = p.originator
      continue
    }
    if (d.type === 'event_msg' && p.type === 'user_message' && typeof d.timestamp === 'string') {
      const body = typeof p.message === 'string' ? p.message : ''
      if (body.trim()) messages.push({ t: Date.parse(d.timestamp), text: body.slice(0, 400) })
    }
  }
  if (!messages.length) return null
  const source = codexSource(originator)
  if (source === null) return null
  return { id, provider: 'codex', source, cwd, messages }
}

/** null = automation that is never a person (exec runs, probes). */
function codexSource(originator: string): LaunchSource | null {
  if (originator === 'unmute' || originator === 'unmute-agent') return 'unmute'
  if (originator === 'codex_exec' || originator === 'probe') return null
  if (originator === 'codex-tui' || originator === 'codex_cli_rs') return 'terminal'
  // Unmute also drives Codex through the desktop app's server, which stamps
  // its sessions "Codex Desktop" — so this label alone cannot tell them apart.
  if (originator === 'Codex Desktop') return 'desktop-app'
  return 'other'
}

/** Unmute's own index of every session on the Mac. Turns only, no agent
 *  replies — enough for every Bench metric. */
export function readUnmuteIndex(opts: SourceOptions = {}): BenchSession[] {
  const dir = join(opts.home ?? homedir(), '.unmute', 'remote', 'session-index')
  return readUnmuteIndexFromText(readText(join(dir, 'sessions.jsonl')), readText(join(dir, 'turns.jsonl')))
}

export function readUnmuteIndexFromText(sessionsText: string, turnsText: string): BenchSession[] {
  if (!sessionsText || !turnsText) return []
  const turns = new Map<string, BenchMessage[]>()
  for (const line of turnsText.split('\n')) {
    const t = line ? parseLine(line) : null
    if (!t || typeof t.s !== 'string' || typeof t.t !== 'number') continue
    if (!turns.has(t.s)) turns.set(t.s, [])
    turns.get(t.s)!.push({ t: t.t, text: typeof t.text === 'string' ? t.text.slice(0, 400) : '' })
  }
  const out: BenchSession[] = []
  for (const line of sessionsText.split('\n')) {
    const r = line ? parseLine(line) : null
    if (!r || typeof r.id !== 'string') continue
    // Only sessions a person addressed: subagents, routines and the hidden
    // briefing calls Unmute makes for itself are not the person's work.
    if (r.provenance !== 'main' || r.briefing) continue
    const messages = turns.get(r.id)
    if (!messages?.length) continue
    out.push({
      id: r.id,
      provider: r.provider === 'codex' ? 'codex' : 'claude',
      // The index records every session on the Mac, not only Unmute's. Merge
      // it after the harness readers so their launch labels win.
      source: 'other',
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      messages: messages.sort((a, b) => a.t - b.t),
    })
  }
  return out
}

/** Merge sources, preferring the first one that has a given session id. */
export function mergeSessions(...lists: BenchSession[][]): BenchSession[] {
  const byId = new Map<string, BenchSession>()
  for (const list of lists) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s)
  return [...byId.values()]
}

// ── helpers ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseLine(line: string): any | null {
  try {
    const d = JSON.parse(line)
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function safeReaddir(path: string): string[] {
  try { return readdirSync(path) } catch { return [] }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function walk(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name)
      if (isDir(p)) stack.push(p)
      else out.push(p)
    }
  }
  return out
}
