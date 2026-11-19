// Pure sync decisions. No Obsidian or network imports, so this file is unit-tested in test/plan.test.ts.
//
// Every file is compared three ways, by content hash (md5):
//   local  = hash of the file in this vault now (undefined = not here)
//   remote = hash of the file in the Drive folder now (undefined = not there)
//   base   = hash both sides agreed on at the last successful sync (undefined = never synced)
// Comparing against the base tells us WHICH side changed, so we never guess from clocks.

export type FileAction =
	| "none" // both sides equal
	| "upload" // local changed (or new), remote unchanged
	| "download" // remote changed (or new), local unchanged
	| "deleteLocal" // deleted on Drive, unchanged here
	| "deleteRemote" // deleted here, unchanged on Drive
	| "conflict" // changed on both sides differently: keep both
	| "forget"; // gone from both sides: drop the base record

export function planFile(local?: string, remote?: string, base?: string): FileAction {
	const hasL = local !== undefined;
	const hasR = remote !== undefined;
	const hasB = base !== undefined;

	if (!hasL && !hasR) return "forget";

	if (hasL && hasR) {
		if (local === remote) return "none";
		if (hasB && remote === base) return "upload";
		if (hasB && local === base) return "download";
		return "conflict";
	}

	if (hasL) {
		// Only here.
		if (!hasB) return "upload"; // new note made here
		if (local === base) return "deleteLocal"; // deleted on the other device
		return "upload"; // deleted there, but edited here since: keep the edit
	}

	// Only on Drive.
	if (!hasB) return "download"; // new note from the other device
	if (remote === base) return "deleteRemote"; // deleted here
	return "download"; // deleted here, but edited there since: keep the edit
}

export type FolderAction = "none" | "createRemote" | "createLocal" | "deleteLocal" | "deleteRemote" | "forget";

/** Folder decision. Deletes are only carried out by the engine when the folder is empty. */
export function planFolder(localExists: boolean, remoteExists: boolean, inBase: boolean): FolderAction {
	if (localExists && remoteExists) return "none";
	if (!localExists && !remoteExists) return "forget";
	if (localExists) return inBase ? "deleteLocal" : "createRemote";
	return inBase ? "deleteRemote" : "createLocal";
}

/** Maps a path under a renamed folder/file to its new path. Returns null when the path is not affected. */
export function remapPrefix(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	if (path.startsWith(from + "/")) return to + path.slice(from.length);
	return null;
}

/** "notes/idea.md" -> "notes/idea (conflict 2026-11-19 1530 phone).md" */
export function conflictPath(path: string, device: string, date: Date): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const safeDevice = device.replace(/[\\/:*?"<>|]/g, "-").trim() || "device";
	return `${dir}${stem} (conflict ${stamp} ${safeDevice})${ext}`;
}

/**
 * Ignore patterns, one per line:
 *   "Templates/"   -> the folder and everything inside it
 *   "*.tmp"        -> glob, * does not cross "/", ** does
 *   "private.md"   -> exact path
 * Lines starting with # are comments.
 */
export function compileIgnore(patterns: string): (path: string) => boolean {
	const tests: ((p: string) => boolean)[] = [];
	for (const raw of patterns.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.endsWith("/")) {
			const dir = line.slice(0, -1);
			tests.push((p) => p === dir || p.startsWith(dir + "/"));
		} else if (line.includes("*")) {
			const re = new RegExp(
				"^" +
					line
						.split("**")
						.map((part) => part.split("*").map(escapeRe).join("[^/]*"))
						.join(".*") +
					"$",
			);
			// A pattern with no "/" matches the file name anywhere.
			const nameOnly = !line.includes("/");
			tests.push((p) => re.test(nameOnly ? p.slice(p.lastIndexOf("/") + 1) : p));
		} else {
			tests.push((p) => p === line);
		}
	}
	return (p) => tests.some((t) => t(p));
}

function escapeRe(s: string): string {
	return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export interface RemoteNode {
	id: string;
	name: string;
	parents?: string[];
	modifiedTime?: string;
}

/**
 * Turns Drive's flat file list into vault paths, relative to the sync root folder.
 * Items outside the root are dropped. When Drive holds two items with the same path
 * (Drive allows duplicate names), the most recently modified one wins and the rest are reported.
 */
export function buildPaths<T extends RemoteNode>(
	rootId: string,
	items: T[],
): { paths: Map<string, T>; duplicates: T[] } {
	const byId = new Map<string, T>();
	for (const it of items) byId.set(it.id, it);
	const memo = new Map<string, string | null>();
	memo.set(rootId, "");

	const resolve = (id: string, depth: number): string | null => {
		if (memo.has(id)) return memo.get(id)!;
		const it = byId.get(id);
		if (!it || !it.parents || it.parents.length === 0 || depth > 200) {
			memo.set(id, null);
			return null;
		}
		const parent = resolve(it.parents[0], depth + 1);
		const p = parent === null ? null : parent === "" ? it.name : `${parent}/${it.name}`;
		memo.set(id, p);
		return p;
	};

	const paths = new Map<string, T>();
	const duplicates: T[] = [];
	for (const it of items) {
		if (it.id === rootId) continue;
		const p = resolve(it.id, 0);
		if (p === null) continue;
		const existing = paths.get(p);
		if (!existing) {
			paths.set(p, it);
		} else if ((it.modifiedTime ?? "") > (existing.modifiedTime ?? "")) {
			duplicates.push(existing);
			paths.set(p, it);
		} else {
			duplicates.push(it);
		}
	}
	return { paths, duplicates };
}
