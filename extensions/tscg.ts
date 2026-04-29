import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AnyToolDefinition,
	applySDMToText,
	compressDescriptions,
	estimateTokens,
	type ModelTarget,
} from "@tscg/core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// Plugin version — keep in sync with package.json on every release.
const PLUGIN_VERSION = "0.2.3";
const STATUS_PREFIX = `pi-tscg v${PLUGIN_VERSION}`;

type Profile = "light" | "balanced" | "aggressive";

interface TscgSettings {
	enabled: boolean;
	profile: Profile;
	excludeTools: string[];
	showFooterStats: boolean;
	aggressiveMaxDescChars: number;
	// Hebel 1 — extended principle set on top of description-only mode
	extendedOperators: boolean;
	// Strategy A — strip non-semantic JSON-Schema overhead from tool schemas
	pruneJsonOverhead: boolean;
	// Hebel 2 — tool-result compression
	resultCompression: boolean;
	resultMaxTokens: number;
	resultExcludeTools: string[];
	// Hebel 3 — provider-aware prompt-cache awareness
	enablePromptCache: boolean;
}

type CacheMode = "marker" | "auto" | null;
type Provider = "anthropic" | "openai" | "ollama" | "google" | "unknown";

interface SessionStats {
	requestsCompressed: number;
	requestsBypassed: number;
	requestsFailed: number;
	totalOriginalTokens: number;
	totalCompressedTokens: number;
	lastSavingsPercent: number | null;
	lastSavingsTokens: number | null;
	// Hebel 2 stats
	resultsCompressed: number;
	resultsSkipped: number;
	totalResultOriginalTokens: number;
	totalResultCompressedTokens: number;
	lastResultSavingsPercent: number | null;
	// Hebel 3 stats — provider-aware cache awareness
	cachedRequests: number;
	cacheProviderMode: CacheMode;
	lastProvider: Provider;
	// Total-Payload-Tracking — für Gesamt-Einsparungs-Anzeige
	totalSentPayloadTokens: number;
}

type ToolFormat = "anthropic" | "openai-completions" | "openai-responses" | "unknown";

const DEFAULTS: TscgSettings = {
	enabled: true,
	profile: "balanced",
	excludeTools: [],
	showFooterStats: true,
	aggressiveMaxDescChars: 150,
	extendedOperators: true,
	pruneJsonOverhead: true,
	resultCompression: true,
	resultMaxTokens: 4000,
	// Edits/Writes/NotebookEdit must NOT be touched — diffs need to stay byte-exact.
	resultExcludeTools: ["edit", "write", "notebook_edit", "notebookedit"],
	enablePromptCache: true,
};

const PROFILE_LABELS: Record<Profile, string> = {
	light: "light — only top-level descriptions, params untouched",
	balanced: "balanced — descriptions + params (recommended)",
	aggressive: "aggressive — also truncate long descriptions",
};

