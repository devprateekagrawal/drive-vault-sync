import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaths, compileIgnore, conflictPath, planFile, planFolder, remapPrefix } from "../src/plan";

test("planFile: your scenario — note made on desktop, read and edited on phone", () => {
	// Desktop creates note: only local, never synced -> upload
	assert.equal(planFile("A", undefined, undefined), "upload");
	// Phone has never seen it -> download
	assert.equal(planFile(undefined, "A", undefined), "download");
	// Phone edits it (local B, Drive still A, base A) -> upload
	assert.equal(planFile("B", "A", "A"), "upload");
	// Back on desktop (local A, Drive B, base A) -> download
	assert.equal(planFile("A", "B", "A"), "download");
	// Already equal
	assert.equal(planFile("B", "B", "A"), "none");
	assert.equal(planFile("B", "B", undefined), "none");
});

test("planFile: deletes only when the other side is unchanged", () => {
	assert.equal(planFile("A", undefined, "A"), "deleteLocal");
	assert.equal(planFile(undefined, "A", "A"), "deleteRemote");
	// deleted on one side but edited on the other -> the edit wins, nothing lost
	assert.equal(planFile("B", undefined, "A"), "upload");
	assert.equal(planFile(undefined, "B", "A"), "download");
	assert.equal(planFile(undefined, undefined, "A"), "forget");
});

test("planFile: edited on both sides -> conflict, never overwrite", () => {
	assert.equal(planFile("B", "C", "A"), "conflict");
	assert.equal(planFile("B", "C", undefined), "conflict");
});

test("planFolder", () => {
	assert.equal(planFolder(true, true, false), "none");
	assert.equal(planFolder(true, false, false), "createRemote");
	assert.equal(planFolder(false, true, false), "createLocal");
	assert.equal(planFolder(true, false, true), "deleteLocal");
	assert.equal(planFolder(false, true, true), "deleteRemote");
	assert.equal(planFolder(false, false, true), "forget");
});

test("remapPrefix handles folder renames without touching look-alike names", () => {
	assert.equal(remapPrefix("Work/a.md", "Work", "Job"), "Job/a.md");
	assert.equal(remapPrefix("Work", "Work", "Job"), "Job");
	assert.equal(remapPrefix("Work/sub/x.png", "Work", "Archive/Work"), "Archive/Work/sub/x.png");
	assert.equal(remapPrefix("Workshop/a.md", "Work", "Job"), null);
});

test("conflictPath", () => {
	const d = new Date(2026, 10, 19, 15, 30, 5);
	assert.equal(conflictPath("notes/idea.md", "phone", d), "notes/idea (conflict 2026-11-19 153005 phone).md");
	assert.equal(conflictPath("idea.md", "my/pc", d), "idea (conflict 2026-11-19 153005 my-pc).md");
	assert.equal(conflictPath("Makefile", "pc", d), "Makefile (conflict 2026-11-19 153005 pc)");
	assert.equal(conflictPath("a.b/.x", "pc", d), "a.b/.x (conflict 2026-11-19 153005 pc)");
});

test("compileIgnore", () => {
	const ig = compileIgnore("# comment\nTemplates/\n*.tmp\nprivate/**/*.pdf\nsecret.md\n");
	assert.ok(ig("Templates"));
	assert.ok(ig("Templates/daily.md"));
	assert.ok(!ig("TemplatesOld/x.md"));
	assert.ok(ig("deep/folder/file.tmp"));
	assert.ok(ig("private/a/b/c.pdf"));
	assert.ok(!ig("private/c.md"));
	assert.ok(ig("secret.md"));
	assert.ok(!ig("dir/secret.md"));
	assert.ok(!compileIgnore("")("anything.md"));
});

test("buildPaths: nested folders, outside items, duplicates", () => {
	const items = [
		{ id: "f1", name: "Projects", parents: ["root"] },
		{ id: "f2", name: "Router", parents: ["f1"] },
		{ id: "n1", name: "plan.md", parents: ["f2"], modifiedTime: "2026-01-01" },
		{ id: "n2", name: "plan.md", parents: ["f2"], modifiedTime: "2026-02-01" },
		{ id: "n3", name: "top.md", parents: ["root"] },
		{ id: "x", name: "elsewhere.md", parents: ["otherFolder"] },
		{ id: "root", name: "MyVault", parents: ["driveRoot"] },
	];
	const { paths, duplicates } = buildPaths("root", items);
	assert.equal(paths.get("Projects")?.id, "f1");
	assert.equal(paths.get("Projects/Router")?.id, "f2");
	assert.equal(paths.get("Projects/Router/plan.md")?.id, "n2"); // newest wins
	assert.equal(paths.get("top.md")?.id, "n3");
	assert.equal(duplicates.map((d) => d.id).join(), "n1");
	assert.ok(![...paths.values()].some((v) => v.id === "x" || v.id === "root"));
});

test("simulated two-device round trip converges", () => {
	// Minimal simulator of the 3-way rule over one file, to check repeated syncs settle.
	type Side = { local?: string; base?: string };
	let drive: string | undefined;
	const desktop: Side = {};
	const phone: Side = {};
	const sync = (d: Side) => {
		const a = planFile(d.local, drive, d.base);
		if (a === "upload") drive = d.local;
		if (a === "download") d.local = drive;
		if (a === "deleteLocal") d.local = undefined;
		if (a === "deleteRemote") drive = undefined;
		d.base = d.local === drive ? d.local : d.base;
		if (a === "forget") d.base = undefined;
		return a;
	};
	desktop.local = "v1";
	assert.equal(sync(desktop), "upload");
	assert.equal(sync(phone), "download");
	phone.local = "v2";
	assert.equal(sync(phone), "upload");
	assert.equal(sync(desktop), "download");
	assert.equal(desktop.local, "v2");
	assert.equal(sync(desktop), "none");
	assert.equal(sync(phone), "none");
	desktop.local = undefined; // delete on desktop
	assert.equal(sync(desktop), "deleteRemote");
	assert.equal(sync(phone), "deleteLocal");
	assert.equal(phone.local, undefined);
});
