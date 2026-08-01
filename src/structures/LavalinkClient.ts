import {
	LavalinkManager,
	type LavalinkNodeOptions,
	type SearchPlatform,
	type SearchResult,
} from "lavalink-client";
import { autoPlayFunction, requesterTransformer } from "../utils/functions/player";
import type Lavamusic from "./Lavamusic";
import logger from "./Logger";

export default class LavalinkClient extends LavalinkManager {
	public client: Lavamusic;

	/**
	 * Tracks which voice/text channel the bot is sitting in per guild.
	 * This is independent of whether a Lavalink player exists — the bot
	 * can be in a channel with no player (after idle timeout).
	 */
	public voiceStates = new Map<string, {
		voiceChannelId: string;
		textChannelId: string;
		idleTimer: ReturnType<typeof setTimeout> | null;
	}>();

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

		this.nodeManager.on("connect", (node) => logger.info(`[Lavalink] Node "${node.id}" connected.`));
		this.nodeManager.on("reconnecting", (node) => logger.info(`[Lavalink] Node "${node.id}" reconnecting…`));
		this.nodeManager.on("disconnect", (node) => logger.warn(`[Lavalink] Node "${node.id}" disconnected — retrying automatically.`));
		this.nodeManager.on("error", (node, err) => logger.error(`[Lavalink] Node "${node.id}" error: ${err?.message ?? String(err)}`));
	}

	public async initAndConnect(options: Parameters<LavalinkManager["init"]>[0]): Promise<void> {
		try {
			await super.init(options);
		} catch (err) {
			logger.error("[Lavalink] init() threw (node probably unreachable at startup):", err);
		}
		logger.info("[Lavalink] Manager initialised.");
	}

	public hasConnectedNode(): boolean {
		for (const node of this.nodeManager.nodes.values()) {
			if (node.connected) return true;
		}
		return false;
	}

	/**
	 * Waits up to timeoutMs for a node. Actively triggers reconnects if none are up.
	 */
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
	 * Schedules destruction of just the Lavalink player after timeoutSecs.
	 * The bot stays in the voice channel. Cancels any existing timer first.
	 */
	public scheduleIdleDestroy(guildId: string, timeoutSecs: number): void {
		const state = this.voiceStates.get(guildId);
		if (!state) return;

		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}

		const run = async () => {
			const player = this.getPlayer(guildId);
			if (!player) return;
			// Abort if playback resumed during the wait
			if (player.playing || player.paused || player.queue.tracks.length > 0) return;
			try {
				// destroy() with false keeps the bot in voice
				await player.destroy(false as any);
				logger.info(`[Lavalink] Player destroyed for guild ${guildId} (idle). Bot stays in voice.`);
			} catch (err) {
				logger.warn(`[Lavalink] Player destroy failed for guild ${guildId}: ${err}`);
			}
		};

		if (timeoutSecs <= 0) {
			run();
		} else {
			state.idleTimer = setTimeout(run, timeoutSecs * 1000);
		}
	}

	/** Cancel a pending idle-destroy timer. Call this when playback resumes. */
	public cancelIdleTimer(guildId: string): void {
		const state = this.voiceStates.get(guildId);
		if (state?.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
	}

	/** Search for tracks, waiting briefly for a node if needed. */
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

	/** No-op stubs kept for compatibility with ProcessHandlers */
	public async disconnectAllNodes(): Promise<void> {}
	public resetIdleTimer(): void {}
}