export default function (pi: ExtensionAPI): void {
	let settings: TscgSettings = { ...DEFAULTS };
	// Sensible fallback so commands fired before session_start don't write to "".
	let settingsFile = join(homedir(), ".pi", "tscg.json");
	const stats: SessionStats = freshStats();
	const notified = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		const resolved = resolveSettingsPath(ctx.cwd);
		settingsFile = resolved.path;
		settings = loadSettings(resolved.path);
		updateFooter(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!settings.enabled) return undefined;

		const payload = event.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const p = payload as Record<string, unknown>;
		const tools = p.tools;
		if (!Array.isArray(tools) || tools.length === 0) return undefined;

		const model = mapPiModelId(ctx.model?.id);

		type Slot =
			| { kind: "passthrough"; tool: unknown }
			| {
				kind: "compress";
				original: unknown;
				format: ToolFormat;
				normalized: AnyToolDefinition;
				originalParamDescriptions?: Map<string, string>;
			};

		const slots: Slot[] = [];
		const candidates: AnyToolDefinition[] = [];

		for (let i = 0; i < tools.length; i++) {
			const t = tools[i];
			const name = getToolName(t);
			// Case-insensitive exclusion check: settings.excludeTools is normalized
			// to lowercase in toggleExclusion(); compare against lowercase here.
			const isExcluded =
				name !== undefined &&
				settings.excludeTools.includes(name.toLowerCase());
			const fmt = detectFormat(t);
			if (isExcluded || fmt === "unknown") {
				slots.push({ kind: "passthrough", tool: t });
				continue;
			}
			const normalized = toCompressableFormat(t, fmt);
			if (!normalized) {
				slots.push({ kind: "passthrough", tool: t });
				continue;
			}
			let originalParamDescriptions: Map<string, string> | undefined;
			if (settings.profile === "light") {
				originalParamDescriptions = snapshotParamDescriptions(normalized);
			}
			slots.push({
				kind: "compress",
				original: t,
				format: fmt,
				normalized,
				originalParamDescriptions,
			});
			candidates.push(normalized);
		}

		if (candidates.length === 0) {
			stats.requestsBypassed++;
			return undefined;
		}

		const originalTokens = estimateTokens(JSON.stringify(candidates), model);

		let compressed: AnyToolDefinition[];
		try {
			const result = compressDescriptions(
				candidates,
				settings.extendedOperators
					? {
						model,
						profile: "aggressive",
						// All eight TSCG paper operators are safe in description-only mode:
						// the JSON structure (and therefore tool names) is preserved by the
						// description-only path; only description strings get rewritten.
						principles: {
							sdm: true,
							dro: true,
							cas: true,
							ccp: true,
							cfl: true,
							cfo: true,
							sad: true,
							tas: true,
						},
					}
					: { model },
			);
			compressed = result.tools;
		} catch (err) {
			stats.requestsFailed++;
			notifyOnce(
				ctx,
				notified,
				"tscg-fail",
				`TSCG compression failed (${errorMessage(err)}); using uncompressed tools.`,
				"warning",
			);
			return undefined;
		}

		// Strategy A — prune non-semantic JSON overhead AFTER TSCG compression.
		// Removes $schema/$id/$ref (validator metadata), empty examples/enum,
		// undefined defaults. Conservative: keeps additionalProperties because
		// changing it would alter validator semantics (Default-OPEN vs strict).
		// Wirksam vor allem auf MCP-Tools mit verbosem JSON-Schema-Boilerplate.
		if (settings.pruneJsonOverhead) {
			compressed = compressed.map(
				(t) => pruneJsonOverhead(t) as AnyToolDefinition,
			);
		}

		// Apply intensity profile
		const compressIdx: number[] = [];
		for (let i = 0; i < slots.length; i++) {
			if (slots[i]!.kind === "compress") compressIdx.push(i);
		}
		for (let ci = 0; ci < compressed.length; ci++) {
			const slot = slots[compressIdx[ci]!] as Extract<Slot, { kind: "compress" }>;
			let t = compressed[ci]!;
			if (settings.profile === "light" && slot.originalParamDescriptions) {
				t = restoreParamDescriptions(t, slot.originalParamDescriptions);
			} else if (settings.profile === "aggressive") {
				t = truncateLongDescriptions(t, settings.aggressiveMaxDescChars);
			}
			compressed[ci] = t;
		}

		const compressedTokens = estimateTokens(JSON.stringify(compressed), model);

		const merged: unknown[] = new Array(tools.length);
		let ci = 0;
		for (let i = 0; i < slots.length; i++) {
			const slot = slots[i]!;
			if (slot.kind === "passthrough") {
				merged[i] = slot.tool;
			} else {
				const c = compressed[ci++]!;
				merged[i] = restoreFormat(c, slot.original, slot.format);
			}
		}

		// Hebel 3 — Provider-aware cache-awareness layer.
		// Each provider has a different cache mechanism:
		//   - Anthropic API: explicit cache_control marker on tools block
		//   - OpenAI API:    automatic prefix caching ≥1024 tokens (no marker, just determinism)
		//   - Ollama:        no API-level cache (no token billing, no win)
		//   - Google Gemini: separate cachedContents API (skeleton below, not yet wired)
		const provider = detectProvider(p, ctx.model?.id);
		stats.lastProvider = provider;
		if (settings.enablePromptCache && merged.length > 0) {
			if (provider === "anthropic") {
				// Set ephemeral cache marker on the last tool that was actually
				// processed as Anthropic format. Passthrough or excluded tools
				// might be in different formats (OpenAI-completions etc.); attaching
				// cache_control to those would produce malformed Anthropic requests.
				let lastAnthropicIdx = -1;
				for (let i = slots.length - 1; i >= 0; i--) {
					const slot = slots[i]!;
					if (slot.kind === "compress" && slot.format === "anthropic") {
						lastAnthropicIdx = i;
						break;
					}
				}
				if (lastAnthropicIdx >= 0) {
					const lastTool = merged[lastAnthropicIdx] as Record<string, unknown>;
					merged[lastAnthropicIdx] = {
						...lastTool,
						cache_control: { type: "ephemeral" },
					};
					stats.cachedRequests++;
					stats.cacheProviderMode = "marker";
				}
			} else if (provider === "openai") {
				// OpenAI auto-caches identical prefixes ≥1024 tokens. We don't set a
				// marker, but our deterministic compression makes the prefix stable.
				// Heuristic: count call as cache-eligible iff compressed tools ≥1024 tk.
				if (compressedTokens >= 1024) {
					stats.cachedRequests++;
					stats.cacheProviderMode = "auto";
				}
			} else if (provider === "google") {
				// TODO(gemini): Use cachedContents API.
				// Plan: on first call, POST to /v1beta/cachedContents with the tools
				// payload and TTL; receive a cache name; on subsequent calls reference
				// the cache name in `cachedContent` field instead of inlining tools.
				// Requires google-genai SDK or direct REST call from the extension.
				// Skeleton hook left here so future Gemini-support PR has one place.
			}
			// provider === "ollama" or "unknown": no-op, no cache to engage.
		}

		const savedTokens = originalTokens - compressedTokens;
		const savedPct = originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

		stats.requestsCompressed++;
		stats.totalOriginalTokens += originalTokens;
		stats.totalCompressedTokens += compressedTokens;
		stats.lastSavingsPercent = savedPct;
		stats.lastSavingsTokens = savedTokens;

		// Total-Payload-Größe (nach Compression) für Gesamt-Einsparungs-Anzeige
		try {
			const finalPayload = { ...p, tools: merged };
			stats.totalSentPayloadTokens += estimateTokens(
				JSON.stringify(finalPayload),
				model,
			);
		} catch {
			// Bei Serialisierungs-Problemen Total-Stats unverändert lassen
		}

		updateFooter(ctx);

		return { ...p, tools: merged };
	});

	// Hebel 2 — tool-result compression.
	// Fires after every tool execution, before the result is returned to the LLM.
	// We mutate the text content of tool results to save tokens on the way back up.
	// Edits/Writes are excluded by default to keep diffs byte-exact.
	pi.on("tool_result", (event, ctx) => {
		if (!settings.enabled || !settings.resultCompression) return undefined;
		if (event.isError) return undefined;
		if (!Array.isArray(event.content) || event.content.length === 0) return undefined;

		const toolName = (event.toolName ?? "").toLowerCase();
		if (!toolName) return undefined;
		if (settings.resultExcludeTools.includes(toolName)) return undefined;

		const model = mapPiModelId(ctx.model?.id);
		const budget = settings.resultMaxTokens;

		let originalTokens = 0;
		let compressedTokens = 0;
		let mutated = false;

		const newContent = event.content.map((block) => {
			if (!block || typeof block !== "object") return block;
			const b = block as unknown as Record<string, unknown>;
			if (b.type !== "text" || typeof b.text !== "string") return block;
			const original = b.text;
			if (original.length === 0) return block;

			const before = estimateTokens(original, model);
			originalTokens += before;

			const compressed = compressToolResultText(toolName, original, budget, model);
			if (compressed === original) {
				compressedTokens += before;
				return block;
			}
			const after = estimateTokens(compressed, model);
			compressedTokens += after;
			mutated = true;
			return { ...b, text: compressed };
		});

		if (!mutated) {
			stats.resultsSkipped++;
			return undefined;
		}

		stats.resultsCompressed++;
		stats.totalResultOriginalTokens += originalTokens;
		stats.totalResultCompressedTokens += compressedTokens;
		stats.lastResultSavingsPercent =
			originalTokens > 0
				? ((originalTokens - compressedTokens) / originalTokens) * 100
				: 0;

		updateFooter(ctx);

		return { content: newContent as typeof event.content };
	});

	pi.registerCommand("tscg", {
		description: "Control TSCG tool-schema compression",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);
			const sub = args[0]?.toLowerCase();

			if (!sub) {
				await openMenu(ctx);
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(formatStatus(settings, stats, settingsFile), "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				settings.enabled = sub === "on";
				persist(ctx, settings, settingsFile);
				updateFooter(ctx);
				ctx.ui.notify(`TSCG ${sub}`, "info");
				return;
			}

			if (sub === "profile") {
				const name = args[1]?.toLowerCase();
				if (!name || !isValidProfile(name)) {
					ctx.ui.notify(
						`Usage: /tscg profile <light|balanced|aggressive>`,
						"warning",
					);
					return;
				}
				settings.profile = name;
				persist(ctx, settings, settingsFile);
				ctx.ui.notify(`TSCG profile: ${name}`, "info");
				return;
			}

			if (sub === "exclude" || sub === "include") {
				const tool = args[1];
				if (!tool) {
					ctx.ui.notify(`Usage: /tscg ${sub} <tool-name>`, "warning");
					return;
				}
				toggleExclusion(tool, sub === "exclude");
				persist(ctx, settings, settingsFile);
				ctx.ui.notify(
					sub === "exclude"
						? `TSCG: '${tool}' will not be compressed`
						: `TSCG: '${tool}' will be compressed again`,
					"info",
				);
				return;
			}

			if (sub === "reset") {
				resetStats(stats);
				updateFooter(ctx);
				ctx.ui.notify("TSCG: session stats reset", "info");
				return;
			}

			if (sub === "result" || sub === "results") {
				const flag = args[1]?.toLowerCase();
				if (flag !== "on" && flag !== "off") {
					ctx.ui.notify("Usage: /tscg result <on|off>", "warning");
					return;
				}
				settings.resultCompression = flag === "on";
				persist(ctx, settings, settingsFile);
				updateFooter(ctx);
				ctx.ui.notify(`TSCG result-compression ${flag}`, "info");
				return;
			}

			if (sub === "cache") {
				const flag = args[1]?.toLowerCase();
				if (flag !== "on" && flag !== "off") {
					ctx.ui.notify("Usage: /tscg cache <on|off>", "warning");
					return;
				}
				settings.enablePromptCache = flag === "on";
				persist(ctx, settings, settingsFile);
				updateFooter(ctx);
				ctx.ui.notify(`TSCG prompt-cache ${flag}`, "info");
				return;
			}

			if (sub === "ext" || sub === "operators") {
				const flag = args[1]?.toLowerCase();
				if (flag !== "on" && flag !== "off") {
					ctx.ui.notify("Usage: /tscg ext <on|off>", "warning");
					return;
				}
				settings.extendedOperators = flag === "on";
				persist(ctx, settings, settingsFile);
				ctx.ui.notify(`TSCG extended-operators ${flag}`, "info");
				return;
			}

			if (sub === "budget") {
				const n = Number(args[1]);
				if (!Number.isFinite(n) || n < 100 || n > 100000) {
					ctx.ui.notify(
						"Usage: /tscg budget <tokens 100-100000>",
						"warning",
					);
					return;
				}
				settings.resultMaxTokens = Math.floor(n);
				persist(ctx, settings, settingsFile);
				ctx.ui.notify(
					`TSCG result-budget: ${settings.resultMaxTokens} tokens`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Unknown subcommand. Try: /tscg | status | on | off | profile <name> | exclude <tool> | include <tool> | result <on|off> | cache <on|off> | ext <on|off> | budget <N> | reset",
				"warning",
			);
		},
	});

	async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatStatus(settings, stats, settingsFile), "info");
			return;
		}

		const enabledLabel = `Compression:  ${settings.enabled ? "ON" : "OFF"}  (toggle)`;
		const profileLabel = `Profile:      ${settings.profile}  (change…)`;
		const excludedCount = settings.excludeTools.length;
		const excludedLabel = `Excluded:     ${excludedCount === 0 ? "none" : `${excludedCount} tool(s)`}  (manage…)`;
		const statsLabel =
			stats.requestsCompressed === 0
				? "Stats:        no requests yet"
				: `Stats:        −${pctStr(stats.totalOriginalTokens, stats.totalCompressedTokens)}, saved ${formatTokens(stats.totalOriginalTokens - stats.totalCompressedTokens)}`;

		const choice = await ctx.ui.select("TSCG · settings", [
			enabledLabel,
			profileLabel,
			excludedLabel,
			"Show full status",
			`${statsLabel} — reset?`,
			"Cancel",
		]);

		if (!choice || choice === "Cancel") return;

		if (choice === enabledLabel) {
			settings.enabled = !settings.enabled;
			persist(ctx, settings, settingsFile);
			updateFooter(ctx);
			ctx.ui.notify(`TSCG ${settings.enabled ? "on" : "off"}`, "info");
			return;
		}

		if (choice === profileLabel) {
			await chooseProfile(ctx);
			return;
		}

		if (choice === excludedLabel) {
			await manageExclusions(ctx);
			return;
		}

		if (choice === "Show full status") {
			ctx.ui.notify(formatStatus(settings, stats, settingsFile), "info");
			return;
		}

		if (choice.startsWith("Stats:")) {
			const ok = await ctx.ui.confirm(
				"Reset stats?",
				"Clear all session counters and token totals.",
			);
			if (ok) {
				resetStats(stats);
				updateFooter(ctx);
				ctx.ui.notify("TSCG: stats reset", "info");
			}
			return;
		}
	}

	async function chooseProfile(ctx: ExtensionCommandContext): Promise<void> {
		const profiles: Profile[] = ["light", "balanced", "aggressive"];
		const options = profiles.map((p) =>
			p === settings.profile ? `${PROFILE_LABELS[p]}  ✓` : PROFILE_LABELS[p],
		);
		const picked = await ctx.ui.select("Profile", [...options, "Cancel"]);
		if (!picked || picked === "Cancel") return;

		const newProfile = profiles.find((p) => picked.startsWith(PROFILE_LABELS[p]));
		if (!newProfile) return;
		settings.profile = newProfile;
		persist(ctx, settings, settingsFile);
		ctx.ui.notify(`TSCG profile: ${newProfile}`, "info");
	}

	async function manageExclusions(ctx: ExtensionCommandContext): Promise<void> {
		const excluded = settings.excludeTools;
		const options: string[] = [];
		options.push("Add tool to exclusion list…");
		if (excluded.length > 0) {
			options.push("Remove tool from exclusion list…");
			options.push(`(currently excluded: ${excluded.join(", ")})`);
		}
		options.push("Cancel");

		const choice = await ctx.ui.select("Manage exclusions", options);
		if (!choice || choice === "Cancel" || choice.startsWith("(currently")) return;

		if (choice === "Add tool to exclusion list…") {
			const name = await ctx.ui.input(
				"Tool name to exclude",
				"e.g. bash, read_file",
			);
			if (!name) return;
			toggleExclusion(name.trim(), true);
			persist(ctx, settings, settingsFile);
			ctx.ui.notify(`Excluded '${name.trim()}'`, "info");
			return;
		}

		if (choice === "Remove tool from exclusion list…") {
			const picked = await ctx.ui.select("Remove which?", [...excluded, "Cancel"]);
			if (!picked || picked === "Cancel") return;
			toggleExclusion(picked, false);
			persist(ctx, settings, settingsFile);
			ctx.ui.notify(`Re-included '${picked}'`, "info");
			return;
		}
	}

	function toggleExclusion(tool: string, exclude: boolean): void {
		// Normalize to lowercase so the exclusion check at request-time can
		// compare case-insensitively (tool names from Pi may be "Bash" or
		// "bash" depending on provider).
		const normalized = tool.trim().toLowerCase();
		if (!normalized) return;
		const set = new Set(settings.excludeTools.map((s) => s.toLowerCase()));
		if (exclude) set.add(normalized);
		else set.delete(normalized);
		settings.excludeTools = Array.from(set).sort();
	}

	function updateFooter(ctx: ExtensionContext | ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		if (!settings.showFooterStats) {
			ctx.ui.setStatus("tscg", undefined);
			return;
		}
		if (!settings.enabled) {
			ctx.ui.setStatus("tscg", `${STATUS_PREFIX} · off`);
			return;
		}
		if (stats.requestsCompressed === 0 && stats.resultsCompressed === 0) {
			ctx.ui.setStatus("tscg", `${STATUS_PREFIX} · ready (${settings.profile})`);
			return;
		}
		const parts: string[] = [];
		if (stats.requestsCompressed > 0) {
			if (stats.lastSavingsPercent !== null) {
				const dec = stats.lastSavingsPercent < 10 ? 1 : 0;
				parts.push(`last −${stats.lastSavingsPercent.toFixed(dec)}%`);
			}
			const sessionPct = pctStr(
				stats.totalOriginalTokens,
				stats.totalCompressedTokens,
			);
			parts.push(`session −${sessionPct}`);
		}
		if (stats.resultsCompressed > 0) {
			const resPct = pctStr(
				stats.totalResultOriginalTokens,
				stats.totalResultCompressedTokens,
			);
			parts.push(`res −${resPct}`);
		}
		const totalSaved =
			stats.totalOriginalTokens -
			stats.totalCompressedTokens +
			(stats.totalResultOriginalTokens - stats.totalResultCompressedTokens);
		if (totalSaved > 0) {
			parts.push(`saved ${formatTokens(totalSaved)}`);
		}
		// Gesamt-Einsparungs-Quote: was wir gespart haben relativ zur hypothetischen
		// "ohne Plugin"-Last (= tatsächlich gesendete Payload + gespartes Material)
		if (totalSaved > 0 && stats.totalSentPayloadTokens > 0) {
			const denom = stats.totalSentPayloadTokens + totalSaved;
			const totalRate = (totalSaved / denom) * 100;
			const decimals = totalRate < 10 ? 1 : 0;
			parts.push(`total −${totalRate.toFixed(decimals)}%`);
		}
		if (settings.enablePromptCache && stats.cachedRequests > 0) {
			const modeLabel = stats.cacheProviderMode
				? ` ${stats.cacheProviderMode}`
				: "";
			parts.push(`cache ${stats.cachedRequests}${modeLabel}`);
		}
		ctx.ui.setStatus("tscg", `${STATUS_PREFIX} · ${parts.join(" · ")} (${settings.profile})`);
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function freshStats(): SessionStats {
	return {
		requestsCompressed: 0,
		requestsBypassed: 0,
		requestsFailed: 0,
		totalOriginalTokens: 0,
		totalCompressedTokens: 0,
		lastSavingsPercent: null,
		lastSavingsTokens: null,
		resultsCompressed: 0,
		resultsSkipped: 0,
		totalResultOriginalTokens: 0,
		totalResultCompressedTokens: 0,
		lastResultSavingsPercent: null,
		cachedRequests: 0,
		cacheProviderMode: null,
		lastProvider: "unknown",
		totalSentPayloadTokens: 0,
	};
}

function resetStats(s: SessionStats): void {
	s.requestsCompressed = 0;
	s.requestsBypassed = 0;
	s.requestsFailed = 0;
	s.totalOriginalTokens = 0;
	s.totalCompressedTokens = 0;
	s.lastSavingsPercent = null;
	s.lastSavingsTokens = null;
	s.resultsCompressed = 0;
	s.resultsSkipped = 0;
	s.totalResultOriginalTokens = 0;
	s.totalResultCompressedTokens = 0;
	s.lastResultSavingsPercent = null;
	s.cachedRequests = 0;
	s.cacheProviderMode = null;
	s.lastProvider = "unknown";
	s.totalSentPayloadTokens = 0;
}

function isValidProfile(s: string): s is Profile {
	return s === "light" || s === "balanced" || s === "aggressive";
}

function resolveSettingsPath(cwd: string): {
	path: string;
	scope: "project" | "user";
} {
	const projectDir = join(cwd, ".pi");
	if (existsSync(projectDir)) {
		return { path: join(projectDir, "tscg.json"), scope: "project" };
	}
	return { path: join(homedir(), ".pi", "tscg.json"), scope: "user" };
}

function loadSettings(path: string): TscgSettings {
	try {
		if (!existsSync(path)) return { ...DEFAULTS };
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TscgSettings>;
		const merged = { ...DEFAULTS, ...raw };
		if (!isValidProfile(merged.profile)) merged.profile = DEFAULTS.profile;
		return merged;
	} catch {
		return { ...DEFAULTS };
	}
}

function persist(
	ctx: ExtensionContext | ExtensionCommandContext,
	settings: TscgSettings,
	settingsFile: string,
): void {
	try {
		mkdirSync(dirname(settingsFile), { recursive: true });
		writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`TSCG: failed to save settings (${errorMessage(err)})`,
				"warning",
			);
		}
	}
}

