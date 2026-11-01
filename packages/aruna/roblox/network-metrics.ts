// Aruna roblox-ts native runtime — opt-in network metrics.
//
// `createNetworkMetrics()` collects what an app's traffic looks like: per action,
// how many calls, how many were refused and why, and how long the server took;
// per signal and resource, how much went out; per abuse reason, how often; and
// the frames the runtime built, with their estimated size. Hand it to
// `createServerApp({ metrics })` (and its `clientMiddleware()` to a client app),
// then read `report()` or print `formatNetworkReport(report)`.
//
// Three rules keep it safe to leave on:
//
//   * Off unless asked for. Without `metrics`, dispatch reads no clock for it,
//     and building a frame costs one nil check.
//   * Bounded. Every latency series keeps its last `samples` values in a ring;
//     every map stops growing at `maxKeys` and counts the rest as "(other)".
//   * No payloads. It records ids, error names, counts, durations, and sizes —
//     never an input, an output, a message, or a value.
//
// What it measures is labelled for what it is. Server dispatch time is server
// time, not a round trip; client latency (from the middleware) is the round
// trip a client saw, queueing included; bytes are estimates by Aruna's size
// accounting (docs/wire-protocol.md#size-accounting), not measured traffic.

import type { ClientMiddleware } from "./client-runtime";
import type { RequestAbuseInfo } from "./request-guard";
import type { ResourceObserver } from "./resource";
import type { DispatchObserver } from "./server-runtime";
import {
	currentWireFrameObserver,
	readWireFrame,
	setWireFrameObserver,
	WIRE_ITEM_CALL,
	WIRE_ITEM_RESOURCE,
	WIRE_ITEM_RESOURCE_SUBSCRIPTION,
	WIRE_ITEM_RESPONSE,
	WIRE_ITEM_SIGNAL,
	type WireFrame,
} from "./wire";

export interface NetworkMetricsOptions {
	// Values kept per latency series (default 256).
	readonly samples?: number;
	// Distinct ids kept per map before the rest count as "(other)" (default 256).
	readonly maxKeys?: number;
	// The clock the client middleware and the report window read, in
	// milliseconds. Defaults to os.clock().
	readonly nowMs?: () => number;
}

export interface LatencySummary {
	readonly samples: number;
	// Nearest-rank percentiles over the kept samples; absent with none.
	readonly p50?: number;
	readonly p95?: number;
	readonly p99?: number;
	readonly max?: number;
}

export interface ActionMetrics {
	// Dispatches that settled, from clients and in-process.
	readonly requests: number;
	readonly fromClient: number;
	readonly ok: number;
	readonly rejected: number;
	// Rejections by the error name the caller was sent.
	readonly rejections: { readonly [errorName: string]: number };
	// Server time, dispatch start to settle: not a round trip.
	readonly server: LatencySummary;
	// The part of server time before `run`: wire safety, defaults, validation.
	readonly checks: LatencySummary;
	// Round trips a client saw (from `clientMiddleware()`), queueing included.
	readonly client: LatencySummary;
}

export interface SignalMetrics {
	readonly items: number;
	readonly estimatedBytes: number;
}

export interface ResourceMetrics {
	readonly snapshots: number;
	// Snapshot items sent, one per subscriber per snapshot.
	readonly recipients: number;
	readonly estimatedBytes: number;
	readonly invalidations: number;
	readonly subscribes: number;
	readonly resyncs: number;
	readonly unsubscribes: number;
	readonly loadErrors: number;
	// Subscribers right now, when the app's host is bound.
	readonly subscribers?: number;
}

export interface WireMetrics {
	readonly frames: number;
	readonly items: {
		readonly calls: number;
		readonly responses: number;
		readonly signals: number;
		readonly resourceStates: number;
		readonly resourceSubscriptions: number;
	};
	// By Aruna's size accounting; a broadcast frame counts once.
	readonly estimatedBytes: number;
}

export interface NetworkMetricsReport {
	// Since creation or the last `reset()`.
	readonly windowMs: number;
	readonly actions: { readonly [actionId: string]: ActionMetrics };
	readonly signals: { readonly [signalId: string]: SignalMetrics };
	readonly resources: { readonly [resourceId: string]: ResourceMetrics };
	readonly abuse: { readonly [reason: string]: number };
	readonly wire: WireMetrics;
}

export interface NetworkMetrics {
	// For `createServerApp({ metrics })`, which wires these itself.
	readonly dispatchObserver: DispatchObserver<unknown>;
	readonly resourceObserver: ResourceObserver;
	readonly onAbuse: (player: unknown, info: RequestAbuseInfo) => void;
	readonly bindResources: (subscriberCount: (resourceId: string) => number) => void;
	// Starts counting the frames this Luau VM builds; returns the detach.
	readonly attachWire: () => () => void;
	// Client middleware that records each call's round trip.
	readonly clientMiddleware: () => ClientMiddleware;
	readonly report: () => NetworkMetricsReport;
	readonly reset: () => void;
}

