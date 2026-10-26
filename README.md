# Unmute Bench

**The benchmark that measures the human, not the model.**

Every AI benchmark scores the model. Unmute Bench scores *you*: how much work you actually hand to Claude Code and Codex, from your own local logs.

```bash
curl -fsSL https://justunmute.me/unmute-bench.mjs | node --input-type=module -
```

One self-contained file (`unmute-bench.mjs`, no dependencies). Read it before you run it: it's the same code as `src/`, bundled.

```
  UNMUTE BENCH v0.1 · the benchmark that measures the human, not the model

  Median per active day           before       after
                                 Jul 11–Aug 9     Sep 26–Oct 25
  ────────────────────────────────────────────────────────────────
  SPD  agent sessions                  3  →       10   3.3×
  MPD  messages to agents             46  →      144   3.1×
  AHD  hours agents ran              4.9  →      9.4   1.9×
  JPH  agents steered per hour         1  →        3   3×
  PAR  agents running at once          1  →        2
  AD   active days                    21  →       29
  TTW  task types per week           3.4  →      5.4
  ────────────────────────────────────────────────────────────────
  Statistically significant (p < 0.001)
```

## What it measures

| Code | Metric |
|---|---|
| SPD | Agent sessions started per active day |
| MPD | Messages to agents per active day |
| AHD | Hours per active day with an agent running |
| JPH | Different agents you message per active hour |
| PAR | Agents running at the same time |
| AD | Active days in the window |
| TTW | Task types per week (code, research, comms, content, personal, other) |

Medians per active day, after removing automated runs, repeats and bursts. Full definitions, cleaning rules and the significance test: [METHODOLOGY.md](METHODOLOGY.md).

## Usage

```bash
curl -fsSL https://justunmute.me/unmute-bench.mjs -o unmute-bench.mjs

node unmute-bench.mjs                       # last 30 days vs the 30 before
node unmute-bench.mjs --split 2026-08-10    # 30 days before vs after a date (e.g. when you switched tools)
node unmute-bench.mjs --days 14             # shorter windows
node unmute-bench.mjs --card bench.png      # shareable black-and-white card (PNG needs Chrome; use .svg otherwise)
node unmute-bench.mjs --json                # machine-readable
```

If you use [Unmute](https://justunmute.me), the split date defaults to your first Unmute session, and Unmute's session index fills in history that Claude Code has already pruned.

## Privacy

Runs entirely on your machine. Reads only your own messages (timestamp and the first 400 characters), never agent replies or files. Sends nothing anywhere. No dependencies at runtime.

## Build from source

```bash
npm install && npm run build   # tsc → dist/
npm run bundle                 # esbuild → unmute-bench.mjs
```

## Requirements

Node 18+. Codex archives (`.jsonl.zst`) are read only if the `zstd` binary is installed.

## Submit your result

Run `node unmute-bench.mjs --json` and [open a result issue](https://github.com/arpitpatel25/unmute-bench/issues/new?title=Result%3A%20&labels=result) with the output and your main setup (terminal, desktop app, Cursor, Unmute, other) to be added to the leaderboard. Only the numbers are needed, never your logs.

## Cite

```bibtex
@misc{unmutebench2026,
  title  = {Unmute Bench: A Benchmark of Human-to-Agent Work},
  author = {Patel, Arpit},
  year   = {2026},
  note   = {Version 0.1},
  url    = {https://justunmute.me/bench}
}
```

## License

MIT