function formatStatus(
	settings: TscgSettings,
	stats: SessionStats,
	settingsFile: string,
): string {
	const lines: string[] = [];
	lines.push("TSCG status");
	lines.push(`  enabled:        ${settings.enabled}`);
	lines.push(`  profile:        ${settings.profile}`);
	lines.push(`  ext-operators:  ${settings.extendedOperators}`);
	lines.push(`  result-compr:   ${settings.resultCompression} (budget ${settings.resultMaxTokens} tok)`);
	lines.push(`  prompt-cache:   ${settings.enablePromptCache}`);
	lines.push(
		`  excluded:       ${settings.excludeTools.length === 0 ? "(none)" : settings.excludeTools.join(", ")}`,
	);
	lines.push(
		`  result-skip:    ${settings.resultExcludeTools.length === 0 ? "(none)" : settings.resultExcludeTools.join(", ")}`,
	);
	lines.push("");
	lines.push("session — tool schemas:");
	lines.push(
		`  requests: ${stats.requestsCompressed} compressed, ${stats.requestsBypassed} bypassed, ${stats.requestsFailed} failed`,
	);
	if (stats.requestsCompressed > 0) {
		const saved = stats.totalOriginalTokens - stats.totalCompressedTokens;
		const pct = pctStr(stats.totalOriginalTokens, stats.totalCompressedTokens);
		lines.push(
			`  tokens:   ${stats.totalOriginalTokens} → ${stats.totalCompressedTokens} (saved ${saved}, −${pct})`,
		);
		if (stats.lastSavingsPercent !== null) {
			const dec = stats.lastSavingsPercent < 10 ? 1 : 0;
			lines.push(
				`  last:     −${stats.lastSavingsPercent.toFixed(dec)}% (${stats.lastSavingsTokens} tokens)`,
			);
		}
	}
	lines.push("");
	lines.push("session — tool results:");
	lines.push(
		`  results:  ${stats.resultsCompressed} compressed, ${stats.resultsSkipped} skipped`,
	);
	if (stats.resultsCompressed > 0) {
		const saved =
			stats.totalResultOriginalTokens - stats.totalResultCompressedTokens;
		const pct = pctStr(
			stats.totalResultOriginalTokens,
			stats.totalResultCompressedTokens,
		);
		lines.push(
			`  tokens:   ${stats.totalResultOriginalTokens} → ${stats.totalResultCompressedTokens} (saved ${saved}, −${pct})`,
		);
	}
	if (settings.enablePromptCache) {
		lines.push("");
		lines.push("session — provider cache:");
		lines.push(`  provider: ${stats.lastProvider}`);
		const modeText =
			stats.cacheProviderMode === "marker"
				? "marker (cache_control set)"
				: stats.cacheProviderMode === "auto"
					? "auto (OpenAI prefix-cache eligible)"
					: "none";
		lines.push(`  mode:     ${modeText}`);
		lines.push(`  count:    ${stats.cachedRequests} cache-relevant requests`);
	}
	lines.push("");
	lines.push(`settings: ${settingsFile}`);
	return lines.join("\n");
}

