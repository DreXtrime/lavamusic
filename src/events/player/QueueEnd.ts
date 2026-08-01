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
			await this.client.utils.setVoiceStatus(this.client, player.voiceChannelId, "").catch(() => null);
		}

		// Clear now-playing message controls
		const messageId = player.get<string | undefined>("messageId");
		const channel = guild.channels.cache.get(player.textChannelId!) as TextChannel | undefined;
		if (messageId && channel) {
			const message = await channel.messages.fetch(messageId).catch(() => null);
			if (message?.editable) await message.edit({ components: [] }).catch(() => null);
		}

		const timeoutSecs = env.LEAVE_TIMEOUT;

		// Schedule Lavalink player destruction — bot stays in voice channel
		this.client.manager.scheduleIdleDestroy(player.guildId, timeoutSecs);

		logger.info(
			`[QueueEnd] Guild ${guild.id}: queue empty. ` +
			(timeoutSecs > 0
				? `Lavalink player will be released in ${timeoutSecs}s.`
				: "Lavalink player released immediately."),
		);
	}
}
