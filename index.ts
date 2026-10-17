/**
 * Footer status listing the GitHub PRs belonging to this session, grouped by state
 * (● open, ✔ merged, ✕ closed), plus `/prs` to open one in the browser.
 *
 * A url only counts once `gh pr view` confirms it exists, so pasted or hypothetical
 * numbers never reach the footer.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";

import {
	candidates,
	checkLabel,
	checks,
	format,
	type Pr,
	type Prs,
	STATE_ENTRY,
	STYLE,
	type State,
	sorted,
	stateSnapshot,
} from "./core.ts";

// NOTE: local OSC 8 helper, semantically identical to upstream `@earendil-works/pi-tui`'s
// `hyperlink`; kept local because omp's pi-compat shim does not re-export it.
function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Like `getCapabilities().hyperlinks`, but also recognises Herdr: it renders
 * OSC 8 in its own grid (opens links on Ctrl+click) while hiding the outer
 * terminal from TERM/TERM_PROGRAM, so the upstream static probe reports
 * "unknown terminal" and conservatively returns false inside a Herdr pane. */
function hyperlinksEnabled(): boolean {
	if (getCapabilities().hyperlinks) return true;
	const env = process.env;
	return (
		env.HERDR_ENV === "1" ||
		Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID)
	);
}

const GH_TIMEOUT_MS = 15_000;
const STATE_TTL_MS = 60_000;

/** In-memory transcript text: the session's loaded entries serialised as the
 * JSONL lines they appear as on disk. Reading entries instead of the session
 * file keeps resume working on every entry path — `--resume <path>` binds the
 * file early, but id-prefix / continue / picker resumes emit `session_start`
 * while the writer is still on a fresh draft file, so a `readFileSync` of the
 * file at that moment sees nothing. A fresh session has no entries and the
 * open-elsewhere relocation chain keeps them in memory either way. */
