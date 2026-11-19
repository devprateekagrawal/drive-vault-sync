import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { AuthError, GoogleAuth } from "./auth";

// Minimal Google Drive v3 REST client. Uses Obsidian's requestUrl, which works on desktop
// and mobile and is not blocked by CORS.

export const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,mimeType,parents,md5Checksum,size,modifiedTime,trashed";
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // above this, Drive wants a resumable upload

export interface RemoteItem {
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	md5Checksum?: string;
	size?: string;
	modifiedTime?: string;
	trashed?: boolean;
}

export class DriveError extends Error {
	constructor(message: string, public status: number) {
		super(message);
	}
}

function q(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function header(res: RequestUrlResponse, name: string): string | undefined {
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(res.headers ?? {})) if (k.toLowerCase() === want) return v;
	return undefined;
}

function concat(...parts: Uint8Array[]): ArrayBuffer {
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out.buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DriveClient {
	constructor(private auth: GoogleAuth) {}

	/** Authorized request with one token refresh on 401 and backoff on 429/5xx. */
	private async call(p: RequestUrlParam): Promise<RequestUrlResponse> {
		let refreshed = false;
		for (let attempt = 0; ; attempt++) {
			const token = await this.auth.accessToken(refreshed);
			const res = await requestUrl({
				...p,
				headers: { ...(p.headers ?? {}), Authorization: `Bearer ${token}` },
				throw: false,
			});
			if (res.status === 401 && !refreshed) {
				refreshed = true;
				continue;
			}
			const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(res.text));
			if (retryable && attempt < 4) {
				await sleep(Math.min(16000, 1000 * 2 ** attempt) + Math.random() * 500);
				continue;
			}
			if (res.status === 401) throw new AuthError("Google rejected the sign-in. Sign in again.");
			if (res.status >= 400) {
				let msg = res.text;
				try {
					msg = res.json?.error?.message ?? msg;
				} catch {
					/* not json */
				}
				throw new DriveError(`Drive ${p.method ?? "GET"} failed (${res.status}): ${msg}`, res.status);
			}
			return res;
		}
	}

	async get(id: string): Promise<RemoteItem | null> {
		try {
			const res = await this.call({ url: `${API}/files/${id}?fields=${FIELDS}` });
			return res.json as RemoteItem;
		} catch (e) {
			if (e instanceof DriveError && e.status === 404) return null;
			throw e;
		}
	}

	/** Every non-trashed file and folder this app can see (with drive.file: only ones it created). */
	async listAll(): Promise<RemoteItem[]> {
		const out: RemoteItem[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: "trashed = false",
				fields: `nextPageToken,files(${FIELDS})`,
				pageSize: "1000",
				spaces: "drive",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const res = await this.call({ url: `${API}/files?${params}` });
			out.push(...(res.json.files as RemoteItem[]));
			pageToken = res.json.nextPageToken;
		} while (pageToken);
		return out;
	}

	async findRootFolder(name: string): Promise<RemoteItem | null> {
		const params = new URLSearchParams({
			q: `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
			fields: `files(${FIELDS})`,
			orderBy: "createdTime",
		});
		const res = await this.call({ url: `${API}/files?${params}` });
		const files = res.json.files as RemoteItem[];
		return files.length ? files[0] : null;
	}

	async createFolder(name: string, parentId: string): Promise<RemoteItem> {
		const res = await this.call({
			url: `${API}/files?fields=${FIELDS}`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
		});
		return res.json as RemoteItem;
	}

	/** Create a new file, or replace the content of an existing one when id is given. */
	async upload(data: ArrayBuffer, target: { id: string } | { name: string; parentId: string }): Promise<RemoteItem> {
		const isNew = !("id" in target);
		const metadata = isNew ? { name: target.name, parents: [target.parentId] } : undefined;

		if (data.byteLength > SIMPLE_UPLOAD_LIMIT) {
			// Resumable: first ask for an upload URL, then send the bytes.
			const start = await this.call({
				url: isNew ? `${UPLOAD}/files?uploadType=resumable` : `${UPLOAD}/files/${(target as { id: string }).id}?uploadType=resumable`,
				method: isNew ? "POST" : "PATCH",
				contentType: "application/json; charset=UTF-8",
				headers: { "X-Upload-Content-Type": "application/octet-stream" },
				body: JSON.stringify(metadata ?? {}),
			});
			const location = header(start, "location");
			if (!location) throw new DriveError("Drive did not return an upload URL", 500);
			const sep = location.includes("?") ? "&" : "?";
			const res = await this.call({
				url: `${location}${sep}fields=${FIELDS}`,
				method: "PUT",
				contentType: "application/octet-stream",
				body: data,
			});
			return res.json as RemoteItem;
		}

		if (!isNew) {
			const res = await this.call({
				url: `${UPLOAD}/files/${(target as { id: string }).id}?uploadType=media&fields=${FIELDS}`,
				method: "PATCH",
				contentType: "application/octet-stream",
				body: data,
			});
			return res.json as RemoteItem;
		}

		// Multipart: metadata and content in one request.
		const boundary = "dvs" + Math.random().toString(36).slice(2);
		const enc = new TextEncoder();
		const body = concat(
			enc.encode(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
					`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
			),
			new Uint8Array(data),
			enc.encode(`\r\n--${boundary}--`),
		);
		const res = await this.call({
			url: `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`,
			method: "POST",
			contentType: `multipart/related; boundary=${boundary}`,
			body,
		});
		return res.json as RemoteItem;
	}

	async download(id: string): Promise<ArrayBuffer> {
		const res = await this.call({ url: `${API}/files/${id}?alt=media` });
		return res.arrayBuffer;
	}

	async move(id: string, newName: string, newParentId: string, oldParentId: string): Promise<RemoteItem> {
		const params = new URLSearchParams({ fields: FIELDS });
		if (newParentId !== oldParentId) {
			params.set("addParents", newParentId);
			params.set("removeParents", oldParentId);
		}
		const res = await this.call({
			url: `${API}/files/${id}?${params}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ name: newName }),
		});
		return res.json as RemoteItem;
	}

	/** Moves to Drive's trash (restorable for 30 days), never a permanent delete. */
	async trash(id: string): Promise<void> {
		await this.call({
			url: `${API}/files/${id}?fields=id`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ trashed: true }),
		});
	}

	async startPageToken(): Promise<string> {
		const res = await this.call({ url: `${API}/changes/startPageToken` });
		return res.json.startPageToken as string;
	}

	/** Cheap check: has anything this app can see changed on Drive since the token? */
	async changesSince(token: string): Promise<{ changed: boolean; newToken: string }> {
		let pageToken: string | undefined = token;
		let changed = false;
		let newToken = token;
		while (pageToken) {
			const params: URLSearchParams = new URLSearchParams({
				pageToken,
				fields: "nextPageToken,newStartPageToken,changes(fileId)",
				pageSize: "1000",
				spaces: "drive",
			});
			const res = await this.call({ url: `${API}/changes?${params}` });
			if ((res.json.changes as unknown[]).length > 0) changed = true;
			if (res.json.newStartPageToken) newToken = res.json.newStartPageToken;
			pageToken = res.json.nextPageToken;
		}
		return { changed, newToken };
	}
}