function notifyOnce(
	ctx: ExtensionContext,
	notified: Set<string>,
	key: string,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (notified.has(key)) return;
	notified.add(key);
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function detectFormat(t: unknown): ToolFormat {
	if (!t || typeof t !== "object") return "unknown";
	const obj = t as Record<string, unknown>;
	if (
		typeof obj.name === "string" &&
		typeof obj.description === "string" &&
		obj.input_schema !== undefined
	) {
		return "anthropic";
	}
	if (
		obj.type === "function" &&
		typeof obj.name === "string" &&
		typeof obj.description === "string" &&
		obj.parameters !== undefined
	) {
		return "openai-responses";
	}
	if (obj.type === "function" && obj.function && typeof obj.function === "object") {
		return "openai-completions";
	}
	return "unknown";
}

function toCompressableFormat(t: unknown, fmt: ToolFormat): AnyToolDefinition | null {
	if (fmt === "anthropic" || fmt === "openai-completions") {
		return t as AnyToolDefinition;
	}
	if (fmt === "openai-responses") {
		const o = t as Record<string, unknown>;
		return {
			type: "function",
			function: {
				name: o.name as string,
				description: o.description as string,
				parameters: o.parameters as never,
			},
		} as unknown as AnyToolDefinition;
	}
	return null;
}

function restoreFormat(
	compressed: AnyToolDefinition,
	original: unknown,
	fmt: ToolFormat,
): unknown {
	if (fmt === "anthropic" || fmt === "openai-completions") {
		return compressed;
	}
	if (fmt === "openai-responses") {
		const orig = original as Record<string, unknown>;
		const c = compressed as { function?: { description?: string; parameters?: unknown } };
		return {
			...orig,
			description: c.function?.description ?? orig.description,
			parameters: c.function?.parameters ?? orig.parameters,
		};
	}
	return original;
}

function snapshotParamDescriptions(t: AnyToolDefinition): Map<string, string> {
	const map = new Map<string, string>();
	const props = getParamProperties(t);
	if (!props) return map;
	for (const [k, v] of Object.entries(props)) {
		if (v && typeof v === "object" && typeof (v as { description?: unknown }).description === "string") {
			map.set(k, (v as { description: string }).description);
		}
	}
	return map;
}

function restoreParamDescriptions(
	t: AnyToolDefinition,
	originals: Map<string, string>,
): AnyToolDefinition {
	if (originals.size === 0) return t;
	const props = getParamProperties(t);
	if (!props) return t;
	const newProps: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(props)) {
		if (originals.has(k) && v && typeof v === "object") {
			newProps[k] = { ...v, description: originals.get(k) };
		} else {
			newProps[k] = v;
		}
	}
	return setParamProperties(t, newProps);
}

