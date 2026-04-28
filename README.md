# pi-tscg

Drop-in tool-schema and tool-result compression for [Pi](https://pi.dev), the
lean coding-agent CLI. Wraps [`@tscg/core`](https://github.com/SKZL-AI/tscg)
and adds two extra layers Pi alone doesn't have, so every LLM request and
every tool-result is shorter — without breaking tool-calling.

```
TSCG: last −8.3% · session −8.3% · res −62% · saved 14.6k (aggressive)
```

- **Drop-in.** `pi install pi-tscg` and you're done. No code changes anywhere.
- **Provider-agnostic.** Works on Anthropic API, OpenAI API, and Ollama out of
  the box. Gemini support is wired (skeleton); see Roadmap.
- **Lossless on tool-call dispatch.** Tool names and JSON schemas keep their
  semantics. Only descriptions get rewritten and tool-results get truncated
  with explicit markers.
- **Per-session stats** in the Pi footer plus a `/tscg` slash-command suite.

## Install

```bash
pi install pi-tscg
```

That pulls `@tscg/core` along. Restart Pi (or run `/reload`) and you should see
`TSCG: ready (balanced)` in the footer.

## What it does — three levers

### Lever 1: Tool-schema compression

Hooks `before_provider_request` and runs every tool's `description` through
TSCG's `compressDescriptions()` with all eight paper operators
(SDM, DRO, CAS, CCP, CFL, CFO, SAD, TAS) enabled. JSON structure is preserved,
tool names stay identical → tool-call dispatch is byte-identical to the
uncompressed path. Typical savings: 8–15 % on lean built-in tool sets,
30–50 % on verbose MCP tool catalogs.

On top of TSCG itself: a small JSON-pruning pass (Strategy A) strips
`$schema`, `$id`, `$ref`, empty `examples`, empty `enum` and undefined
`default` fields — non-semantic validator overhead the LLM never reads.

### Lever 2: Tool-result compression

Hooks `tool_result` and shortens raw tool-output text before it goes back to
the model. Per-tool strategy:

| Tool | Strategy | Typical saving |
|------|---------|---------------|
| `bash` | whitespace-collapse → duplicate-line-fold → SDM filler-removal → head/tail truncation at token budget | 40–60 % |
| `read` | head/tail truncation only when result exceeds budget | 0–50 % |
| `grep`, `find`, `ls` | head/tail truncation only when result exceeds budget | 30–50 % |
| `edit`, `write`, `notebook_edit` | **untouched** — diffs must stay byte-exact | 0 % |
| custom / MCP-tool | SDM filler-removal + head/tail truncation | 5–25 % |

Truncation is explicit: a marker like
`[TSCG: 2400 lines / ~9.7k tokens elided — head + tail kept]` is left in
place so the LLM understands why the middle is missing.

### Lever 3: Provider-aware prompt-cache awareness

Cache mechanisms differ per provider. The extension detects the provider
from the outgoing payload and engages whatever fits:

| Provider | Mechanism | Implementation |
|----------|-----------|----------------|
| **Anthropic API** | explicit `cache_control: ephemeral` marker on tools block | active |
| **OpenAI API** | automatic prefix caching (≥1024 tokens) | implicit — TSCG's deterministic compression keeps the prefix stable; we count cache-eligible calls in stats |
| **Ollama** | no API-level cache exists | no-op |
| **Google Gemini** | separate `cachedContents` API | skeleton hook in code (see Roadmap) |

For Anthropic, the marker means tools are billed at ~10 % of input cost from
call 2 onward — multiplicative with Lever-1 savings, not additive.

## Footer & status

Footer in the Pi UI:

```
TSCG: last −8.3% · session −8.3% · res −62% · saved 14.6k · cache 12 marker (aggressive)
        │           │             │           │            │            │
        │           │             │           │            │            └ provider mode
        │           │             │           │            └ cache-relevant requests
        │           │             │           └ total tokens saved this session
        │           │             └ tool-result compression session avg (Lever 2)
        │           └ tool-schema compression session avg (Lever 1)
        └ tool-schema compression last request
```

Fields are hidden when there's nothing to show — e.g. `cache N` only appears
on Anthropic / OpenAI runs, `res −%` only after a large enough tool result.

## Commands

```
/tscg                           Open settings menu (or show status if no UI)
/tscg status                    Print full session stats
/tscg on                        Enable compression
/tscg off                       Disable (full pass-through)
/tscg profile <name>            light | balanced | aggressive
/tscg result <on|off>           Toggle tool-result compression (Lever 2)
/tscg cache <on|off>            Toggle provider cache awareness (Lever 3)
/tscg ext <on|off>              Toggle extended TSCG operators (Lever 1)
/tscg budget <tokens>           Token budget per tool result (default 4000)
/tscg exclude <tool-name>       Skip a specific tool from schema compression
/tscg include <tool-name>       Re-enable a previously excluded tool
/tscg reset                     Reset session counters
```

## Settings

Settings live in `<cwd>/.pi/tscg.json` if your project has a `.pi/` directory,
otherwise in `~/.pi/tscg.json`. Defaults are sensible — you usually don't have
to touch this file:

```json
{
  "enabled": true,
  "profile": "balanced",
  "excludeTools": [],
  "showFooterStats": true,
  "aggressiveMaxDescChars": 200,
  "extendedOperators": true,
  "pruneJsonOverhead": true,
  "resultCompression": true,
  "resultMaxTokens": 4000,
  "resultExcludeTools": ["edit", "write", "notebook_edit", "notebookedit"],
  "enablePromptCache": true
}
```

## How it integrates with Pi

Pi's extension API exposes the full agent lifecycle as event hooks. This
extension uses three of them:

```ts
on("session_start",            ...) // load settings
on("before_provider_request",  ...) // Lever 1 + Lever 3
on("tool_result",              ...) // Lever 2
```

No payload, conversation, or tool-call mutation happens elsewhere. The
extension is purely additive — disable it (`/tscg off`) and Pi behaves
exactly as it did before.

## Expected savings

Wildly dependent on workload. From a real session on `qwen3.5:9b`
(Ollama) over Pi v0.70.5 with `aggressive` profile and a typical mix of
HTML editing + filesystem inventory:

```
↑503k input · ↓15k output · 14.6k tokens saved (≈10 500 words)
Lever 1 (schema):  8.3 %  (constant — Pi's built-in tools are already lean)
Lever 2 (results): 62 %    (dominant — find/bash with large outputs)
Lever 3 (cache):   inactive (Ollama, no provider-side cache)
```

On Anthropic API the same workload would additionally engage Lever 3 → Tool
tokens billed at 10 % from call 2 on. On heavy MCP setups (Notion, Figma,
Supabase tool catalogs) Lever 1 alone climbs to 30–50 %.

## Development

```bash
git clone https://github.com/dominicwolf/pi-tscg.git
cd pi-tscg
npm install
npm run typecheck
```

Test locally without publishing:

```bash
pi install /absolute/path/to/pi-tscg
```

## Publishing

```bash
npm login
npm publish --access public
```

The `pi-package` keyword makes it discoverable on
[pi.dev/packages](https://pi.dev/packages).

## Roadmap

- **Strategy C — full TSCG with reverse-map** for tool names. Symbol-aliased
  tool definitions in the request, name restoration in the `tool_call` hook.
  Would push Lever-1 savings to 50–65 %, but adds complexity around parallel
  tool calls.
- **Gemini cachedContents** — finish the skeleton: POST tools to
  `/v1beta/cachedContents` on first call, reference the returned cache name
  on subsequent calls.
- **MCP auto-detection** — when MCP-server tools are present, switch their
  per-tool profile to `aggressive` automatically (high-yield) while keeping
  built-in tools on `light` (low-yield).
- **Live cache-hit logging** via `after_provider_response` — parse Anthropic
  `usage.cache_read_input_tokens` and OpenAI `usage.prompt_tokens_details.cached_tokens`
  to surface real cache effectiveness in the footer.

## Credits

The compression engine is [TSCG](https://github.com/SKZL-AI/tscg) by
Furkan Sakizli (SKZL-AI). This package is the Pi integration around it —
the core compression logic, all eight TSCG operators, and the deterministic
pipeline are theirs. See [`NOTICES.md`](./NOTICES.md) for license details.

The Pi-specific contributions in this package are:
- the lifecycle integration (Pi extension hooks),
- Lever 2 (tool-result compression — uses `applySDMToText` from core but the
  per-tool strategy and head/tail-truncation logic are added on top),
- Lever 3 (provider detection + per-provider cache strategy).

## License

MIT — see [`LICENSE`](./LICENSE).
