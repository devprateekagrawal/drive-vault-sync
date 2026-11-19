# Drive Vault Sync

Free, two-way, automatic sync of an Obsidian vault with a folder in **your own Google Drive**.
Works on desktop (Windows/Mac/Linux) and Android (iOS should work too, untested).

Write a note on the desktop → open Obsidian on the phone → it's there. Edit it on the phone → open the desktop → the edit is there. All folders, subfolders, notes and attachments sync.

## How it works

- Each device compares three things per file: **this device**, **Drive**, and **what both agreed on last time**. That tells it which side changed, so it never guesses from clocks.
- Changed on one side → copied to the other. Deleted on one side and untouched on the other → deleted (to the trash, never permanently).
- **Changed on both sides before a sync** → both versions kept: Drive's stays as `idea.md`, this device's becomes `idea (conflict 2026-11-19 153005 phone).md`. Nothing is ever silently overwritten.
- Renaming a folder moves it on Drive in one step (no re-upload).
- If a sync would delete more files than your safety limit (default 25), it stops and changes nothing.

### When it syncs
- When Obsidian opens, and when you switch back to it.
- A few seconds after you stop typing (default 8 s).
- Every minute while Obsidian is open (a quiet check costs one tiny request).
- When you switch away from Obsidian (it tries to push your last edit).
- Ribbon button / command **Sync now** any time.

**Real limit:** Android does not let apps sync in the background. On the phone, sync happens while Obsidian is open. Open the app, wait a second or two, and your notes are current. Obsidian's paid Sync has the same limit.

## One-time setup (about 20 minutes)

You create your own free Google "app". Your notes only go between your devices and your own Drive, under your own quota. No third party is involved and it stays free.

### 1. Google Cloud project
1. Go to <https://console.cloud.google.com/> and create a project (e.g. `drive-vault-sync`).
2. **APIs & Services → Library →** search **Google Drive API → Enable**.
3. **Google Auth Platform** (OAuth consent screen):
   - **Branding:** app name `Drive Vault Sync`, your email as support and developer contact.
   - **Audience:** User type **External**. Then press **Publish app** so the status is **In production**.
     ⚠️ If you leave it in *Testing*, Google logs you out every 7 days.
   - **Data access → Add scopes:** `https://www.googleapis.com/auth/drive.file` only. Google rates this scope non-sensitive, so no review is needed.
4. **Clients → Create client → Web application.**
   - Authorized redirect URI: your page from step 2 below, e.g. `https://YOURNAME.github.io/drive-vault-sync/`
   - Copy the **Client ID** and **Client secret**.

### 2. Redirect page (free, GitHub Pages)
Google can't send you straight back into Obsidian, so a tiny page (`docs/index.html`) passes the sign-in code to `obsidian://drive-vault-sync-auth`. It stores nothing.
1. Push this repo to GitHub (it can be public; it contains no secrets).
2. Repo **Settings → Pages → Deploy from a branch → `main` / `/docs`**.
3. Your redirect URL is `https://YOURNAME.github.io/drive-vault-sync/`. It must match step 1.4 exactly, including the trailing `/`.

### 3. Install the plugin
Run `npm install` and `npm run build`, which produce `main.js`. Then copy **`main.js` + `manifest.json`** into:

- **Desktop:** `<your vault>/.obsidian/plugins/drive-vault-sync/`
- **Android:** the same folder inside the phone's vault (for example via USB). The easier way: create a GitHub release that has `main.js` and `manifest.json` attached, install the **BRAT** community plugin on the phone, and add your repo in BRAT. BRAT also installs future updates.

Turn it on under **Settings → Community plugins**.

### 4. Settings (on each device)
1. Paste the **Client ID**, **Client secret** and **Redirect URL**.
2. **Drive folder name:** the **same name on every device**, e.g. `Obsidian Vault`.
3. Tap **Sign in with Google**. The browser opens; choose your account and press Allow. If Google shows "hasn't verified this app", that is your own app: choose *Advanced → Go to Drive Vault Sync*. You are sent back to Obsidian and the first sync starts.

Do the desktop first (it uploads the vault). Then on the phone, make a new **empty** vault, install the plugin, use the same settings and sign in. It downloads everything.

## Good to know
- **Edit notes through Obsidian only.** With the `drive.file` permission, the plugin can only see files it uploaded itself. A file you drop into the Drive folder through drive.google.com won't be seen. Add it through Obsidian instead.
- The `.obsidian` folder (themes, plugins, settings) is not synced, so each device keeps its own.
- Deleted files go to the vault's `.trash` folder or to Drive's trash (kept 30 days).
- Avoid two files whose names differ only in capital letters (`Idea.md` and `idea.md`). Windows treats them as one file, Android as two.
- **Reset sync memory** (in settings) is safe: it re-compares everything and only makes conflict copies, never deletes.

## Development
```
npm install
npm run dev     # rebuilds main.js on change
npm run build   # type-check + production build
npm test        # unit tests for the sync rules (src/plan.ts)
```
Code map: `src/plan.ts` sync rules (pure, tested) · `src/sync.ts` engine · `src/drive.ts` Drive REST client · `src/auth.ts` Google sign-in (PKCE) · `src/main.ts` triggers, commands, status · `src/settings.ts` settings screen.