function transcriptOf(ctx: ExtensionContext): string {
	const entries: unknown[] = ctx.sessionManager.getEntries();
	if (entries.length === 0) return "";
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

export default function (pi: ExtensionAPI) {
	const prs: Prs = new Map();
	const rejected = new Set<string>();
	let lastSnapshot: string | undefined;
	let statesCheckedAt = 0;

	/** Append the tracked-PR snapshot to the session transcript (`appendEntry`
	 * is pi's state-persistence channel, skipped by the LLM), so a resumed
	 * process rebuilds the footer even when the branch/worktree — and with
	 * them both `gh` recovery paths — are gone. Content-deduplicated: an
	 * unchanged session appends nothing. */
	const persist = () => {
		if (prs.size === 0) return;
		const snapshot: [string, Pr][] = [...prs];
		const serialized = JSON.stringify(snapshot);
		if (serialized === lastSnapshot) return;
		lastSnapshot = serialized;
		pi.appendEntry(STATE_ENTRY, snapshot);
	};

	/** One PR line below the composer band (omp docks belowEditor widgets
	 * under the editor, no leading spacer), grouped by state (● open, ✔
	 * merged, ✕ closure). Rendered via a Text widget so ANSI survives: omp's
	 * status band sanitises escape sequences, which would strip OSC 8 links.
	 * Terminals without hyperlink support degrade to plain #N. */
	const render = (ctx: ExtensionContext) => {
		const hyperlinks = hyperlinksEnabled();
		const text = format(
			prs,
			(t, url) => (hyperlinks ? hyperlink(t, url) : t),
			(color, t) => ctx.ui.theme.fg(color, t),
		);
		ctx.ui.setWidget(
			"omp-session-prs",
			text === undefined ? undefined : [text],
			{
				placement: "belowEditor",
			},
		);
	};

	/** Never throws: a flaky gh call must not take the pi process (and its tmux pane) down. */
	const lookup = async (ctx: ExtensionContext, url: string) => {
		try {
			const res = await pi.exec(
				"gh",
				["pr", "view", url, "--json", "number,title,state"],
				{
					cwd: ctx.cwd,
					timeout: GH_TIMEOUT_MS,
				},
			);
			if (res.code !== 0) return undefined;
			const pr = JSON.parse(res.stdout) as {
				number: number;
				title: string;
				state: State;
			};
			return STYLE[pr.state] ? pr : undefined;
		} catch {
			return undefined;
		}
	};

	const add = async (ctx: ExtensionContext, urls: string[]) => {
		// Parallel lookups: a long transcript mentions many PR urls, and serial
		// `gh pr view` calls (each with a 15s failure ceiling) delayed the first
		// render behind minutes of dead air; Promise.all keeps result order.
		const batch = [...new Set(urls)].filter(
			(url) => !prs.has(url) && !rejected.has(url),
		);
		if (batch.length === 0) return false;
		const found = await Promise.all(
			batch.map((url) => lookup(ctx, url).then((pr) => [url, pr] as const)),
		);
		let changed = false;
		for (const [url, pr] of found) {
			if (!pr) {
				rejected.add(url);
				continue;
			}
			prs.set(url, pr);
			changed = true;
		}
		return changed;
	};

	/** States drift (a PR gets merged while the session runs), so re-poll on a timer. */
	const refreshStates = async (ctx: ExtensionContext) => {
		if (Date.now() - statesCheckedAt < STATE_TTL_MS) return false;
		statesCheckedAt = Date.now();
		const found = await Promise.all(
			[...prs].map(async ([url, known]) => {
				const pr = await lookup(ctx, url);
				return pr && pr.state !== known.state
					? ([url, pr] as const)
					: undefined;
			}),
		);
		let changed = false;
		for (const entry of found) {
			if (!entry) continue;
			prs.set(entry[0], entry[1]);
			changed = true;
		}
		return changed;
	};

	const branchUrls = async (ctx: ExtensionContext) => {
		const opts = { cwd: ctx.cwd, timeout: GH_TIMEOUT_MS };
		try {
			const branch = (
				await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts)
			).stdout.trim();
			if (!branch) return [];
			const res = await pi.exec(
				"gh",
				["pr", "list", "--head", branch, "--json", "url"],
				opts,
			);
			return res.code === 0 ? candidates(res.stdout) : [];
		} catch {
			return [];
		}
	};

	/** session_start body, shared with omp's session_switch event: interactive
	 * picker / continue resumes load the target session only AFTER session_start
	 * fired on the still-empty draft journal, so the restore must run again when
	 * the switch completes. */
	const bootstrap = async (ctx: ExtensionContext) => {
		prs.clear();
		rejected.clear();
		statesCheckedAt = Date.now();
		const transcript = transcriptOf(ctx);
		// Resume path: the newest transcript snapshot restores the footer even
		// when the branch and worktree (and with them gh) are gone. Baseline the
		// serializer with the restored map so a no-op turn appends nothing.
		const snapshot = stateSnapshot(transcript);
		for (const [url, pr] of snapshot) prs.set(url, pr);
		lastSnapshot = JSON.stringify(snapshot);
		// Paint the restored footer immediately: the gh lookups below can take
		// tens of seconds (parallel, but each individual call has a 15s failure
		// ceiling), and a resumed session should never wait for them to show
		// the already-known PRs.
		render(ctx);
		const found = await add(ctx, [
			...candidates(transcript),
			...(await branchUrls(ctx)),
		]);
		if (found) persist();
		render(ctx);
	};

	pi.on("session_start", async (_e, ctx) => {
		await bootstrap(ctx);
	});

	// omp-only lifecycle event. Upstream pi 0.84 lacks it, and its `on` is a
	// permissive map registration that never throws on unknown names, so the
	// subscription is a no-op there (upstream CLI paths bind the session file
	// before session_start runs) — but tsc only modelling real overloads
	// forces the call through a widened view of the same method.
	const onSessionSwitch = pi.on as unknown as (
		event: "session_switch",
		handler: (event: unknown, ctx: ExtensionContext) => void,
	) => void;
	onSessionSwitch("session_switch", async (_e, ctx) => {
		await bootstrap(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const text =
			typeof event.result === "string"
				? event.result
				: JSON.stringify(event.result);
		if (text && (await add(ctx, candidates(text)))) {
			persist();
			render(ctx);
		}
	});

	// omp's extension runtime names this event `agent_end`; upstream pi 0.84 also
	// emits it, so the substitution is compatible with both hosts.
	pi.on("agent_end", async (_e, ctx) => {
		const found = await add(ctx, await branchUrls(ctx));
		if ((await refreshStates(ctx)) || found) {
			persist();
			render(ctx);
		}
	});

	const open = (url: string) =>
		pi.exec("open", [url], { timeout: GH_TIMEOUT_MS }).catch(() => {});

	/** Shared by /prs and /pr-checks; skips the dialog when there is nothing to choose. */
	const pickPr = async (
		ctx: ExtensionContext,
		title: string,
	): Promise<[string, Pr] | undefined> => {
		/** No forced refresh: agent_end already polls, and a blocking `gh pr view`
		 * per tracked PR delayed the picker by seconds. */
		if (await refreshStates(ctx)) render(ctx);
		const all = sorted(prs);
		if (all.length === 0) {
			ctx.ui.notify("No PRs in this session", "info");
			return undefined;
		}
		if (all.length === 1) return all[0];
		const labels = all.map(
			([, pr]) => `${STYLE[pr.state].icon} #${pr.number} ${pr.title}`,
		);
		const picked = await ctx.ui.select(title, labels);
		return picked ? all[labels.indexOf(picked)] : undefined;
	};

	/** `/prs list`: print the tracked PRs as a markdown list. TUIs render each
	 * row as a clickable OSC 8 hyperlink, so the list stays clickable inside
	 * terminal multiplexers such as herdr/tmux. */
	const listPrs = async (ctx: ExtensionContext) => {
		if (await refreshStates(ctx)) render(ctx);
		const all = sorted(prs);
		if (all.length === 0) {
			ctx.ui.notify("No PRs in this session", "info");
			return;
		}
		const lines = all.map(
			([url, pr]) =>
				`- ${STYLE[pr.state].icon} [#${pr.number} ${pr.title}](${url})`,
		);
		pi.sendMessage({
			customType: "omp-session-prs.list",
			content: `Pull requests in this session:\n${lines.join("\n")}`,
			display: true,
		});
	};

	pi.registerCommand("prs", {
		description:
			"Open a PR from this session in the browser; `list` prints clickable links",
		handler: async (args, ctx) => {
			if (args.trim() === "list") return listPrs(ctx);
			const entry = await pickPr(ctx, "Open PR");
			if (entry) await open(entry[0]);
		},
	});

	pi.registerCommand("pr-checks", {
		description: "List the latest workflow runs of a PR and open one",
		handler: async (_args, ctx) => {
			const entry = await pickPr(ctx, "Checks for PR");
			if (!entry) return;
			const [url, pr] = entry;
			/** Non-zero is normal here: 8 means pending, 1 means a check failed. */
			const res = await pi
				.exec(
					"gh",
					[
						"pr",
						"checks",
						url,
						"--json",
						"name,state,bucket,link,workflow,description,startedAt,completedAt",
					],
					{ cwd: ctx.cwd, timeout: GH_TIMEOUT_MS },
				)
				.catch(() => undefined);
			const runs = checks(res?.stdout ?? "");
			if (runs.length === 0)
				return ctx.ui.notify(`No checks on #${pr.number}`, "info");
			const labels = runs.map((c) => checkLabel(c));
			const picked = await ctx.ui.select(`Checks #${pr.number}`, labels);
			const run = picked ? runs[labels.indexOf(picked)] : undefined;
			if (run?.link) await open(run.link);
		},
	});
}
