# Unmute Bench v0.1 — Methodology

Every AI benchmark measures the model. Unmute Bench measures the human: how much work a person actually hands to their agents. It is computed from the person's own local logs and is meant to compare *ways of working with agents* (terminal, desktop apps, Unmute, anything else), not models.

## 1. Data

| Source | Location | Used for |
|---|---|---|
| Claude Code transcripts | `~/.claude/projects/<project>/<session>.jsonl` | the person's messages, timestamps, launch method (`entrypoint`) |
| Codex rollouts | `~/.codex/sessions/**`, `~/.codex/archived_sessions/**` (zstd) | the person's messages (`user_message`), timestamps, launch method (`originator`) |
| Unmute session index (optional) | `~/.unmute/remote/session-index/` | the person's messages after the harness has pruned its transcript |

Only the person's own messages are read: timestamp and up to 400 characters of text (the text is used only for cleaning step 2 and task-type classification). Agent replies, tool output and file contents are never kept. Nothing is uploaded.

Claude Code prunes transcripts after about 30 days by default, so without Unmute's index the scorer usually sees about one month of Claude Code history.

## 2. Cleaning

Applied in order, before any metric:

1. **Machine-written messages are dropped.** Injected instructions (`# AGENTS.md instructions…`, `<environment_context>`-style blocks), probes and readiness checks are not the person. Sessions whose every message is machine-written are dropped, as are sessions run from `/tmp`.
2. **Repeats are folded.** Sessions whose first message matches another's exactly (first 200 characters) count once. These are scheduled jobs and re-runs.
3. **Bursts are dropped.** A session started within 60 seconds of three or more other sessions is dropped: people do not start four agents in a minute; automations do.
4. **Codex `codex_exec` runs are excluded** at read time: they are non-interactive by design.

## 3. Metrics

An **active day** is a calendar day (local time) with at least one message. All daily metrics are computed over active days only, so days off do not count against anyone.

| Code | Metric | Definition |
|---|---|---|
| **SPD** | Agent sessions per active day | sessions whose first message falls on that day |
| **MPD** | Messages to agents per active day | the person's messages that day, across all sessions |
| **AHD** | Hours agents ran per active day | minutes with at least one session "running", ÷ 60. A message keeps its session running until the next message in that session if it comes within 30 minutes, otherwise for 10 minutes |
| **PAR** | Agents running at once | sessions running in a given minute, over all minutes with at least one |
| **JPH** | Agents steered per hour | distinct sessions messaged in a clock hour, over hours with at least one message |
| **AD** | Active days | active days in the window |
| **TTW** | Task types per week | distinct task types among sessions started that week (of 6: code, research, comms, content, personal, other), by keyword match on the first message |

Each daily metric is reported as **median**, **trimmed mean** (10% removed from each end) and **p90**. Means and peaks are not reported: a single burst moves them on its own.

## 4. Comparison

Two windows of equal length (default 30 days): the days before a split date and the most recent days after it, ending yesterday. The split date defaults to the first session started by Unmute (`originator: unmute`), or can be set with `--split`.

The **multiplier** is median(after) ÷ median(before).

**Significance** is a one-sided permutation test of the rank sum (Mann–Whitney) of daily SPD and MPD: after-days are compared with before-days under 20,000 random relabellings (seeded, so results are reproducible). The reported p is the larger of the two.

A comparison with fewer than 5 active days on either side is flagged as a preview.

## 5. Reference result (v0.1)

One person (the author), same models (Claude Code + Codex), Claude/Codex desktop apps (Jul 11 – Aug 9, 2026) vs Unmute (Sep 26 – Oct 25, 2026):

| Metric | Before | After | × |
|---|---|---|---|
| SPD | 3 | 10 | 3.3 |
| MPD | 46 | 144 | 3.1 |
| AHD | 4.9 | 9.4 | 1.9 |
| JPH | 1 | 3 | 3.0 |
| PAR | 1 | 2 | — |
| AD | 21 | 29 | — |
| TTW | 3.4 | 5.4 | — |

p < 0.001 for SPD and MPD. 3,062 sessions read; 87 bursts, 1,762 repeats and 160 automated sessions removed.

## 6. Limitations

- **n = 1.** The reference result is one person's history. It shows a large, significant change for that person, not a population effect. This is why the scorer is open: run it on yours.
- **Usage, not value.** The bench measures how much work is handed to agents, not whether that work was good. More messages can mean more corrections.
- **Before/after is not a controlled experiment.** Workload, projects and habits change over time too.
- **Missing history.** Pruned transcripts make "before" windows shorter or emptier than they were. Unmute's index mitigates this on Unmute Macs only.
- **Launch labels are imperfect.** Unmute drives Codex through the desktop app's server, so some Unmute sessions are stamped `Codex Desktop`.
- **AHD and PAR are estimated from the person's messages,** not from agent activity.
- **Task types are keyword-classified** and will misfile some sessions.

## 7. Versioning

v0.1 (October 2026): first public version. Metrics, cleaning rules and thresholds may change; every change bumps the version and is listed in the changelog.

## Citation

```bibtex
@misc{unmutebench2026,
  title  = {Unmute Bench: A Benchmark of Human-to-Agent Work},
  author = {Patel, Arpit},
  year   = {2026},
  note   = {Version 0.1},
  url    = {https://justunmute.me/bench}
}
```
