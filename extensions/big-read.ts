/**
 * big-gulp-reads — override pi's built-in `read` tool with a configurable truncation limit.
 *
 * The built-in caps output at 50KB / 2000 lines via constants that no option can
 * change (ReadToolOptions has no truncation knobs), so this tool re-implements
 * the text path with pi's own truncateHead() but reads the limits from
 * ~/.pi/agent/big-gulp-reads.json, editable at runtime via /big-gulp-reads.
 *
 * Images are returned as attachments like the built-in does, but without
 * auto-resizing — pi does not export processImage, so oversized images may be
 * rejected by providers that cap image dimensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, getAgentDir, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { constants } from "fs";
import { access, appendFile, readFile, writeFile } from "fs/promises";
import { extname, join, resolve } from "path";
import { Type } from "typebox";

const CONFIG_FILE = join(getAgentDir(), "big-gulp-reads.json");

const DEFAULTS = { maxKB: 200, maxLines: 5000 };
const HARD_CAPS = { maxKB: 16384, maxLines: 100_000 };

interface Limits {
	maxKB: number;
	maxLines: number;
}

let limits: Limits = { ...DEFAULTS };

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

async function loadConfig() {
	try {
		const raw = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Partial<Limits>;
		if (typeof raw.maxKB === "number" && raw.maxKB >= 1) limits.maxKB = Math.min(raw.maxKB, HARD_CAPS.maxKB);
		if (typeof raw.maxLines === "number" && raw.maxLines >= 1) limits.maxLines = Math.min(raw.maxLines, HARD_CAPS.maxLines);
	} catch {
		// Missing or corrupt config falls back to defaults; the /big-gulp-reads command rewrites it.
	}
}

async function saveConfig() {
	await withFileMutationQueue(CONFIG_FILE, async () => {
		await writeFile(CONFIG_FILE, JSON.stringify(limits, null, "\t") + "\n", "utf-8");
	});
}

async function logOverride(path: string) {
	// Audit line proving which limit was live when a read ran; cheap and greppable.
	const line = `[big-gulp-reads] ${path} (limit ${limits.maxKB}KB / ${limits.maxLines} lines)\n`;
	try {
		await withFileMutationQueue(CONFIG_FILE + ".log", async () => {
			await appendFile(CONFIG_FILE + ".log", line);
		});
	} catch {
		// Logging must never fail a read.
	}
}

const IMAGE_MIMES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

function describeLimits(): string {
	return `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments without auto-resizing. For text files, output is truncated to the limits configured via /big-gulp-reads (currently ${limits.maxKB}KB / ${limits.maxLines} lines). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;
}

export default function (pi: ExtensionAPI) {
	void loadConfig();

	pi.registerTool({
		name: "read", // Same name as the built-in: replaces it without a warning.
		label: "read (big-gulp-reads)",
		description: describeLimits(),
		parameters: readSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// The harness does not enforce required schema fields before execute runs.
			if (typeof params.path !== "string" || params.path.length === 0) {
				return { content: [{ type: "text", text: "Error: path is required." }] };
			}
			// Built-in tools strip a leading @ from paths; some models include it.
			const rawPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const absolutePath = resolve(ctx.cwd, rawPath);

			try {
				await access(absolutePath, constants.R_OK);
				const buffer = await readFile(absolutePath);

				const mime = IMAGE_MIMES[extname(absolutePath).toLowerCase()];
				if (mime) {
					return {
						content: [
							{ type: "text", text: `Read image file [${mime}] (no auto-resize)` },
							{ type: "image", data: buffer.toString("base64"), mimeType: mime },
						],
					};
				}

				// Text path mirrors the built-in read tool's messages so the model's
				// offset/limit habits keep working.
				const content = buffer.toString("utf-8");
				const lines = content.split("\n");
				if (content.endsWith("\n")) lines.pop();
				const totalFileLines = lines.length;
				const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
				const startLineDisplay = startLine + 1;
				if (startLine >= totalFileLines) {
					return { content: [{ type: "text", text: `Error: Offset ${params.offset} is beyond end of file (${totalFileLines} lines total)` }] };
				}
				const selected = params.limit !== undefined ? lines.slice(startLine, startLine + params.limit) : lines.slice(startLine);

				const maxBytes = limits.maxKB * 1024;
				const truncation = truncateHead(selected.join("\n"), { maxLines: limits.maxLines, maxBytes });
				void logOverride(absolutePath);

				let outputText: string;
				if (truncation.firstLineExceedsLimit) {
					// truncateHead does not report the oversized line's byte count, so measure it here.
					const firstLineBytes = Buffer.byteLength(selected[0] ?? "", "utf-8");
					outputText = `[Line ${startLineDisplay} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(maxBytes)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${maxBytes}]`;
				} else if (truncation.truncated) {
					const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
					const nextOffset = endLineDisplay + 1;
					outputText = truncation.content;
					if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
					} else {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
					}
				} else if (params.limit !== undefined && startLine + truncation.outputLines < totalFileLines) {
					const remaining = totalFileLines - (startLine + truncation.outputLines);
					const nextOffset = startLine + truncation.outputLines + 1;
					outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText = truncation.content;
				}

				return { content: [{ type: "text", text: outputText }], details: { truncation } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error reading file: ${message}` }] };
			}
		},
	});

	pi.registerCommand("big-gulp-reads", {
		description: "Show or set the big-gulp-reads read limits. Usage: /big-gulp-reads [<KB> | lines <N> | reset]",
		getArgumentCompletions: (prefix) => {
			const items = ["reset", "lines", "50", "100", "200", "500", "1000", "2000"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			if (tokens.length === 0) {
				ctx.ui.notify(`big-gulp-reads read limits: ${limits.maxKB}KB / ${limits.maxLines} lines (defaults: ${DEFAULTS.maxKB}KB / ${DEFAULTS.maxLines})`, "info");
				return;
			}

			if (tokens[0] === "reset") {
				limits = { ...DEFAULTS };
				await saveConfig();
				ctx.ui.notify(`big-gulp-reads reset to defaults: ${limits.maxKB}KB / ${limits.maxLines} lines`, "info");
				return;
			}

			if (tokens[0] === "lines") {
				const n = Number(tokens[1]);
				if (tokens.length !== 2 || !Number.isInteger(n) || n < 1 || n > HARD_CAPS.maxLines) {
					ctx.ui.notify(`Invalid line limit. Usage: /big-gulp-reads lines <1..${HARD_CAPS.maxLines}>`, "error");
					return;
				}
				limits.maxLines = n;
				await saveConfig();
				ctx.ui.notify(`big-gulp-reads line limit set to ${n} (byte limit: ${limits.maxKB}KB)`, "info");
				return;
			}

			const kb = Number(tokens[0]);
			if (tokens.length !== 1 || !Number.isInteger(kb) || kb < 1 || kb > HARD_CAPS.maxKB) {
				ctx.ui.notify(`Invalid KB limit. Usage: /big-gulp-reads <1..${HARD_CAPS.maxKB}> | lines <N> | reset`, "error");
				return;
			}
			limits.maxKB = kb;
			await saveConfig();
			ctx.ui.notify(`big-gulp-reads byte limit set to ${kb}KB (line limit: ${limits.maxLines})`, "info");
		},
	});
}
