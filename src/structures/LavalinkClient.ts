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
	 * Tracks which voice/text channel the bot is sitting in per guild,
	 * independently of whether a Lavalink player exists.
	 */
	public voiceStates = new Map<string, {
		voiceChannelId: string;
		textChannelId: string;
		idleTimer: ReturnType<typeof setTimeout> | null;
	}>();

	/**
	 * Guild IDs where we are in the middle of an intentional idle destroy.
	 * VoiceStateUpdate checks this to avoid treating the resulting disconnect
	 * event as an external kick.
	 */
	public intentionalDestroy = new Set<string>();

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
	 * Sends a raw Discord gateway op 4 (voice state update) to make the bot
	 * join or stay in a voice channel, bypassing lavalink-client entirely.
	 * This is how we keep the bot in voice after destroying a player.
	 */
	private sendVoiceConnect(guildId: string, channelId: string): void {
		const guild = this.client.guilds.cache.get(guildId);
		if (!guild) return;
		guild.shard.send({
			op: 4,
			d: {
				guild_id: guildId,
				channel_id: channelId,
				self_mute: false,
				self_deaf: true,
			},
		});
	}

	/**
	 * Schedules Lavalink player destruction after timeoutSecs.
	 * After destroying, immediately re-sends the voice connect op so the bot
	 * stays in the channel at the Discord gateway level.
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
			if (player.playing || player.paused || player.queue.tracks.length > 0) return;

			const { voiceChannelId } = state;
			logger.info(`[Lavalink] Idle timeout for guild ${guildId} — destroying player.`);

			this.intentionalDestroy.add(guildId);
			try {
				await player.destroy();
			} catch (err) {
				logger.warn(`[Lavalink] Player destroy failed for guild ${guildId}: ${err}`);
			}

			// Re-join the voice channel via raw gateway op so the bot stays put.
			// lavalink-client sends op 4 with channel_id: null during destroy,
			// so we immediately override that with a rejoin.
			this.sendVoiceConnect(guildId, voiceChannelId);
			logger.info(`[Lavalink] Guild ${guildId}: player released, bot staying in <#${voiceChannelId}>.`);

			setTimeout(() => this.intentionalDestroy.delete(guildId), 5000);
		};

		if (timeoutSecs <= 0) {
			run();
		} else {
			state.idleTimer = setTimeout(run, timeoutSecs * 1000);
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
