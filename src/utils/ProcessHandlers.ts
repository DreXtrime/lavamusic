import type { Lavamusic } from "../structures/index";
import logger from "../structures/Logger";

/** Error names/messages that are safe to swallow — they come from lavalink-client
 *  internals when a node connection times out or drops. The library already handles
 *  retrying; we just need to stop them from killing the process.
 */
const IGNORABLE = [
	"TimeoutError",
	"The operation timed out",
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"WebSocket was closed",
	"connect ENOENT",
	"read ECONNRESET",
];

function isIgnorable(err: unknown): boolean {
	if (!err) return false;
	const msg = err instanceof Error
		? `${err.name} ${err.message} ${(err as any).context?.message ?? ""}`
		: String(err);
	return IGNORABLE.some((s) => msg.includes(s));
}

export function setupAntiCrash(client: Lavamusic): void {
	// Catches promise rejections that were never .catch()-ed
	process.on("unhandledRejection", (reason) => {
		if (isIgnorable(reason)) {
			logger.warn(`[AntiCrash] Suppressed ignorable unhandledRejection: ${reason}`);
			return;
		}
		logger.error("Unhandled Rejection:", reason);
	});

	// Catches synchronous throws that escaped all try/catch
	process.on("uncaughtException", (err) => {
		if (isIgnorable(err)) {
			logger.warn(`[AntiCrash] Suppressed ignorable uncaughtException: ${err?.message}`);
			return;
		}
		logger.error("Uncaught Exception:", err);
	});

	// Secondary monitor — fires before uncaughtException and cannot prevent the crash
	// by itself, but combined with uncaughtException it gives us two chances to log
	process.on("uncaughtExceptionMonitor", (err) => {
		if (!isIgnorable(err)) {
			logger.error("uncaughtExceptionMonitor:", err);
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