const OTHER = "(other)";

// The size of a value by the accounting in docs/wire-protocol.md: 8 bytes per
// value Roblox encodes, plus every string's bytes (a table's string keys
// included; array indices are not values). An estimate: Roblox does not
// document its encoding.
export function estimateWireBytes(value: unknown): number {
	if (value === undefined) {
		return 0;
	}
	if (typeIs(value, "string")) {
		return 8 + value.size();
	}
	if (typeIs(value, "buffer")) {
		return 8 + buffer.len(value);
	}
	if (typeIs(value, "table")) {
		let size = 8;
		const list = value as ReadonlyArray<unknown>;
		const length = list.size();
		for (const [key, entry] of pairs(value as { [key: string]: unknown })) {
			if (typeIs(key, "number") && key >= 1 && key <= length && math.floor(key) === key) {
				size += estimateWireBytes(entry);
			} else if (typeIs(key, "string")) {
				size += 8 + key.size() + estimateWireBytes(entry);
			} else {
				size += 8 + estimateWireBytes(entry);
			}
		}
		return size;
	}
	if (typeIs(value, "Vector3") || typeIs(value, "Color3")) {
		return 8 + 12;
	}
	if (typeIs(value, "CFrame")) {
		return 8 + 48;
	}
	return 8;
}

class Ring {
	private readonly values = new Array<number>();
	private cursor = 0;
	public constructor(private readonly capacity: number) {}

	public add(value: number): void {
		if (this.values.size() < this.capacity) {
			this.values.push(value);
		} else {
			this.values[this.cursor] = value;
		}
		this.cursor = (this.cursor + 1) % this.capacity;
	}

	public summary(): LatencySummary {
		const count = this.values.size();
		if (count === 0) {
			return { samples: 0 };
		}
		const sorted = [...this.values];
		sorted.sort((left, right) => left < right);
		const rank = (fraction: number): number => sorted[math.clamp(math.ceil(fraction * count) - 1, 0, count - 1)]!;
		return { samples: count, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: sorted[count - 1]! };
	}
}

interface ActionSeries {
	requests: number;
	fromClient: number;
	ok: number;
	rejected: number;
	readonly rejections: Map<string, number>;
	readonly server: Ring;
	readonly checks: Ring;
	readonly client: Ring;
}

interface ResourceSeries {
	snapshots: number;
	recipients: number;
	estimatedBytes: number;
	invalidations: number;
	subscribes: number;
	resyncs: number;
	unsubscribes: number;
	loadErrors: number;
}