function truncateLongDescriptions(t: AnyToolDefinition, maxChars: number): AnyToolDefinition {
	const truncated = truncate(getDescription(t), maxChars);
	let next = setDescription(t, truncated);
	const props = getParamProperties(next);
	if (props) {
		const newProps: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(props)) {
			if (v && typeof v === "object") {
				const vDesc = (v as { description?: unknown }).description;
				if (typeof vDesc === "string") {
					newProps[k] = { ...v, description: truncate(vDesc, maxChars) };
				} else {
					newProps[k] = v;
				}
			} else {
				newProps[k] = v;
			}
		}
		next = setParamProperties(next, newProps);
	}
	return next;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1).trimEnd()}…`;
}

function getDescription(t: AnyToolDefinition): string {
	const obj = t as unknown as Record<string, unknown>;
	if (typeof obj.description === "string") return obj.description;
	const fn = obj.function as { description?: string } | undefined;
	return fn?.description ?? "";
}

function setDescription(t: AnyToolDefinition, desc: string): AnyToolDefinition {
	const obj = t as unknown as Record<string, unknown>;
	if (typeof obj.description === "string") {
		return { ...obj, description: desc } as unknown as AnyToolDefinition;
	}
	const fn = obj.function as Record<string, unknown> | undefined;
	if (fn) {
		return { ...obj, function: { ...fn, description: desc } } as unknown as AnyToolDefinition;
	}
	return t;
}

function getParamProperties(t: AnyToolDefinition): Record<string, unknown> | null {
	const obj = t as unknown as Record<string, unknown>;
	const schema =
		(obj.input_schema as Record<string, unknown> | undefined) ??
		((obj.function as Record<string, unknown> | undefined)?.parameters as Record<string, unknown> | undefined);
	if (!schema || typeof schema !== "object") return null;
	const props = schema.properties;
	if (!props || typeof props !== "object") return null;
	return props as Record<string, unknown>;
}

function setParamProperties(
	t: AnyToolDefinition,
	properties: Record<string, unknown>,
): AnyToolDefinition {
	const obj = t as unknown as Record<string, unknown>;
	if (obj.input_schema && typeof obj.input_schema === "object") {
		return {
			...obj,
			input_schema: { ...(obj.input_schema as object), properties },
		} as unknown as AnyToolDefinition;
	}
	const fn = obj.function as Record<string, unknown> | undefined;
	if (fn?.parameters && typeof fn.parameters === "object") {
		return {
			...obj,
			function: {
				...fn,
				parameters: { ...(fn.parameters as object), properties },
			},
		} as unknown as AnyToolDefinition;
	}
	return t;
}

function getToolName(t: unknown): string | undefined {
	if (!t || typeof t !== "object") return undefined;
	const obj = t as Record<string, unknown>;
	if (typeof obj.name === "string") return obj.name;
	const fn = obj.function as Record<string, unknown> | undefined;
	if (fn && typeof fn.name === "string") return fn.name;
	return undefined;
}

function mapPiModelId(piModelId: string | undefined): ModelTarget {
	if (!piModelId) return "auto";
	// Ollama uses 'name:tag' format — strip tag for matching.
	const id = piModelId.toLowerCase().split(":")[0]!;

	if (id.startsWith("claude-opus")) return "claude-opus";
	if (id.startsWith("claude-sonnet")) return "claude-sonnet";
	if (id.startsWith("claude-haiku")) return "claude-haiku";

	if (id.startsWith("gpt-5")) return "gpt-5";
	if (id.includes("gpt-4o") && id.includes("mini")) return "gpt-4o-mini";
	if (id.startsWith("gpt-4") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
		return "gpt-4";
	}

	// Llama family — Ollama uses names like 'llama3.1', 'llama3.2', 'codellama:13b'
	if (id.includes("llama") && (id.includes("3.2") || id.includes("3-2"))) return "llama-3.2";
	if (id.includes("llama")) return "llama-3.1";

	if (id.startsWith("mistral-large") || id.includes("mistral-large")) return "mistral-large";
	if (id.includes("mixtral") || id.includes("mistral")) return "mistral-7b";

	if (id.includes("gemma")) return "gemma-3";
	if (id.includes("phi")) return "phi-4";
	if (id.includes("qwen")) return "qwen-3";
	if (id.includes("deepseek")) return "deepseek-v3";

	return "auto";
}

function pctStr(orig: number, comp: number): string {
	if (orig <= 0) return "0%";
	const pct = ((orig - comp) / orig) * 100;
	const decimals = pct < 10 ? 1 : 0;
	return `${pct.toFixed(decimals)}%`;
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// ── Tool-Result Compression (Hebel 2) ──────────────────────────────────────

function compressToolResultText(
	toolName: string,
	text: string,
	budget: number,
	model: ModelTarget,
): string {
	let out = text;

	// JSON-Pruning: wenn der ganze Output ein JSON-String ist (typisch bei MCP-Tools),
	// die nicht-semantischen Schema-Metadaten ($schema, $id, $comment, leere examples/enum)
	// rausstrippen. $ref bleibt — das ist load-bearing.
	const trimmed = out.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			const pruned = pruneJsonOverhead(parsed);
			const reformatted = JSON.stringify(pruned);
			// Nur ersetzen, wenn das Ergebnis kleiner ist (sonst bringt's nichts)
			if (reformatted.length < out.length) {
				out = reformatted;
			}
		} catch {
			// kein valides JSON → weiter mit Original-Text
		}
	}

	// Whitespace-Compaction und Duplicate-Line-Folding sind auf ALLEN Tool-Outputs safe
	// (außer Edits/Writes, die werden vom resultExcludeTools-Check vorher schon abgewiesen).
	// Sie ändern keine Bedeutung — nur Doppel-Leerzeilen werden zusammengefasst und
	// 4+ identische Folgezeilen kollabieren zu einer Zeile mit Counter.
	out = collapseWhitespace(out);
	out = foldDuplicateLines(out);

	// SDM (filler-word removal) ist nur auf natürlicher Sprache safe.
	// Auf strukturierten Outputs (read/grep/find/ls) würde SDM Pfadteile oder
	// Treffer-Strings zerschneiden — daher dort weglassen.
	if (toolName === "bash" || isCustomTool(toolName)) {
		try {
			out = applySDMToText(out);
		} catch {
			// keep current out
		}
	}

	// Cap at token budget with head/tail truncation.
	const tokens = estimateTokens(out, model);
	if (tokens > budget) {
		out = headTailTruncate(out, budget, model);
	}

	return out;
}

function collapseWhitespace(text: string): string {
	let out = text.replace(/[ \t]+\n/g, "\n");
	out = out.replace(/\n{3,}/g, "\n\n");
	return out;
}

function foldDuplicateLines(text: string): string {
	const lines = text.split("\n");
	const folded: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		let count = 1;
		while (i + count < lines.length && lines[i + count] === line) count++;
		if (count >= 4 && line.trim() !== "") {
			folded.push(`${line}  ⤺ ×${count}`);
		} else {
			for (let k = 0; k < count; k++) folded.push(line);
		}
		i += count;
	}
	return folded.join("\n");
}

function headTailTruncate(text: string, budget: number, model: ModelTarget): string {
	const tokens = estimateTokens(text, model);
	if (tokens <= budget) return text;

	// Roughly map token budget back to character budget (linear over the whole text).
	const charsPerToken = text.length / Math.max(1, tokens);
	const targetChars = Math.floor(budget * charsPerToken * 0.95);
	const headChars = Math.floor(targetChars * 0.6);
	const tailChars = Math.floor(targetChars * 0.35);

	const lines = text.split("\n");

	let headEnd = 0;
	let headLen = 0;
	while (headEnd < lines.length && headLen + lines[headEnd]!.length + 1 <= headChars) {
		headLen += lines[headEnd]!.length + 1;
		headEnd++;
	}

	let tailStart = lines.length;
	let tailLen = 0;
	while (tailStart > headEnd && tailLen + lines[tailStart - 1]!.length + 1 <= tailChars) {
		tailStart--;
		tailLen += lines[tailStart]!.length + 1;
	}

	if (tailStart <= headEnd) return text; // nothing to truncate

	const skippedLines = tailStart - headEnd;
	const skippedTokens = estimateTokens(
		lines.slice(headEnd, tailStart).join("\n"),
		model,
	);
	const marker = `\n[TSCG: ${skippedLines} lines / ~${formatTokens(skippedTokens)} tokens omitted — head + tail preserved]\n`;
	return lines.slice(0, headEnd).join("\n") + marker + lines.slice(tailStart).join("\n");
}

// ── Provider Detection (Hebel 3) ───────────────────────────────────────────

function detectProvider(
	payload: Record<string, unknown>,
	modelId: string | undefined,
): Provider {
	// Tool-format detection — most reliable signal
	const tools = payload.tools;
	if (Array.isArray(tools) && tools.length > 0) {
		const first = tools[0] as Record<string, unknown> | null;
		if (first && typeof first === "object") {
			if ("input_schema" in first) return "anthropic";
			if (first.type === "function") {
				// Could be OpenAI or Ollama (which uses OpenAI-compatible format).
				// Disambiguate by model-id below.
			}
		}
	}
	// Anthropic-specific: dedicated `system` field at root
	if (typeof payload.system === "string" || Array.isArray(payload.system)) {
		return "anthropic";
	}
	// Model-ID heuristics — Pi runs Ollama models with names like "qwen3.5:9b",
	// while OpenAI-API models look like "gpt-4o" or "o3-mini".
	const id = (modelId ?? "").toLowerCase().split(":")[0]!;
	if (id.startsWith("claude")) return "anthropic";
	if (/^(gpt-|o1|o3|o4|chatgpt)/.test(id)) return "openai";
	if (id.startsWith("gemini")) return "google";
	if (/(qwen|llama|mistral|deepseek|gemma|phi|codellama)/.test(id)) {
		return "ollama";
	}
	return "unknown";
}

function isCustomTool(name: string): boolean {
	return ![
		"bash",
		"read",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"notebook_edit",
		"notebookedit",
	].includes(name);
}

// ── Strategy A: JSON-Schema Overhead Pruning ──────────────────────────────
// Recursively walks a tool definition and removes non-semantic fields that
// LLMs never need for tool-call decisions. Keeps everything that changes
// validation semantics (additionalProperties, required, type, etc.).

function pruneJsonOverhead(node: unknown): unknown {
	if (node === null || node === undefined) return node;
	if (Array.isArray(node)) {
		return node.map(pruneJsonOverhead);
	}
	if (typeof node !== "object") return node;
	const obj = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		// Strip JSON-Schema validator metadata — LLMs ignore these.
		// IMPORTANT: do NOT strip $ref. $ref is load-bearing structural pointer
		// (heavily used by MCP servers); removing it leaves an empty {} and
		// silently changes the parameter type to `any` from the LLM's view.
		if (k === "$schema" || k === "$id" || k === "$comment") {
			continue;
		}
		// Strip empty arrays where the field is optional anyway
		if (k === "examples" && Array.isArray(v) && v.length === 0) continue;
		if (k === "enum" && Array.isArray(v) && v.length === 0) continue;
		// Strip explicit undefined defaults
		if (k === "default" && v === undefined) continue;
		out[k] = pruneJsonOverhead(v);
	}
	return out;
}
