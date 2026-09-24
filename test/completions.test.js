/**
 * `/audio` menu tests — lock the trailing-space contract and the `--global`
 * prefix support added by the config-cascade work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AUDIO_DOCS, createAudioCompletions } from "../src/completions.js";
import { DEFAULTS } from "../src/config.js";

const complete = (prefix) => createAudioCompletions(() => DEFAULTS)(prefix) ?? [];

test("root completions include --global and the non-terminal rows keep their space", () => {
	const items = complete("");
	const values = items.map((i) => i.value);
	assert.ok(values.includes("--global "), "--global must be offered");
	assert.ok(values.includes("vader "), "vader is non-terminal");
	assert.ok(values.includes("voice "), "voice is non-terminal");
	assert.ok(values.includes("on"), "on is terminal");

	for (const name of ["on", "off", "stop", "status", "help"]) {
		assert.equal(
			items.find((i) => i.label === name)?.value,
			name,
			`${name} must be terminal`,
		);
	}
});

test("a fully typed non-terminal token already expands to its parameters", () => {
	assert.deepEqual(
		complete("backend").map((i) => i.value),
		["backend edge", "backend native"],
	);
	assert.deepEqual(
		complete("vader depth ").map((i) => i.value),
		[
			"vader depth auto",
			"vader depth -1",
			"vader depth -2",
			"vader depth -3",
			"vader depth -4",
		],
	);
});

test("the active voice carries ✓ in label and never in value", () => {
	const items = complete("voice ");
	const active = items.find((i) => i.value === `voice ${DEFAULTS.voice}`);
	assert.ok(active, `no row for the active voice ${DEFAULTS.voice}`);
	assert.equal(active.label.includes("✓"), true);
	assert.equal(/[✓●○]/.test(active.value), false);
	assert.equal(/\u001b/.test(active.value + active.label), false);
});

test("--global prefix preserves child completions", () => {
	const items = complete("--global ");
	assert.ok(items.length > 0);
	const values = items.map((i) => i.value);
	assert.ok(values.includes("--global vader "));
	assert.ok(values.includes("--global on"));
	assert.ok(!values.includes("--global --global "), "must not nest --global");

	const vaderItems = complete("--global vader ");
	const vaderValues = vaderItems.map((i) => i.value);
	assert.ok(vaderValues.includes("--global vader on"));
	assert.ok(vaderValues.includes("--global vader c3po"));

	const depthItems = complete("--global vader depth -3");
	const depthValues = depthItems.map((i) => i.value);
	assert.ok(depthValues.includes("--global vader depth -3"));
});

test("every documented subcommand is reachable from the first level", () => {
	const labels = complete("").map((i) => i.label);
	for (const key of Object.keys(AUDIO_DOCS)) {
		assert.ok(labels.includes(key), `${key} is not reachable`);
	}
});
