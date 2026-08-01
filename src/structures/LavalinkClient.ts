import {
	LavalinkManager,
	type LavalinkNodeOptions,
	type SearchPlatform,
	type SearchResult,
} from "lavalink-client";
import { autoPlayFunction, requesterTransformer } from "../utils/functions/player";
import type Lavamusic from "./Lavamusic";
import logger from "./Logger";

/** How often to ping idle nodes to keep sessions alive (ms). */
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export default class LavalinkClient extends LavalinkManager {
	public client: Lavamusic;

	/**
	 * Tracks which voice/text channel the bot is sitting in per guild,
	 * independently of whether a Lavalink player exists.
	 */
	public voiceStates = new Map<string, {
		voiceChannelId: string;
		textChannelId: string;
		idleTimer: ReturnType<typeof setTimeout> | null;
	}>();

	public intentionalDestroy = new Set<string>();

	private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

	constructor(client: Lavamusic) {
		super({
			nodes: client.env.NODES as LavalinkNodeOptions[],
			sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
			autoSkip: true,
			client: { id: client.env.CLIENT_ID, username: "LavaMusic" },
			queueOptions: { maxPreviousTracks: 25 },
			playerOptions: {
				defaultSearchPlatform: client.env.SEARCH_ENGINE,
				onDisconnect: { autoReconnect: true, destroyPlayer: false },
				requesterTransformer: requesterTransformer,
				onEmptyQueue: { autoPlayFunction },
			},
			autoMove: true,
		});
		this.client = client;

		this.nodeManager.on("connect", (node) =>
			logger.info(`[Lavalink] Node "${node.id}" connected.`));
		this.nodeManager.on("reconnecting", (node) =>
			logger.info(`[Lavalink] Node "${node.id}" reconnecting…`));
		this.nodeManager.on("disconnect", (node) =>
			logger.warn(`[Lavalink] Node "${node.id}" disconnected — retrying automatically.`));
		this.nodeManager.on("error", (node, err) =>
			logger.error(`[Lavalink] Node "${node.id}" error: ${err?.message ?? String(err)}`));
	}

	public async initAndConnect(options: Parameters<LavalinkManager["init"]>[0]): Promise<void> {
		try {
			await super.init(options);
		} catch (err) {
			logger.error("[Lavalink] init() threw (node probably unreachable at startup):", err);
		}
		logger.info("[Lavalink] Manager initialised.");
		this._startKeepalive();
	}

	/**
	 * Pings every connected node every 3 minutes to keep sessions alive.
	 * Uses the node's built-in stats fetch which is a lightweight GET request.
	 * If a node is dead the ping fails silently — the library's own reconnect handles it.
	 */
	private _startKeepalive(): void {
		if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);

		this._keepaliveTimer = setInterval(async () => {
			for (const node of this.nodeManager.nodes.values()) {
				if (!node.connected) continue;
				try {
					await node.fetchStats();
				} catch {
					// Node is unresponsive — library will handle reconnect
				}
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	public hasConnectedNode(): boolean {
		for (const node of this.nodeManager.nodes.values()) {
			if (node.connected) return true;
		}
		return false;
	}

	public async waitForNode(timeoutMs = 15_000): Promise<boolean> {
		if (this.hasConnectedNode()) return true;

		for (const node of this.nodeManager.nodes.values()) {
			if (!node.connected) {
				node.connect().catch((err: Error) =>
					logger.warn(`[Lavalink] Node "${node.id}" reconnect attempt failed: ${err?.message}`),
				);
			}
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.nodeManager.off("connect", onConnect);
				resolve(false);
			}, timeoutMs);

			const onConnect = () => {
				clearTimeout(timer);
				this.nodeManager.off("connect", onConnect);
				resolve(true);
			};

			this.nodeManager.on("connect", onConnect);
		});
	}

	/**
	 * Called when the queue ends or /stop is used.
	 * Just stops playback — does NOT destroy the player or disconnect from voice.
	 * The keepalive ping keeps the Lavalink session alive while idle.
	 */
	public scheduleIdleDestroy(guildId: string, _timeoutSecs: number): void {
		// No-op: we no longer destroy idle players.
		// The player sits in voice doing nothing, keepalive prevents session timeout.
		const state = this.voiceStates.get(guildId);
		if (state?.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
	}

	public cancelIdleTimer(guildId: string): void {
		const state = this.voiceStates.get(guildId);
		if (state?.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
	}

	public async search(
		query: string | { query: string; source?: SearchPlatform },
		user: unknown,
		source?: SearchPlatform,
	): Promise<SearchResult> {
		const ready = await this.waitForNode();
		if (!ready) throw new Error("No Lavalink nodes are currently available.");
		const node = this.nodeManager.leastUsedNodes()[0];
		return await node.search(
			typeof query === "string" ? { query, source } : query,
			user,
			false,
		);
	}

	public async disconnectAllNodes(): Promise<void> {}
	public resetIdleTimer(): void {}
}
