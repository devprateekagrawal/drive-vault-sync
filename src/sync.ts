import { App, TFile, TFolder } from "obsidian";
import SparkMD5 from "spark-md5";
import { DriveClient, FOLDER_MIME, RemoteItem } from "./drive";
import {
	FileAction,
	baseName,
	buildPaths,
	compileIgnore,
	conflictPath,
	parentPath,
	planFile,
	planFolder,
	remapPrefix,
} from "./plan";

export interface SyncState {
	rootFolderId?: string;
	rootFolderName?: string;
	changesToken?: string;
	lastFullSync?: number;
	lastResult?: string;
	/** path -> md5 both sides agreed on at the last sync */
	base: Record<string, string>;
	/** folders that existed on both sides at the last sync */
	baseFolders: string[];
	/** path -> md5, reused while mtime and size are unchanged, so we don't re-read the whole vault */
	hashCache: Record<string, { mtime: number; size: number; md5: string }>;
	/** renames seen in this vault since the last sync, replayed on Drive as moves */
	pendingRenames: { from: string; to: string }[];
}

export const emptyState = (): SyncState => ({ base: {}, baseFolders: [], hashCache: {}, pendingRenames: [] });

export interface SyncSettings {
	remoteFolderName: string;
	deviceName: string;
	ignorePatterns: string;
	massDeleteLimit: number;
}

export interface SyncOptions {
	/** skip the cheap "anything changed?" check and compare everything */
	full?: boolean;
	/** let a sync go ahead even when it deletes more files than the safety limit */
	allowMassDelete?: boolean;
}

export interface SyncResult {
	skipped: boolean;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: string[];
	errors: string[];
}

export class MassDeleteError extends Error {}

const FULL_SYNC_EVERY_MS = 30 * 60 * 1000;
const PARALLEL = 4;

const md5 = (data: ArrayBuffer) => SparkMD5.ArrayBuffer.hash(data);
const isHidden = (p: string) => p.startsWith(".") || p.includes("/.");
const isGoogleNative = (it: RemoteItem) => it.mimeType.startsWith("application/vnd.google-apps.") && it.mimeType !== FOLDER_MIME;
/** Content key of a Drive file, comparable with local md5 hashes. */
const remoteKey = (it: RemoteItem) => it.md5Checksum ?? `nomd5:${it.size}:${it.modifiedTime}`;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	let i = 0;
	const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
		while (i < items.length) await fn(items[i++]);
	});
	await Promise.all(workers);
}

function remapKeys<V>(rec: Record<string, V>, from: string, to: string): Record<string, V> {
	const out: Record<string, V> = {};
	for (const [k, v] of Object.entries(rec)) out[remapPrefix(k, from, to) ?? k] = v;
	return out;
}

function remapMap<V>(m: Map<string, V>, from: string, to: string): void {
	for (const [k, v] of [...m.entries()]) {
		const nk = remapPrefix(k, from, to);
		if (nk !== null) {
			m.delete(k);
			m.set(nk, v);
		}
	}
}

export class SyncEngine {
	private dirty = true;
	private selfWrites = new Map<string, number>();
	private folderJobs = new Map<string, Promise<string>>();

	constructor(
		private app: App,
		private drive: DriveClient,
		private settings: () => SyncSettings,
		private state: () => SyncState,
		private save: () => Promise<void>,
	) {}

	/** Called on any local vault change that this engine did not make itself. */
	markDirty(): void {
		this.dirty = true;
	}

	/** True while the engine itself is writing this path (so vault events for it are ignored). */
	isSelfWrite(path: string): boolean {
		return this.selfWrites.has(path);
	}

