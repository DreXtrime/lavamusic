import type { Lavamusic } from "../structures/index";
import logger from "../structures/Logger";

const IGNORABLE = [
	"TimeoutError",
	"The operation timed out",
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"WebSocket was closed",
	"connect ENOENT",
	"read ECONNRESET",
	"No Lavalink Node was provided",
	"Failed to parse JSON",
	"does not provide any /v4/info",
	"socket hang up",
	"EPIPE",
];

function isIgnorable(err: unknown): boolean {
	if (!err) return false;
	const msg = err instanceof Error
		? `${err.name} ${err.message} ${(err as any).context?.message ?? ""}`
		: String(err);
	return IGNORABLE.some((s) => msg.includes(s));
}

export function setupAntiCrash(client: Lavamusic): void {
	process.on("unhandledRejection", (reason) => {
		if (isIgnorable(reason)) {
			logger.warn(`[AntiCrash] Suppressed unhandledRejection: ${reason}`);
			return;
		}
		logger.error("[AntiCrash] Unhandled Rejection:", reason);
	});

	process.on("uncaughtException", (err) => {
		if (isIgnorable(err)) {
			logger.warn(`[AntiCrash] Suppressed uncaughtException: ${err?.message}`);
			return;
		}
		logger.error("[AntiCrash] Uncaught Exception:", err);
	});

	process.on("uncaughtExceptionMonitor", (err) => {
		if (!isIgnorable(err)) {
			logger.error("[AntiCrash] uncaughtExceptionMonitor:", err);
		}
	});

	const handleExit = async (): Promise<void> => {
		logger.star("Shutting down...");
		try { await client.manager.disconnectAllNodes(); } catch (_) {}
		try { await client.destroy(); } catch (_) {}
		logger.success("Disconnected cleanly.");
		process.exit(0);
	};

	process.on("SIGINT", handleExit);
	process.on("SIGTERM", handleExit);
	process.on("SIGQUIT", handleExit);
}
