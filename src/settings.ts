import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveVaultSync from "./main";
import { emptyState } from "./sync";

export interface Settings {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	remoteFolderName: string;
	deviceName: string;
	autoSync: boolean;
	intervalMinutes: number;
	debounceSeconds: number;
	ignorePatterns: string;
	massDeleteLimit: number;
}

export function defaultSettings(vaultName: string, isMobile: boolean): Settings {
	return {
		clientId: "",
		clientSecret: "",
		redirectUri: "",
		remoteFolderName: vaultName,
		deviceName: isMobile ? "phone" : "desktop",
		autoSync: true,
		intervalMinutes: 1,
		debounceSeconds: 8,
		ignorePatterns: "# One per line. Folder: Name/   Glob: *.tmp   Exact: path/file.md\n",
		massDeleteLimit: 25,
	};
}

export class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: DriveVaultSync) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.data.settings;
		containerEl.empty();

		// --- Account ---
		new Setting(containerEl).setName("Google account").setHeading();
		const signedIn = p.auth.isSignedIn();
		new Setting(containerEl)
			.setName(signedIn ? "Signed in to Google Drive" : "Not signed in")
			.setDesc(
				signedIn
					? "This device has its own sign-in. It is stored only on this device and never synced."
					: "Fill in the three fields below first, then sign in. A browser opens; after you allow access it returns you to Obsidian.",
			)
			.addButton((b) =>
				signedIn
					? b.setButtonText("Sign out").onClick(async () => {
							await p.auth.signOut();
							this.display();
						})
					: b
							.setButtonText("Sign in with Google")
							.setCta()
							.onClick(async () => {
								try {
									await p.auth.startSignIn();
								} catch (e) {
									new Notice(e instanceof Error ? e.message : String(e), 8000);
								}
							}),
			);

		const text = (name: string, desc: string, key: "clientId" | "clientSecret" | "redirectUri", secret = false) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v.trim();
						await p.persist();
					});
					if (secret) t.inputEl.type = "password";
				});
		text("Client ID", "From your Google Cloud project: APIs & Services > Credentials > OAuth client (Web application).", "clientId");
		text("Client secret", "From the same OAuth client.", "clientSecret", true);
		text("Redirect URL", "Your GitHub Pages address for docs/auth/, e.g. https://you.github.io/drive-vault-sync/auth/", "redirectUri");

		// --- Sync ---
		new Setting(containerEl).setName("Sync").setHeading();
		new Setting(containerEl)
			.setName("Drive folder name")
			.setDesc("Folder at the top of your Google Drive that holds this vault. Use the SAME name on every device. Changing it starts fresh with a new folder.")
			.addText((t) =>
				t.setValue(s.remoteFolderName).onChange(async (v) => {
					s.remoteFolderName = v.trim();
					await p.persist();
				}),
			);
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Used in conflict copy names, e.g. \"idea (conflict 2026-11-19 153000 phone).md\".")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim() || "device";
					await p.persist();
				}),
			);
		new Setting(containerEl)
			.setName("Sync automatically")
			.setDesc("On open, a few seconds after you stop typing, every interval while Obsidian is open, and when you switch away from Obsidian.")
			.addToggle((t) =>
				t.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await p.persist();
					p.restartTimers();
				}),
			);
		new Setting(containerEl)
			.setName("Check Drive every (minutes)")
			.setDesc("While Obsidian is open. A check with no changes costs one small request.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 30, 1)
					.setValue(s.intervalMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.intervalMinutes = v;
						await p.persist();
						p.restartTimers();
					}),
			);
		new Setting(containerEl)
			.setName("Upload after you stop typing for (seconds)")
			.addSlider((sl) =>
				sl
					.setLimits(2, 60, 1)
					.setValue(s.debounceSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.debounceSeconds = v;
						await p.persist();
						p.restartTimers();
					}),
			);
		new Setting(containerEl)
			.setName("Ignore")
			.setDesc("Paths never synced. The .obsidian config folder is always skipped.")
			.addTextArea((t) => {
				t.setValue(s.ignorePatterns).onChange(async (v) => {
					s.ignorePatterns = v;
					await p.persist();
				});
				t.inputEl.rows = 5;
				t.inputEl.style.width = "100%";
			});
		new Setting(containerEl)
			.setName("Safety limit for deletes")
			.setDesc("If one sync would delete more files than this, it stops and changes nothing. Use the command \"Sync now (allow deletes)\" when you really meant it.")
			.addText((t) =>
				t.setValue(String(s.massDeleteLimit)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 0) {
						s.massDeleteLimit = n;
						await p.persist();
					}
				}),
			);

		// --- Status ---
		new Setting(containerEl).setName("Status").setHeading();
		new Setting(containerEl)
			.setName("Last sync")
			.setDesc(p.data.state.lastResult ?? "Never")
			.addButton((b) =>
				b.setButtonText("Sync now").onClick(async () => {
					await p.requestSync({ full: true, manual: true });
					this.display();
				}),
			);
		new Setting(containerEl)
			.setName("Reset sync memory")
			.setDesc("Forgets what was synced before. The next sync compares everything fresh: identical files are left alone, different ones get a conflict copy. Nothing is deleted.")
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						const keep = p.data.state;
						p.data.state = { ...emptyState(), rootFolderId: keep.rootFolderId, rootFolderName: keep.rootFolderName };
						await p.persist();
						new Notice("Sync memory reset.");
						this.display();
					}),
			);
	}
}
