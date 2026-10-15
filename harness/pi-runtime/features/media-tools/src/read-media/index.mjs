import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * `read` on a video or audio file, for models that take media natively.
 *
 * Gemini samples video at 1 frame per second and hears the audio track, with a timestamp every
 * second (ai.google.dev/gemini-api/docs/video-understanding, 2026-10-13). Frames past 1 fps and
 * stereo, high-bitrate audio are bytes the server drops, so the clip is re-encoded to what the
 * model sees before it enters the session: the history re-sends it on every turn.
 *
 * The clip rides in an `image` content block with a video/audio MIME type. That is the shape
 * every layer already carries (session record, request image trimming, the Gemini encoder); the
 * media-tools image limits skip non-image MIME types, and the Gemini encoder sends these as
 * sibling parts because function responses take only images, PDF and text.
 */

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".wmv", ".flv", ".3gp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".weba"]);

/** APIs whose encoder is pi-ai's google-shared, where Gemini takes inline video and audio. */
export const GEMINI_MEDIA_APIS = new Set(["google-generative-ai", "google-vertex", "google-gemini-cli", "rubato-antigravity"]);

export const MEDIA_FPS = 1;
/** Short side of re-encoded video frames, in pixels. */
export const MEDIA_SHORT_SIDE = 1080;
export const VIDEO_CRF = 26;
export const AUDIO_BITRATE = "32k";
/**
 * Encoded clip cap. Request preparation keeps at most 16MB of image blocks
 * (rubato-pi context-notes/request-images.mjs); a clip over that would be dropped from the very
 * request that reads it, so one clip stays well under it.
 */
export const MEDIA_BYTE_LIMIT = 12 * 1024 * 1024;

export const VIDEO_MIME_TYPE = "video/mp4";
export const AUDIO_MIME_TYPE = "audio/mp3";

export function mediaKind(path) {
	const extension = extname(String(path)).toLowerCase();
	if (VIDEO_EXTENSIONS.has(extension)) return "video";
	if (AUDIO_EXTENSIONS.has(extension)) return "audio";
	return undefined;
}

export function watchesMedia(model) {
	return Boolean(model && GEMINI_MEDIA_APIS.has(model.api) && /gemini/i.test(String(model.id)));
}

export function isTimedMediaMimeType(mimeType) {
	return typeof mimeType === "string" && /^(video|audio)\//i.test(mimeType);
}

/** ffmpeg arguments that cut [start, start+duration) and re-encode it to what Gemini sees. */
export function encodeArgs({ input, output, kind, start, duration }) {
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
	if (start > 0) args.push("-ss", String(start));
	args.push("-i", input, "-t", String(duration));
	if (kind === "audio") {
		args.push("-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", AUDIO_BITRATE);
	} else {
		const side = MEDIA_SHORT_SIDE;
		args.push(
			"-map", "0:v:0", "-map", "0:a:0?",
			"-vf", `fps=${MEDIA_FPS},scale='if(lt(iw,ih),min(${side},iw),-2)':'if(lt(iw,ih),-2,min(${side},ih))'`,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", String(VIDEO_CRF), "-pix_fmt", "yuv420p",
			"-ac", "1", "-c:a", "aac", "-b:a", AUDIO_BITRATE,
			"-movflags", "+faststart",
		);
	}
	args.push(output);
	return args;
}

function run(command, args, signal) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				error.stderr = String(stderr ?? "");
				reject(error);
				return;
			}
			resolve(String(stdout ?? ""));
		});
	});
}

export function formatTime(seconds) {
	const whole = Math.max(0, Math.round(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = String(whole % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function formatMegabytes(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const text = (value) => ({ type: "text", text: value });

/**
 * Returns undefined for files that are not video or audio, so `read` goes on as before.
 * Otherwise returns `{ content }` for the tool result. `offset` and `limit` are seconds.
 */
export async function readMediaFile(path, model, { offset, limit, signal, exec = run } = {}) {
	const kind = mediaKind(path);
	if (!kind) return undefined;
	const name = basename(path);
	if (!watchesMedia(model)) {
		const who = model?.id ? `${model.provider ?? ""}${model.provider ? "/" : ""}${model.id}` : "The current model";
		return { content: [text(`${name} is ${kind}. ${who} cannot take ${kind} input; Gemini models on Google AI Studio, Vertex AI or Antigravity can.`)] };
	}

	let duration;
	try {
		const probed = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], signal);
		duration = Number.parseFloat(probed.trim());
	} catch (error) {
		if (error?.code === "ENOENT") return { content: [text(`Reading ${kind} needs ffmpeg and ffprobe on PATH (macOS: brew install ffmpeg).`)] };
		throw new Error(`ffprobe could not read ${name}: ${String(error?.stderr || error?.message).trim()}`);
	}
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe found no duration in ${name}`);

	const start = Math.max(0, Number(offset) || 0);
	if (start >= duration) throw new Error(`Offset ${start}s is beyond the end of ${name} (${formatTime(duration)})`);
	const length = limit === undefined ? duration - start : Math.max(1, Number(limit) || 0);
	const end = Math.min(duration, start + length);

	const directory = await mkdtemp(join(tmpdir(), "rubato-read-media-"));
	try {
		const output = join(directory, kind === "audio" ? "clip.mp3" : "clip.mp4");
		try {
			await exec("ffmpeg", encodeArgs({ input: path, output, kind, start, duration: end - start }), signal);
		} catch (error) {
			if (error?.code === "ENOENT") return { content: [text(`Reading ${kind} needs ffmpeg on PATH (macOS: brew install ffmpeg).`)] };
			throw new Error(`ffmpeg could not re-encode ${name}: ${String(error?.stderr || error?.message).trim()}`);
		}
		const bytes = await readFile(output);
		const range = `${formatTime(start)}–${formatTime(end)} of ${formatTime(duration)}`;
		if (bytes.byteLength > MEDIA_BYTE_LIMIT) {
			const fits = Math.max(1, Math.floor(((end - start) * MEDIA_BYTE_LIMIT * 0.9) / bytes.byteLength));
			return {
				content: [text(`${name} ${range} re-encodes to ${formatMegabytes(bytes.byteLength)}, over the ${formatMegabytes(MEDIA_BYTE_LIMIT)} limit for one read. Read about ${fits} seconds at a time: offset=${Math.floor(start)} limit=${fits}.`)],
			};
		}
		const mimeType = kind === "audio" ? AUDIO_MIME_TYPE : VIDEO_MIME_TYPE;
		const shape = kind === "audio"
			? `mono ${AUDIO_BITRATE}bps audio`
			: `${MEDIA_FPS} fps, short side up to ${MEDIA_SHORT_SIDE}px, mono audio`;
		const lines = [`Read ${kind} file [${mimeType}] ${name}: ${range}, re-encoded to ${shape} (${formatMegabytes(bytes.byteLength)}).`];
		if (start > 0) lines.push(`Timestamps in this clip start at 0:00, which is ${formatTime(start)} in the file.`);
		if (end < duration) lines.push(`More follows. Use offset=${Math.floor(end)} to continue; offset and limit are seconds for ${kind}.`);
		return {
			content: [text(lines.join("\n")), { type: "image", data: bytes.toString("base64"), mimeType }],
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
