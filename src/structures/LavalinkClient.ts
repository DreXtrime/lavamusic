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

	constructor(client: Lavamusic) {
		super({
			nodes: client.env.NODES as LavalinkNodeOptions[],
			sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
			autoSkip: true,
			client: {
				id: client.env.CLIENT_ID,
				username: "LavaMusic",
			},
			queueOptions: {
				maxPreviousTracks: 25,
			},
			playerOptions: {
				defaultSearchPlatform: client.env.SEARCH_ENGINE,
				onDisconnect: {
					autoReconnect: true,
					destroyPlayer: false,
				},
				requesterTransformer: requesterTransformer,
				onEmptyQueue: {
					autoPlayFunction,
				},
			},
			autoMove: true,
		});
		this.client = client;

		this.nodeManager.on("connect", (node) => {
			logger.info(`[Lavalink] Node "${node.id}" connected.`);
		});

		this.nodeManager.on("reconnecting", (node) => {
			logger.info(`[Lavalink] Node "${node.id}" reconnecting…`);
		});

		this.nodeManager.on("disconnect", (node) => {
			logger.warn(`[Lavalink] Node "${node.id}" disconnected — will retry automatically.`);
		});

		// Catch errors at the node level so they never bubble up to an uncaught exception
		this.nodeManager.on("error", (node, err) => {
			const msg = err?.message ?? String(err);
			logger.error(`[Lavalink] Node "${node.id}" error: ${msg}`);
			// Do NOT re-throw — let the library handle its own reconnect
		});
	}

	/**
	 * Called from the Ready event. Connects all nodes and keeps them connected.
	 * The lavalink-client library handles reconnects automatically.
	 */
	public async initAndConnect(options: Parameters<LavalinkManager["init"]>[0]): Promise<void> {
		try {
			await super.init(options);
		} catch (err) {
			// init() itself can throw if a node times out — log and continue
			logger.error("[Lavalink] init() threw (node probably unreachable at startup):", err);
		}
		logger.info("[Lavalink] Manager initialised. Nodes will connect in the background.");
	}

	/** No-op — kept so ProcessHandlers shutdown call doesn't break. */
	public async disconnectAllNodes(): Promise<void> {}

	/** No-op — idle disconnect removed. */
	public resetIdleTimer(): void {}

	/** Returns true if at least one node is currently connected. */
	public hasConnectedNode(): boolean {
		for (const node of this.nodeManager.nodes.values()) {
			if (node.connected) return true;
		}
		return false;
	}

	/**
	 * Waits up to timeoutMs for at least one node to be ready.
	 * Returns true if a node became available, false if we timed out.
	 */
	public async waitForNode(timeoutMs = 10_000): Promise<boolean> {
		if (this.hasConnectedNode()) return true;

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

	/** Search for tracks, waiting briefly for a node if needed. */
	public async search(
		query: string | { query: string; source?: SearchPlatform },
		user: unknown,
		source?: SearchPlatform,
	): Promise<SearchResult> {
		const ready = await this.waitForNode(10_000);
		if (!ready) throw new Error("No Lavalink nodes are currently available.");
		const node = this.nodeManager.leastUsedNodes()[0];
		return await node.search(
			typeof query === "string" ? { query, source } : query,
			user,
			false,
		);
	}
}