export function createNetworkMetrics(options?: NetworkMetricsOptions): NetworkMetrics {
	const capacity = math.max(1, options !== undefined && options.samples !== undefined ? options.samples : 256);
	const maxKeys = math.max(1, options !== undefined && options.maxKeys !== undefined ? options.maxKeys : 256);
	const readNow =
		options !== undefined && options.nowMs !== undefined ? options.nowMs : () => os.clock() * 1000;

	let startedAt = readNow();
	let actions = new Map<string, ActionSeries>();
	let signals = new Map<string, { items: number; estimatedBytes: number }>();
	let resources = new Map<string, ResourceSeries>();
	let abuse = new Map<string, number>();
	let frames = 0;
	let wireBytes = 0;
	let items = { calls: 0, responses: 0, signals: 0, resourceStates: 0, resourceSubscriptions: 0 };
	let subscriberCount: ((resourceId: string) => number) | undefined;

	// The entry for `key`, created while the map has room; past `maxKeys` every
	// new key shares the "(other)" entry.
	const entryOf = <T>(map: Map<string, T>, key: string, create: () => T): T => {
		let entry = map.get(key);
		if (entry !== undefined) {
			return entry;
		}
		const slot = map.size() < maxKeys ? key : OTHER;
		entry = map.get(slot);
		if (entry === undefined) {
			entry = create();
			map.set(slot, entry);
		}
		return entry;
	};

	const actionOf = (actionId: string): ActionSeries =>
		entryOf(actions, actionId, () => ({
			requests: 0,
			fromClient: 0,
			ok: 0,
			rejected: 0,
			rejections: new Map<string, number>(),
			server: new Ring(capacity),
			checks: new Ring(capacity),
			client: new Ring(capacity),
		}));

	const resourceOf = (resourceId: string): ResourceSeries =>
		entryOf(resources, resourceId, () => ({
			snapshots: 0,
			recipients: 0,
			estimatedBytes: 0,
			invalidations: 0,
			subscribes: 0,
			resyncs: 0,
			unsubscribes: 0,
			loadErrors: 0,
		}));

	const bump = (map: Map<string, number>, key: string): void => {
		const slot = map.has(key) || map.size() < maxKeys ? key : OTHER;
		map.set(slot, (map.get(slot) ?? 0) + 1);
	};

	const observeFrame = (frame: WireFrame): void => {
		const read = readWireFrame(frame);
		if (!read.ok) {
			return;
		}
		frames += 1;
		wireBytes += estimateWireBytes(frame);
		for (const item of read.items) {
			const kind = (item as { readonly t?: unknown }).t;
			if (kind === WIRE_ITEM_CALL) {
				items.calls += 1;
			} else if (kind === WIRE_ITEM_RESPONSE) {
				items.responses += 1;
			} else if (kind === WIRE_ITEM_SIGNAL) {
				items.signals += 1;
				const signalId = (item as { readonly s?: unknown }).s;
				if (typeIs(signalId, "string")) {
					const entry = entryOf(signals, signalId, () => ({ items: 0, estimatedBytes: 0 }));
					entry.items += 1;
					entry.estimatedBytes += estimateWireBytes(item);
				}
			} else if (kind === WIRE_ITEM_RESOURCE) {
				items.resourceStates += 1;
				const resourceId = (item as { readonly r?: unknown }).r;
				if (typeIs(resourceId, "string")) {
					resourceOf(resourceId).estimatedBytes += estimateWireBytes(item);
				}
			} else if (kind === WIRE_ITEM_RESOURCE_SUBSCRIPTION) {
				items.resourceSubscriptions += 1;
			}
		}
	};

	const toObject = <T, U>(map: Map<string, T>, convert: (value: T) => U): { [key: string]: U } => {
		const result: { [key: string]: U } = {};
		for (const [key, value] of map) {
			result[key] = convert(value);
		}
		return result;
	};

	return {
		dispatchObserver: {
			onSettled: (info) => {
				const series = actionOf(info.actionId);
				series.requests += 1;
				if (info.fromClient) {
					series.fromClient += 1;
				}
				if (info.ok) {
					series.ok += 1;
				} else {
					series.rejected += 1;
					bump(series.rejections, info.errorName !== undefined ? info.errorName : "unknown");
				}
				series.server.add(info.durationMs);
				if (info.checkMs !== undefined) {
					series.checks.add(info.checkMs);
				}
			},
		},
		resourceObserver: {
			onSnapshot: (resourceId, recipients) => {
				const series = resourceOf(resourceId);
				series.snapshots += 1;
				series.recipients += recipients;
			},
			onInvalidate: (resourceId) => {
				resourceOf(resourceId).invalidations += 1;
			},
			onSubscribe: (resourceId, resync) => {
				const series = resourceOf(resourceId);
				if (resync) {
					series.resyncs += 1;
				} else {
					series.subscribes += 1;
				}
			},
			onUnsubscribe: (resourceId) => {
				resourceOf(resourceId).unsubscribes += 1;
			},
			onLoadError: (resourceId) => {
				resourceOf(resourceId).loadErrors += 1;
			},
		},
		onAbuse: (_player, info) => {
			bump(abuse, info.reason);
		},
		bindResources: (count) => {
			subscriberCount = count;
		},
		// The last collector attached wins; detaching one that was replaced leaves
		// its replacement alone.
		attachWire: () => {
			setWireFrameObserver(observeFrame);
			return () => {
				if (currentWireFrameObserver() === observeFrame) {
					setWireFrameObserver(undefined);
				}
			};
		},
		clientMiddleware: () => (info, nextLayer) => {
			const started = readNow();
			const record = (): void => {
				actionOf(info.actionId).client.add(readNow() - started);
			};
			return nextLayer().then(
				(value) => {
					record();
					return value;
				},
				(rejection) => {
					record();
					return Promise.reject(rejection);
				},
			);
		},
		report: () => ({
			windowMs: readNow() - startedAt,
			actions: toObject(actions, (series) => ({
				requests: series.requests,
				fromClient: series.fromClient,
				ok: series.ok,
				rejected: series.rejected,
				rejections: toObject(series.rejections, (count) => count),
				server: series.server.summary(),
				checks: series.checks.summary(),
				client: series.client.summary(),
			})),
			signals: toObject(signals, (series) => ({ items: series.items, estimatedBytes: series.estimatedBytes })),
			resources: (() => {
				const result: { [resourceId: string]: ResourceMetrics } = {};
				for (const [resourceId, series] of resources) {
					let subscribers: number | undefined;
					if (subscriberCount !== undefined && resourceId !== OTHER) {
						const [counted, value] = pcall(() => subscriberCount!(resourceId));
						subscribers = counted ? value : undefined;
					}
					result[resourceId] = {
						snapshots: series.snapshots,
						recipients: series.recipients,
						estimatedBytes: series.estimatedBytes,
						invalidations: series.invalidations,
						subscribes: series.subscribes,
						resyncs: series.resyncs,
						unsubscribes: series.unsubscribes,
						loadErrors: series.loadErrors,
						...(subscribers !== undefined ? { subscribers } : {}),
					};
				}
				return result;
			})(),
			abuse: toObject(abuse, (count) => count),
			wire: { frames, items: { ...items }, estimatedBytes: wireBytes },
		}),
		reset: () => {
			startedAt = readNow();
			actions = new Map();
			signals = new Map();
			resources = new Map();
			abuse = new Map();
			frames = 0;
			wireBytes = 0;
			items = { calls: 0, responses: 0, signals: 0, resourceStates: 0, resourceSubscriptions: 0 };
		},
	};
}

