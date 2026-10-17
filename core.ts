/** Pure helpers, kept free of pi imports so test.ts can run under tsx. */
export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const MAX_SHOWN = 5;

export type State = "OPEN" | "MERGED" | "CLOSED";

export interface Pr {
	number: number;
	title: string;
	state: State;
}

/** url -> pr */
export type Prs = Map<string, Pr>;

/** Display order: open work first, then landed, then abandoned. */
export const STATES: State[] = ["OPEN", "MERGED", "CLOSED"];
export type Color = "success" | "accent" | "error";
export const STYLE: Record<State, { icon: string; color: Color }> = {
	OPEN: { icon: "●", color: "success" },
	MERGED: { icon: "✔", color: "accent" },
	CLOSED: { icon: "✕", color: "error" },
};

/** One row of `gh pr checks --json ...` — a workflow job on the PR's head commit. */
export interface Check {
	name: string;
	state: string;
	bucket: string;
	link: string;
	workflow?: string;
	description?: string;
	startedAt?: string;
	completedAt?: string;
}

/** Failures first: that is the only reason anyone opens this picker. */
const BUCKETS = ["fail", "pending", "pass", "cancel", "skipping"];
const BUCKET_ICON: Record<string, string> = {
	fail: "✕",
	pending: "●",
	pass: "✔",
	cancel: "⊘",
	skipping: "○",
};

function duration(from?: string, to?: string): string {
	const start = from ? Date.parse(from) : Number.NaN;
	const end = to ? Date.parse(to) : Number.NaN;
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
	const s = Math.round((end - start) / 1000);
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Sorted so the picker reads top-down: broken, running, then the boring ones. */
export function checks(stdout: string): Check[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return (parsed as Check[])
		.filter((c) => c?.name)
		.sort(
			(a, b) =>
				BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) ||
				a.name.localeCompare(b.name),
		);
}

/** Everything worth knowing before pressing enter: outcome, job, workflow, time, error. */
export function checkLabel(c: Check, now: number = Date.now()): string {
	const icon = BUCKET_ICON[c.bucket] ?? "·";
	const workflow =
		c.workflow && c.workflow !== c.name ? ` (${c.workflow})` : "";
	const took =
		duration(c.startedAt, c.completedAt) ||
		(c.bucket === "pending"
			? duration(c.startedAt, new Date(now).toISOString())
			: "");
	const state = c.state ? c.state.toLowerCase() : c.bucket;
	const tail = [state, took, c.description].filter(Boolean).join(" · ");
	return `${icon} ${c.name}${workflow} — ${tail}`;
}

export function candidates(text: string): string[] {
	return [...new Set(text.match(PR_URL) ?? [])];
}

/** Persisted-snapshot entry (session JSONL `custom` line written through
 * `pi.appendEntry`); the constant doubles as the fast-scan prescreen needle. */
export const STATE_ENTRY = "omp-session-prs.state";

/** The package's earlier name; sessions recorded before the rename keep
 * snapshot entries under this key, so reads recognise both while writes use
 * only STATE_ENTRY. */
const LEGACY_STATE_ENTRY = "pi-session-prs.state";

/** Newest tracked-PR snapshot in a session transcript, so a resumed process
 * rebuilds the footer without `gh`. Snapshots are cumulative (the whole Map
 * each time), so the newest valid one wins. Unlike the fresh-session paths —
 * transcript URLs need `gh pr view`, the branch needs `gh pr list` — a
 * snapshot also survives worktree/branch deletion.
 *
 * Performance: long transcripts are thousands of JSONL lines; a per-line
 * `JSON.parse` would dominate. The `includes` prescreen leaves only the
 * snapshot lines, parsed newest-first, stopping at the first valid one. */
export function stateSnapshot(text: string): [string, Pr][] {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (
			!lines[i].includes(STATE_ENTRY) &&
			!lines[i].includes(LEGACY_STATE_ENTRY)
		) {
			continue;
		}
		const snapshot = parseSnapshotLine(lines[i]);
		if (snapshot !== undefined) return snapshot;
	}
	return [];
}

/** `undefined` = not a snapshot line (or one whose write was torn — a bad
 * member invalidates the whole entry), so the caller falls through to the
 * next-older snapshot instead of half-restoring. */
function parseSnapshotLine(line: string): [string, Pr][] | undefined {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (
		typeof entry !== "object" ||
		entry === null ||
		!("type" in entry) ||
		!("customType" in entry) ||
		!("data" in entry) ||
		entry.type !== "custom" ||
		(entry.customType !== STATE_ENTRY &&
			entry.customType !== LEGACY_STATE_ENTRY) ||
		!Array.isArray(entry.data)
	) {
		return undefined;
	}
	return validPairs(entry.data);
}

/** Snapshot shape: [url, pr][]. */
function validPairs(data: unknown[]): [string, Pr][] | undefined {
	const prs: [string, Pr][] = [];
	for (const item of data) {
		if (
			!Array.isArray(item) ||
			item.length !== 2 ||
			typeof item[0] !== "string"
		) {
			return undefined;
		}
		const pr = item[1];
		if (
			typeof pr !== "object" ||
			pr === null ||
			!("number" in pr) ||
			typeof pr.number !== "number" ||
			!("title" in pr) ||
			typeof pr.title !== "string" ||
			!("state" in pr) ||
			typeof pr.state !== "string" ||
			!(pr.state in STYLE)
		) {
			return undefined;
		}
		prs.push([
			item[0],
			{ number: pr.number, title: pr.title, state: pr.state },
		]);
	}
	return prs;
}

export function sorted(prs: Prs): [string, Pr][] {
	return [...prs].sort(
		(a, b) =>
			STATES.indexOf(a[1].state) - STATES.indexOf(b[1].state) ||
			a[1].number - b[1].number,
	);
}

export function format(
	prs: Prs,
	link: (text: string, url: string) => string,
	paint: (color: Color, text: string) => string = (_c, t) => t,
): string | undefined {
	if (prs.size === 0) return undefined;
	const all = sorted(prs);
	const shown = all.slice(0, MAX_SHOWN);
	const rest = all.length - shown.length;

	const groups = STATES.map((state) => {
		const members = shown.filter(([, pr]) => pr.state === state);
		if (members.length === 0) return "";
		const links = members
			.map(([url, pr]) => link(`#${pr.number}`, url))
			.join(" ");
		return paint(STYLE[state].color, `${STYLE[state].icon} ${links}`);
	}).filter(Boolean);

	return `PR ${groups.join(" ")}${rest > 0 ? ` +${rest}` : ""}`;
}
