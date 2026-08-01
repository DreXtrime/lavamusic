import { ChannelType, PermissionFlagsBits, type VoiceState } from "discord.js";
import { Event, type Lavamusic } from "../../structures/index";
import logger from "../../structures/Logger";
import { LavamusicEventType } from "../../types/events";

export default class VoiceStateUpdate extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			type: LavamusicEventType.Client,
			name: "voiceStateUpdate",
		});
	}

	private delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

	public async run(oldState: VoiceState, newState: VoiceState): Promise<void> {
		const guildId = newState.guild.id;
		if (!guildId) return;

		try {
			if (newState.id === this.client.user!.id) {
				await this.handleBotStateChange(oldState, newState);
			}

			// Stage channel suppress handling
			const botState = newState.guild.voiceStates.cache.get(this.client.user!.id);
			if (
				botState?.channelId &&
				botState.channel?.type === ChannelType.GuildStageVoice &&
				botState.suppress &&
				botState.channel &&
				botState.member &&
				botState.channel.permissionsFor(botState.member).has(PermissionFlagsBits.MuteMembers)
			) {
				await this.delay(3000);
				await botState.setSuppressed(false).catch((err) =>
					logger.warn("[VoiceStateUpdate] setSuppressed(false) failed:", err),
				);
			}
		} catch (err) {
			logger.error("[VoiceStateUpdate] handler error:", err);
		}
	}

	private async handleBotStateChange(oldState: VoiceState, newState: VoiceState): Promise<void> {
		const guildId = newState.guild.id;
		const player = this.client.manager.getPlayer(guildId);

		// Server mute/unmute — pause or resume playback
		if (newState.serverMute !== oldState.serverMute && player) {
			try {
				if (newState.serverMute && !player.paused) {
					await player.pause();
				} else if (!newState.serverMute && player.paused) {
					await player.resume();
				}
			} catch (err) {
				logger.warn("[VoiceStateUpdate] pause/resume on serverMute failed:", err);
			}
		}

		// Bot was kicked from voice
		if (oldState.channelId && !newState.channelId) {
			logger.info(`[VoiceStateUpdate] Bot was removed from voice in guild ${guildId}.`);
			this.client.manager.cancelIdleTimer(guildId);
			this.client.manager.voiceStates.delete(guildId);

			if (player) {
				try {
					await player.destroy();
				} catch (err) {
					logger.warn("[VoiceStateUpdate] destroy() after bot kick failed:", err);
				}
			}
		}
	}
}
