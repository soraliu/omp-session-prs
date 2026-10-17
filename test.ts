import assert from "node:assert/strict";
import test from "node:test";

import {
	candidates,
	checkLabel,
	checks,
	format,
	type Prs,
	STATE_ENTRY,
	type State,
	snapshotFromEntries,
	urlsFromEntries,
} from "./core.ts";

const url = (n: number) =>
	`https://github.com/ExodusMovement/qa-agents/pull/${n}`;
const plain = (t: string) => t;

function make(entries: [number, State][]): Prs {
	const prs: Prs = new Map();
	for (const [n, state] of entries)
		prs.set(url(n), { number: n, title: `pr ${n}`, state });
	return prs;
}

test("checks sorts failures first, then running, and survives junk", () => {
	const json = JSON.stringify([
		{ name: "lint", bucket: "pass" },
		{ name: "e2e", bucket: "pending" },
		{ name: "build", bucket: "fail" },
		{ name: "docs", bucket: "skipping" },
		{ bucket: "fail" },
	]);
	assert.deepEqual(
		checks(json).map((c) => c.name),
		["build", "e2e", "lint", "docs"],
	);
	assert.deepEqual(checks("not json"), []);
});

test("checkLabel shows outcome, workflow, duration and failure reason", () => {
	assert.equal(
		checkLabel({
			name: "build",
			workflow: "CI",
			bucket: "fail",
			state: "FAILURE",
			link: "https://github.com/o/r/actions/runs/1",
			description: "exit code 1",
			startedAt: "2024-01-01T00:00:00Z",
			completedAt: "2024-01-01T00:01:12Z",
		}),
		"✕ build (CI) — failure · 1m12s · exit code 1",
	);
});

test("checkLabel times a running check against now", () => {
	assert.equal(
		checkLabel(
			{
				name: "e2e",
				workflow: "e2e",
				bucket: "pending",
				state: "IN_PROGRESS",
				link: "https://github.com/o/r/actions/runs/2",
				startedAt: "2024-01-01T00:00:00Z",
			},
			Date.parse("2024-01-01T00:00:30Z"),
		),
		"● e2e — in_progress · 30s",
	);
});

test("candidates dedupes pull urls and ignores other paths", () => {
	assert.deepEqual(candidates(`opened ${url(604)} and ${url(604)} again`), [
		url(604),
	]);
	assert.deepEqual(
		candidates("https://github.com/o/r/issues/5 nothing here"),
		[],
	);
});

test("format returns undefined when there is nothing to show", () => {
	assert.equal(format(new Map(), plain), undefined);
});

test("format groups by state, open first, ascending inside a group", () => {
	const prs = make([
		[590, "CLOSED"],
		[598, "MERGED"],
		[612, "OPEN"],
		[604, "OPEN"],
	]);
	assert.equal(format(prs, plain), "PR ● #604 #612 ✔ #598 ✕ #590");
});

test("format drops the least interesting states on overflow and counts the rest", () => {
	const prs = make([
		[590, "CLOSED"],
		[598, "MERGED"],
		[612, "OPEN"],
		[604, "OPEN"],
		[700, "CLOSED"],
		[701, "CLOSED"],
	]);
	assert.equal(format(prs, plain), "PR ● #604 #612 ✔ #598 ✕ #590 #700 +1");
});

test("paint wraps each state group, never the whole line", () => {
	const prs = make([
		[590, "CLOSED"],
		[598, "MERGED"],
		[604, "OPEN"],
	]);
	assert.equal(
		format(prs, plain, (color, t) => `<${color}>${t}</>`),
		"PR <success>● #604</> <accent>✔ #598</> <error>✕ #590</>",
	);
});

test("snapshotFromEntries restores the newest snapshot and skips junk", () => {
	const snapshotEntry = (data: unknown, key = STATE_ENTRY) => ({
		type: "custom",
		customType: key,
		data,
	});
	const entries: unknown[] = [
		{ type: "session", version: 3, id: "x" },
		snapshotEntry([...make([[604, "CLOSED"]])]), // older snapshot
		{ type: "message" },
		snapshotEntry([
			...make([
				[612, "OPEN"],
				[598, "MERGED"],
			]),
		]),
		snapshotEntry("torn write"), // non-array data: fall to the older snapshot
	];
	assert.deepEqual(snapshotFromEntries(entries), [
		[url(612), { number: 612, title: "pr 612", state: "OPEN" }],
		[url(598), { number: 598, title: "pr 598", state: "MERGED" }],
	]);
	// No snapshot, or a member with a bad shape: start empty / fall through to
	// the next-older snapshot instead of half-restoring.
	assert.deepEqual(snapshotFromEntries([]), []);
	assert.deepEqual(
		snapshotFromEntries([
			snapshotEntry([["url", { number: 1, title: "t", state: "DRAFT" }]]),
		]),
		[],
	);
	assert.deepEqual(snapshotFromEntries([snapshotEntry([])]), []);
	// Sessions recorded before the package rename keep snapshots under the
	// legacy key; reads recognise them and the newest wins across both keys.
	const legacyKey = "pi-session-prs.state";
	assert.deepEqual(
		snapshotFromEntries([
			snapshotEntry([...make([[598, "MERGED"]])], legacyKey),
		]),
		[[url(598), { number: 598, title: "pr 598", state: "MERGED" }]],
	);
	assert.deepEqual(
		snapshotFromEntries([
			snapshotEntry([...make([[604, "OPEN"]])], legacyKey),
			snapshotEntry([...make([[612, "CLOSED"]])]),
		]),
		[[url(612), { number: 612, title: "pr 612", state: "CLOSED" }]],
	);
});

test("urlsFromEntries collects pull urls from message text blocks", () => {
	const message = (...blocks: unknown[]) => ({
		type: "message",
		message: { role: "assistant", content: blocks },
	});
	const entries: unknown[] = [
		{ type: "session", version: 3 },
		message({ type: "text", text: `opened ${url(604)} and ${url(604)} again` }),
		{ type: "custom", customType: "unrelated", data: url(700) },
		message({ type: "image", data: "…" }),
		message(
			{ type: "text", text: "no urls here" },
			{ type: "text", text: `then ${url(612)}` },
		),
	];
	assert.deepEqual(urlsFromEntries(entries), [url(604), url(612)]);
	assert.deepEqual(urlsFromEntries([]), []);
});
