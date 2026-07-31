import type { TextChannel } from "discord.js";
import type { Player, Track, TrackStartEvent } from "lavalink-client";
import { env } from "../../env";
import { Event, type Lavamusic } from "../../structures/index";
import logger from "../../structures/Logger";
import { LavamusicEventType } from "../../types/events";
import { updateSetup } from "../../utils/SetupSystem";

export default class QueueEnd extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			type: LavamusicEventType.Player,
			name: "queueEnd",
		});
	}

	public async run(player: Player, _track: Track | null, _payload: TrackStartEvent): Promise<void> {
		const guild = this.client.guilds.cache.get(player.guildId);
		if (!guild) return;
		const locale = await this.client.db.getLanguage(player.guildId);
		await updateSetup(this.client, guild, locale);

		if (player.voiceChannelId) {
			await this.client.utils.setVoiceStatus(this.client, player.voiceChannelId, "");
		}

		const messageId = player.get<string | undefined>("messageId");
		const channel = guild.channels.cache.get(player.textChannelId!) as TextChannel;

		if (messageId && channel) {
			const message = await channel.messages.fetch(messageId).catch(() => null);
			if (message?.editable) {
				await message.edit({ components: [] }).catch(() => null);
			}
		}

		// Schedule auto-leave after LEAVE_TIMEOUT seconds (0 = leave immediately)
		const timeoutSecs = env.LEAVE_TIMEOUT;
		const delay = timeoutSecs * 1000;

		const leave = async (): Promise<void> => {
			// If someone queued a new track while we were waiting, abort
			if (player.queue.tracks.length > 0 || player.playing) return;

			try {
				if (channel && timeoutSecs > 0) {
					await channel
						.send({
							embeds: [
								this.client
									.embed()
									.setColor(this.client.color.main)
									.setDescription(`Left <#${player.voiceChannelId}> due to inactivity.`),
							],
						})
						.catch(() => null);
				}
				await player.destroy();
				logger.info(`[QueueEnd] Left voice channel in guild ${guild.id} after inactivity.`);
			} catch (err) {
				logger.error(`[QueueEnd] Failed to leave voice channel in guild ${guild.id}: ${err}`);
			}
		};

		if (delay <= 0) {
			await leave();
		} else {
			setTimeout(leave, delay);
		}
	}
}
