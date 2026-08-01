import type {
	ApplicationCommandOptionChoiceData,
	AutocompleteInteraction,
	VoiceChannel,
} from "discord.js";
import type { SearchResult } from "lavalink-client";
import { I18N, t } from "../../structures/I18n";
import { Command, type Context, type Lavamusic } from "../../structures/index";
import { applyFairPlayToQueue } from "../../utils/functions/player";
import {
	Connect,
	EmbedLinks,
	ReadMessageHistory,
	SendMessages,
	Speak,
	ViewChannel,
} from "../../utils/Permissions";

export default class Play extends Command {
	constructor(client: Lavamusic) {
		super(client, {
			name: "play",
			description: {
				content: I18N.commands.play.description,
				examples: [
					"play example",
					"play https://www.youtube.com/watch?v=example",
					"play https://open.spotify.com/track/example",
				],
				usage: "play <song>",
			},
			category: "music",
			aliases: ["p"],
			cooldown: 3,
			args: true,
			vote: false,
			player: {
				voice: true,
				dj: false,
				active: false,
				djPerm: null,
			},
			permissions: {
				dev: false,
				client: [SendMessages, ReadMessageHistory, ViewChannel, EmbedLinks, Connect, Speak],
				user: [],
			},
			slashCommand: true,
			options: [
				{
					name: "song",
					description: t(I18N.commands.play.options.song),
					type: 3,
					required: true,
					autocomplete: true,
				},
			],
		});
	}

	public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
		const query = args.join(" ");
		await ctx.sendDeferMessage(ctx.locale(I18N.commands.play.loading));

		const embed = this.client.embed();
		const memberVoiceChannel = (ctx.member as any).voice.channel as VoiceChannel;

		// Wait for a Lavalink node
		const nodeReady = await client.manager.waitForNode(15_000);
		if (!nodeReady) {
			return await ctx.editMessage({
				content: "",
				embeds: [embed.setColor(this.client.color.red).setDescription(
					ctx.locale(I18N.commands.play.errors.search_error) +
					"\n*(No Lavalink nodes available right now. Please try again in a moment.)*",
				)],
			});
		}

		// Cancel any pending idle-destroy since we have new activity
		client.manager.cancelIdleTimer(ctx.guild.id);

		// Track voice state so we know where the bot is even without a player
		const existing = client.manager.voiceStates.get(ctx.guild.id);
		client.manager.voiceStates.set(ctx.guild.id, {
			voiceChannelId: memberVoiceChannel.id,
			textChannelId: ctx.channel.id,
			idleTimer: existing?.idleTimer ?? null,
		});

		// Get existing player or create a fresh one
		let player = client.manager.getPlayer(ctx.guild.id);
		if (!player) {
			player = client.manager.createPlayer({
				guildId: ctx.guild.id,
				voiceChannelId: memberVoiceChannel.id,
				textChannelId: ctx.channel.id,
				selfMute: false,
				selfDeaf: true,
				vcRegion: memberVoiceChannel.rtcRegion ?? undefined,
			});
		}

		if (!player.connected) await player.connect();

		// Search
		let response: SearchResult;
		try {
			response = await client.manager.search({ query }, ctx.author);
		} catch {
			return await ctx.editMessage({
				content: "",
				embeds: [embed.setColor(this.client.color.red).setDescription(
					ctx.locale(I18N.commands.play.errors.search_error) +
					"\n*(Search failed — no Lavalink nodes available.)*",
				)],
			});
		}

		if (!response || response.tracks?.length === 0) {
			return await ctx.editMessage({
				content: "",
				embeds: [embed.setColor(this.client.color.red).setDescription(
					ctx.locale(I18N.commands.play.errors.search_error),
				)],
			});
		}

		await player.queue.add(
			response.loadType === "playlist" ? response.tracks : response.tracks[0],
		);

		if (player.get<boolean>("fairplay")) {
			await applyFairPlayToQueue(player);
		}

		if (response.loadType === "playlist") {
			await ctx.editMessage({
				content: "",
				embeds: [embed.setColor(this.client.color.main).setDescription(
					ctx.locale(I18N.commands.play.added_playlist_to_queue, { length: response.tracks.length }),
				)],
			});
		} else {
			await ctx.editMessage({
				content: "",
				embeds: [embed.setColor(this.client.color.main).setDescription(
					ctx.locale(I18N.commands.play.added_to_queue, {
						title: response.tracks[0].info.title,
						uri: response.tracks[0].info.uri,
					}),
				)],
			});
		}

		if (!player.playing && player.queue.tracks.length > 0) {
			await player.play({ paused: false });
		}
	}

	public async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
		const focusedValue = interaction.options.getFocused(true);
		if (!focusedValue?.value.trim()) return interaction.respond([]);
		if (!this.client.manager.hasConnectedNode()) return interaction.respond([]);

		try {
			const res = await this.client.manager.search(focusedValue.value.trim(), interaction.user);
			const songs: ApplicationCommandOptionChoiceData[] = [];
			if (res.loadType === "search") {
				res.tracks.slice(0, 10).forEach((track) => {
					const name = `${track.info.title} by ${track.info.author}`;
					songs.push({
						name: name.length > 100 ? `${name.substring(0, 97)}...` : name,
						value: track.info.uri,
					});
				});
			}
			return await interaction.respond(songs);
		} catch {
			return interaction.respond([]);
		}
	}
}