	private async selfWrite<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
		for (const p of paths) this.selfWrites.set(p, (this.selfWrites.get(p) ?? 0) + 1);
		try {
			return await fn();
		} finally {
			// Vault events arrive slightly after the write resolves.
			setTimeout(() => {
				for (const p of paths) {
					const n = (this.selfWrites.get(p) ?? 1) - 1;
					if (n <= 0) this.selfWrites.delete(p);
					else this.selfWrites.set(p, n);
				}
			}, 2000);
		}
	}

	async sync(opts: SyncOptions = {}): Promise<SyncResult> {
		const result: SyncResult = {
			skipped: false,
			uploaded: 0,
			downloaded: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: [],
			errors: [],
		};
		const st = this.state();

		// Cheap path: nothing changed here, and Drive's change feed is empty -> done in one request.
		if (
			!opts.full &&
			!this.dirty &&
			st.changesToken &&
			st.rootFolderId &&
			st.lastFullSync &&
			Date.now() - st.lastFullSync < FULL_SYNC_EVERY_MS
		) {
			const { changed, newToken } = await this.drive.changesSince(st.changesToken);
			if (!changed) {
				if (newToken !== st.changesToken) {
					st.changesToken = newToken;
					await this.save();
				}
				result.skipped = true;
				return result;
			}
		}

		// Cleared before the work starts, so edits made DURING the sync mark it dirty again.
		this.dirty = false;
		try {
			await this.fullSync(opts, result);
		} catch (e) {
			this.dirty = true;
			throw e;
		}
		if (result.errors.length) this.dirty = true;
		return result;
	}

	private async ensureRoot(): Promise<string> {
		const st = this.state();
		const name = this.settings().remoteFolderName.trim();
		if (!name) throw new Error("Set a Drive folder name in the plugin settings.");
		if (st.rootFolderId && st.rootFolderName === name) {
			const it = await this.drive.get(st.rootFolderId);
			if (it && !it.trashed) return it.id;
		}
		// New, renamed or deleted Drive folder: the old base belongs to a different folder.
		// Starting from an empty base means nothing is ever deleted on the first sync; it only copies.
		if (st.rootFolderId) {
			st.base = {};
			st.baseFolders = [];
			st.changesToken = undefined;
			st.pendingRenames = [];
		}
		const found = (await this.drive.findRootFolder(name)) ?? (await this.drive.createFolder(name, "root"));
		st.rootFolderId = found.id;
		st.rootFolderName = name;
		await this.save();
		return found.id;
	}

	private ensureRemoteFolder(path: string, rootId: string, rFolders: Map<string, RemoteItem>): Promise<string> {
		if (path === "") return Promise.resolve(rootId);
		const existing = rFolders.get(path);
		if (existing) return Promise.resolve(existing.id);
		let job = this.folderJobs.get(path);
		if (!job) {
			job = (async () => {
				const parentId = await this.ensureRemoteFolder(parentPath(path), rootId, rFolders);
				const f = await this.drive.createFolder(baseName(path), parentId);
				rFolders.set(path, f);
				return f.id;
			})();
			this.folderJobs.set(path, job);
			job.catch(() => this.folderJobs.delete(path));
		}
		return job;
	}

	private async ensureLocalFolder(path: string): Promise<void> {
		if (!path) return;
		const ex = this.app.vault.getAbstractFileByPath(path);
		if (ex instanceof TFolder) return;
		if (ex) throw new Error(`"${path}" is a file here but a folder on Drive`);
		await this.ensureLocalFolder(parentPath(path));
		try {
			await this.selfWrite([path], () => this.app.vault.createFolder(path));
		} catch (e) {
			if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw e;
		}
	}

	private localListing(skip: (p: string) => boolean): { files: Map<string, TFile>; folders: Set<string> } {
		const files = new Map<string, TFile>();
		const folders = new Set<string>();
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (!f.path || f.path === "/" || skip(f.path)) continue;
			if (f instanceof TFile) files.set(f.path, f);
			else if (f instanceof TFolder) folders.add(f.path);
		}
		return { files, folders };
	}

	private async fullSync(opts: SyncOptions, result: SyncResult): Promise<void> {
		const st = this.state();
		const s = this.settings();
		const ignored = compileIgnore(s.ignorePatterns);
		const skip = (p: string) => isHidden(p) || ignored(p);
		this.folderJobs.clear();

		// 1. Drive side. Take the change token BEFORE listing, so nothing that changes mid-sync is missed.
		const rootId = await this.ensureRoot();
		const newToken = await this.drive.startPageToken();
		const { paths, duplicates } = buildPaths(rootId, await this.drive.listAll());
		for (const d of duplicates) console.warn(`[drive-vault-sync] duplicate name on Drive ignored: ${d.name} (${d.id})`);
		const rFiles = new Map<string, RemoteItem>();
		const rFolders = new Map<string, RemoteItem>();
		const rUntouched: string[] = []; // ignored items on Drive: never synced, but they keep their folder alive
		for (const [p, it] of paths) {
			if (skip(p) || isGoogleNative(it)) {
				rUntouched.push(p);
				continue;
			}
			(it.mimeType === FOLDER_MIME ? rFolders : rFiles).set(p, it);
		}

		// 2. Replay local renames as Drive moves (a renamed folder moves in one request, nothing re-uploads).
		const renames = st.pendingRenames.splice(0);
		for (const { from, to } of renames) {
			if (skip(from) || skip(to)) continue;
			const item = rFiles.get(from) ?? rFolders.get(from);
			if (!item || rFiles.has(to) || rFolders.has(to)) continue;
			try {
				const parentId = await this.ensureRemoteFolder(parentPath(to), rootId, rFolders);
				await this.drive.move(item.id, baseName(to), parentId, item.parents?.[0] ?? rootId);
				item.name = baseName(to);
				item.parents = [parentId];
				remapMap(rFiles, from, to);
				remapMap(rFolders, from, to);
				st.base = remapKeys(st.base, from, to);
				st.hashCache = remapKeys(st.hashCache, from, to);
				st.baseFolders = st.baseFolders.map((p) => remapPrefix(p, from, to) ?? p);
			} catch (e) {
				// Falls back to delete + upload, which is slower but still correct.
				console.warn(`[drive-vault-sync] move ${from} -> ${to} failed`, e);
			}
		}

		// 3. Local side, with hashes (re-read only files whose mtime or size changed).
		const local = this.localListing(skip);
		const lHash = new Map<string, string>();
		const newCache: SyncState["hashCache"] = {};
		let n = 0;
		for (const [p, f] of local.files) {
			const c = st.hashCache[p];
			if (c && c.mtime === f.stat.mtime && c.size === f.stat.size) {
				lHash.set(p, c.md5);
				newCache[p] = c;
				continue;
			}
			const { mtime, size } = f.stat; // read stat BEFORE content, so a later edit is never cached as seen
			const h = md5(await this.app.vault.readBinary(f));
			lHash.set(p, h);
			newCache[p] = { mtime, size, md5: h };
			if (++n % 25 === 0) await yieldToUi();
		}
		st.hashCache = newCache;

		// 4. Decide per file.
		const plan: { path: string; action: FileAction }[] = [];
		const all = new Set<string>([...local.files.keys(), ...rFiles.keys(), ...Object.keys(st.base)]);
		for (const p of all) {
			if (skip(p)) {
				delete st.base[p];
				continue;
			}
			const r = rFiles.get(p);
			plan.push({ path: p, action: planFile(lHash.get(p), r && remoteKey(r), st.base[p]) });
		}

		// 5. Safety: refuse surprising mass deletes (e.g. a vault that looks empty at startup).
		const deletes = plan.filter((x) => x.action === "deleteLocal" || x.action === "deleteRemote").length;
		const baseCount = Object.keys(st.base).length;
		const looksEmpty = local.files.size === 0 && baseCount > 0;
		if (!opts.allowMassDelete && (deletes > s.massDeleteLimit || (looksEmpty && deletes > 0))) {
			await this.save();
			throw new MassDeleteError(
				`This sync would delete ${deletes} files, more than your safety limit of ${s.massDeleteLimit}. ` +
					`Nothing was changed. If that is what you want, run the command "Sync now (allow deletes)".`,
			);
		}

		// 6. Carry out file actions.
		await pool(plan, PARALLEL, async ({ path, action }) => {
			try {
				await this.apply(path, action, { rootId, rFiles, rFolders, lFiles: local.files, lHash, result });
			} catch (e) {
				result.errors.push(`${path}: ${errMsg(e)}`);
			}
		});

		// 7. Folders (so empty folders sync too). Creates shallow-first, deletes deep-first and only when empty.
		try {
			await this.syncFolders(skip, rootId, rFiles, rFolders, rUntouched);
		} catch (e) {
			result.errors.push(`folders: ${errMsg(e)}`);
		}

		st.changesToken = newToken;
		st.lastFullSync = Date.now();
		await this.save();
	}

	private async apply(
		path: string,
		action: FileAction,
		ctx: {
			rootId: string;
			rFiles: Map<string, RemoteItem>;
			rFolders: Map<string, RemoteItem>;
			lFiles: Map<string, TFile>;
			lHash: Map<string, string>;
			result: SyncResult;
		},
	): Promise<void> {
		const st = this.state();
		const vault = this.app.vault;
		const { rootId, rFiles, rFolders, lFiles, lHash, result } = ctx;
		const f = lFiles.get(path);
		const r = rFiles.get(path);

		/** Has the local file changed since we hashed it at the start of this sync? */
		const changedSincePlan = async (file: TFile) => md5(await vault.readBinary(file)) !== lHash.get(path);

		switch (action) {
			case "none":
				st.base[path] = lHash.get(path)!;
				return;

			case "forget":
				delete st.base[path];
				return;

			case "upload": {
				const { mtime, size } = f!.stat;
				const data = await vault.readBinary(f!);
				const h = md5(data);
				const item = r
					? await this.drive.upload(data, { id: r.id })
					: await this.drive.upload(data, {
							name: baseName(path),
							parentId: await this.ensureRemoteFolder(parentPath(path), rootId, rFolders),
						});
				rFiles.set(path, item);
				st.base[path] = h;
				st.hashCache[path] = { mtime, size, md5: h };
				result.uploaded++;
				return;
			}

			case "download": {
				const data = await this.drive.download(r!.id);
				const mtime = r!.modifiedTime ? Date.parse(r!.modifiedTime) : Date.now();
				let file: TFile;
				if (f) {
					if (await changedSincePlan(f)) {
						this.dirty = true; // edited during this sync: the next sync decides
						return;
					}
					await this.selfWrite([path], () => vault.modifyBinary(f, data, { mtime }));
					file = f;
				} else {
					if (vault.getAbstractFileByPath(path)) {
						this.dirty = true; // created during this sync
						return;
					}
					await this.ensureLocalFolder(parentPath(path));
					file = await this.selfWrite([path], () => vault.createBinary(path, data, { mtime }));
				}
				st.base[path] = remoteKey(r!);
				st.hashCache[path] = { mtime: file.stat.mtime, size: file.stat.size, md5: md5(data) };
				result.downloaded++;
				return;
			}

			case "deleteLocal": {
				if (await changedSincePlan(f!)) {
					this.dirty = true;
					return;
				}
				// Vault trash (.trash folder), not a permanent delete.
				await this.selfWrite([path], () => vault.trash(f!, false));
				delete st.base[path];
				delete st.hashCache[path];
				result.deletedLocal++;
				return;
			}

			case "deleteRemote": {
				await this.drive.trash(r!.id); // Drive trash, restorable for 30 days
				rFiles.delete(path);
				delete st.base[path];
				result.deletedRemote++;
				return;
			}

			case "conflict": {
				// Changed on both devices. Keep BOTH: Drive's version stays at the original name,
				// this device's version is saved next to it as "name (conflict <date> <device>).ext".
				const localData = await vault.readBinary(f!);
				const remoteData = await this.drive.download(r!.id);
				const cPath = conflictPath(path, this.settings().deviceName, new Date());
				const cFile = await this.selfWrite([cPath], () => vault.createBinary(cPath, localData));
				await this.selfWrite([path], () => vault.modifyBinary(f!, remoteData));
				st.base[path] = remoteKey(r!);
				st.hashCache[path] = { mtime: f!.stat.mtime, size: f!.stat.size, md5: md5(remoteData) };
				const hLocal = md5(localData);
				st.hashCache[cPath] = { mtime: cFile.stat.mtime, size: cFile.stat.size, md5: hLocal };
				result.conflicts.push(cPath);
				// If this upload fails, the conflict copy is simply uploaded on the next sync.
				const item = await this.drive.upload(localData, {
					name: baseName(cPath),
					parentId: await this.ensureRemoteFolder(parentPath(path), rootId, rFolders),
				});
				rFiles.set(cPath, item);
				st.base[cPath] = hLocal;
				return;
			}
		}
	}

	private async syncFolders(
		skip: (p: string) => boolean,
		rootId: string,
		rFiles: Map<string, RemoteItem>,
		rFolders: Map<string, RemoteItem>,
		rUntouched: string[],
	): Promise<void> {
		const st = this.state();
		const vault = this.app.vault;
		const localFolders = this.localListing(skip).folders;
		const baseF = new Set(st.baseFolders);
		const all = [...new Set([...localFolders, ...rFolders.keys(), ...st.baseFolders])].filter((p) => !skip(p));
		const depth = (p: string) => p.split("/").length;
		const actions = all.map((p) => ({ p, a: planFolder(localFolders.has(p), rFolders.has(p), baseF.has(p)) }));

		for (const { p, a } of actions.sort((x, y) => depth(x.p) - depth(y.p))) {
			if (a === "createRemote") await this.ensureRemoteFolder(p, rootId, rFolders);
			if (a === "createLocal") await this.ensureLocalFolder(p);
		}
		for (const { p, a } of actions.sort((x, y) => depth(y.p) - depth(x.p))) {
			if (a === "deleteLocal") {
				const folder = vault.getAbstractFileByPath(p);
				if (folder instanceof TFolder && folder.children.length === 0) {
					await this.selfWrite([p], () => vault.trash(folder, false));
				} else if (folder) {
					await this.ensureRemoteFolder(p, rootId, rFolders); // still holds notes: keep it
				}
			}
			if (a === "deleteRemote") {
				const inside = (q: string) => q.startsWith(p + "/");
				const hasContent =
					[...rFiles.keys()].some(inside) || [...rFolders.keys()].some(inside) || rUntouched.some(inside);
				const item = rFolders.get(p);
				if (!item) continue;
				if (!hasContent) {
					await this.drive.trash(item.id);
					rFolders.delete(p);
				} else {
					await this.ensureLocalFolder(p);
				}
			}
		}

		const finalLocal = this.localListing(skip).folders;
		st.baseFolders = [...finalLocal].filter((p) => rFolders.has(p));
	}
}