function formatMs(value: number | undefined): string {
	return value === undefined ? "-" : `${string.format("%.1f", value)}ms`;
}

function formatBytes(value: number): string {
	return value >= 1024 ? `${string.format("%.1f", value / 1024)} KB` : `${value} B`;
}

function sortedKeys(record: { readonly [key: string]: unknown }): Array<string> {
	const keys = new Array<string>();
	for (const [key] of pairs(record as { [key: string]: unknown })) {
		keys.push(key as string);
	}
	keys.sort();
	return keys;
}

function percentiles(label: string, summary: LatencySummary): string {
	if (summary.samples === 0) {
		return `${label}: no samples`;
	}
	const tail =
		summary.samples >= 20
			? `P50 ${formatMs(summary.p50)}, P95 ${formatMs(summary.p95)}, max ${formatMs(summary.max)}`
			: `P50 ${formatMs(summary.p50)}, max ${formatMs(summary.max)} (too few samples for P95)`;
	return `${label}: ${tail} over ${summary.samples}`;
}

// A human-readable report: what a development server prints on a command, or a
// spec dumps when an assertion fails.
export function formatNetworkReport(report: NetworkMetricsReport): string {
	const lines = new Array<string>();
	lines.push("Aruna Network Diagnostics");
	lines.push(`  window: ${string.format("%.1f", report.windowMs / 1000)}s; sizes are estimates, not measured traffic`);
	for (const actionId of sortedKeys(report.actions)) {
		const action = report.actions[actionId]!;
		const perSecond = report.windowMs > 0 ? (action.requests * 1000) / report.windowMs : 0;
		lines.push("");
		lines.push(`Action: ${actionId}`);
		lines.push(`  Requests:       ${action.requests} (${action.fromClient} from clients, ${string.format("%.1f", perSecond)}/s)`);
		lines.push(`  Rejected:       ${action.rejected}`);
		for (const name of sortedKeys(action.rejections)) {
			lines.push(`    ${name}: ${action.rejections[name]}`);
		}
		lines.push(`  ${percentiles("Server time", action.server)}`);
		lines.push(`  ${percentiles("Checks before run", action.checks)}`);
		lines.push(`  ${percentiles("Client round trip", action.client)}`);
	}
	for (const signalId of sortedKeys(report.signals)) {
		const signal = report.signals[signalId]!;
		lines.push("");
		lines.push(`Signal: ${signalId}`);
		lines.push(`  Items:          ${signal.items}`);
		lines.push(`  Est. bytes:     ${formatBytes(signal.estimatedBytes)}`);
	}
	for (const resourceId of sortedKeys(report.resources)) {
		const resource = report.resources[resourceId]!;
		lines.push("");
		lines.push(`Resource: ${resourceId}`);
		if (resource.subscribers !== undefined) {
			lines.push(`  Subscribers:    ${resource.subscribers}`);
		}
		lines.push(`  Snapshots:      ${resource.snapshots} (${resource.recipients} sent)`);
		lines.push(`  Invalidations:  ${resource.invalidations}`);
		lines.push(`  Resyncs:        ${resource.resyncs}`);
		lines.push(`  Load errors:    ${resource.loadErrors}`);
		lines.push(`  Est. bytes:     ${formatBytes(resource.estimatedBytes)}`);
	}
	const reasons = sortedKeys(report.abuse);
	if (reasons.size() > 0) {
		lines.push("");
		lines.push("Refused before dispatch:");
		for (const reason of reasons) {
			lines.push(`  ${reason}: ${report.abuse[reason]}`);
		}
	}
	lines.push("");
	lines.push(
		`Wire: ${report.wire.frames} frames, ${report.wire.items.calls} calls, ${report.wire.items.responses} responses, ${report.wire.items.signals} signals, ${report.wire.items.resourceStates} resource states; est. ${formatBytes(report.wire.estimatedBytes)}`,
	);
	return lines.join("\n");
}
