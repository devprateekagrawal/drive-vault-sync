import { Debouncer, Notice, Platform, Plugin, TAbstractFile, debounce } from "obsidian";
import { AuthError, GoogleAuth, PendingAuth, PROTOCOL_ACTION, TokenSet } from "./auth";
import { DriveClient } from "./drive";
import { Settings, SettingsTab, defaultSettings } from "./settings";
import { MassDeleteError, SyncEngine, SyncOptions, SyncResult, SyncState, emptyState } from "./sync";

interface PluginData {
	settings: Settings;
	tokens: TokenSet | null;
	pendingAuth: PendingAuth | null;
	state: SyncState;
}

type RunOptions = SyncOptions & { manual?: boolean };

export default class DriveVaultSync extends Plugin {
	data!: PluginData;
	auth!: GoogleAuth;
	engine!: SyncEngine;

	private running: Promise<void> | null = null;
	private queued: RunOptions | null = null;
	private statusEl: HTMLElement | null = null;
	private intervalId: number | null = null;
	private debounced: Debouncer<[], void> | null = null;
	private settingsTab!: SettingsTab;

	async onload(): Promise<void> {
		const saved = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.data = {
			settings: { ...defaultSettings(this.app.vault.getName(), Platform.isMobile), ...(saved.settings ?? {}) },
			tokens: saved.tokens ?? null,
			pendingAuth: saved.pendingAuth ?? null,
			state: { ...emptyState(), ...(saved.state ?? {}) },
		};

		this.auth = new GoogleAuth({
			config: () => this.data.settings,
			tokens: () => this.data.tokens,
			setTokens: async (t) => {
				this.data.tokens = t;
				await this.persist();
			},
			pending: () => this.data.pendingAuth,
			setPending: async (p) => {
				this.data.pendingAuth = p;
				await this.persist();
			},
		});
		this.engine = new SyncEngine(
			this.app,
			new DriveClient(this.auth),
			() => this.data.settings,
			() => this.data.state,
			() => this.persist(),
		);

		this.settingsTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, async (params) => {
			try {
				await this.auth.handleRedirect(params);
				new Notice("Drive Vault Sync: signed in to Google Drive.");
				this.settingsTab.display();
				void this.requestSync({ full: true, manual: true });
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e), 10000);
			}
		});

		this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => this.requestSync({ full: true, manual: true }));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.requestSync({ full: true, manual: true }) });
		this.addCommand({
			id: "sync-now-allow-deletes",
			name: "Sync now (allow deletes)",
			callback: () => this.requestSync({ full: true, manual: true, allowMassDelete: true }),
		});
		this.addCommand({
			id: "sign-in",
			name: "Sign in to Google Drive",
			callback: () => this.auth.startSignIn().catch((e) => new Notice(String(e?.message ?? e), 8000)),
		});

		if (!Platform.isMobile) this.statusEl = this.addStatusBarItem();
		this.setStatus(this.auth.isSignedIn() ? "Drive: ready" : "Drive: not signed in");

		// Register vault events only after load: Obsidian fires "create" for every file while indexing.
		this.app.workspace.onLayoutReady(() => {
			const changed = (f: TAbstractFile) => {
				if (this.engine.isSelfWrite(f.path)) return;
				this.engine.markDirty();
				if (this.data.settings.autoSync) this.debounced?.();
			};
			this.registerEvent(this.app.vault.on("create", changed));
			this.registerEvent(this.app.vault.on("modify", changed));
			this.registerEvent(this.app.vault.on("delete", changed));
			this.registerEvent(
				this.app.vault.on("rename", (f, oldPath) => {
					if (this.engine.isSelfWrite(f.path) || this.engine.isSelfWrite(oldPath)) return;
					this.data.state.pendingRenames.push({ from: oldPath, to: f.path });
					void this.persist();
					changed(f);
				}),
			);
			// Phone: sync when you come back to Obsidian, and try to push edits when you leave it.
			this.registerDomEvent(document, "visibilitychange", () => {
				if (this.data.settings.autoSync) void this.requestSync();
			});
			this.restartTimers();
			if (this.data.settings.autoSync) window.setTimeout(() => void this.requestSync({ full: true }), 2000);
		});
	}

	onunload(): void {
		this.debounced?.cancel();
	}

	async persist(): Promise<void> {
		await this.saveData(this.data);
	}

	restartTimers(): void {
		this.debounced?.cancel();
		this.debounced = debounce(() => void this.requestSync(), this.data.settings.debounceSeconds * 1000, true);
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		if (this.data.settings.autoSync) {
			this.intervalId = window.setInterval(() => {
				if (document.visibilityState === "visible") void this.requestSync();
			}, this.data.settings.intervalMinutes * 60 * 1000);
			this.registerInterval(this.intervalId);
		}
	}

	/** Runs one sync at a time; a request during a sync queues exactly one more run. */
	requestSync(opts: RunOptions = {}): Promise<void> {
		if (!this.auth.isSignedIn()) {
			if (opts.manual) new Notice("Drive Vault Sync: sign in first (Settings > Drive Vault Sync).");
			return Promise.resolve();
		}
		if (this.running) {
			const q = this.queued ?? {};
			this.queued = {
				full: q.full || opts.full,
				manual: q.manual || opts.manual,
				allowMassDelete: q.allowMassDelete || opts.allowMassDelete,
			};
			return this.running;
		}
		this.running = this.run(opts).finally(() => {
			this.running = null;
			const next = this.queued;
			this.queued = null;
			if (next) void this.requestSync(next);
		});
		return this.running;
	}

	private async run(opts: RunOptions): Promise<void> {
		this.setStatus("Drive: syncing…");
		try {
			const r = await this.engine.sync(opts);
			const summary = this.summarize(r);
			const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			if (!r.skipped) {
				this.data.state.lastResult = `${new Date().toLocaleString()} — ${summary}`;
				await this.persist();
			}
			this.setStatus(r.errors.length ? `Drive: ${r.errors.length} errors` : `Drive: synced ${time}`);
			if (opts.manual) new Notice(`Drive Vault Sync: ${summary}`);
			if (r.conflicts.length) {
				new Notice(
					`Drive Vault Sync: ${r.conflicts.length} note(s) were changed on both devices. Both versions are kept:\n` +
						r.conflicts.join("\n"),
					15000,
				);
			}
			if (r.errors.length) {
				console.error("[drive-vault-sync] errors", r.errors);
				new Notice(`Drive Vault Sync: ${r.errors.length} file(s) failed, will retry.\n${r.errors.slice(0, 3).join("\n")}`, 10000);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[drive-vault-sync]", e);
			if (e instanceof MassDeleteError || e instanceof AuthError) {
				this.setStatus("Drive: needs attention");
				new Notice(`Drive Vault Sync: ${msg}`, 20000);
			} else {
				// Most often: no internet. Stay quiet unless the user asked for this sync.
				this.setStatus("Drive: offline / error");
				if (opts.manual) new Notice(`Drive Vault Sync: ${msg}`, 8000);
			}
		}
	}

	private summarize(r: SyncResult): string {
		if (r.skipped) return "no changes";
		const parts: string[] = [];
		if (r.uploaded) parts.push(`${r.uploaded} up`);
		if (r.downloaded) parts.push(`${r.downloaded} down`);
		if (r.deletedLocal) parts.push(`${r.deletedLocal} removed here`);
		if (r.deletedRemote) parts.push(`${r.deletedRemote} removed on Drive`);
		if (r.conflicts.length) parts.push(`${r.conflicts.length} conflicts`);
		if (r.errors.length) parts.push(`${r.errors.length} errors`);
		return parts.length ? parts.join(", ") : "everything up to date";
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}
}
