import { Notice, requestUrl } from "obsidian";

// Google OAuth 2.0 "authorization code + PKCE" flow, the same on desktop and Android:
//   1. Open the system browser at Google's consent page.
//   2. Google redirects to your static redirect page (docs/index.html on GitHub Pages).
//   3. That page forwards to obsidian://drive-vault-sync-auth?code=...&state=...
//   4. Obsidian hands the code to this plugin, which trades it for tokens.
// The refresh token is kept in this device's plugin data (.obsidian/plugins/drive-vault-sync/data.json),
// which is never synced, so each device signs in once on its own.

export const PROTOCOL_ACTION = "drive-vault-sync-auth";
// drive.file = only files this app created. Google rates it non-sensitive, so no security review is needed.
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface AuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export interface TokenSet {
	accessToken: string;
	expiresAt: number; // ms epoch
	refreshToken: string;
}

export interface PendingAuth {
	state: string;
	verifier: string;
	createdAt: number;
}

export interface AuthStore {
	config(): AuthConfig;
	tokens(): TokenSet | null;
	setTokens(t: TokenSet | null): Promise<void>;
	pending(): PendingAuth | null;
	setPending(p: PendingAuth | null): Promise<void>;
}

export class AuthError extends Error {}

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 48): string {
	const a = new Uint8Array(bytes);
	crypto.getRandomValues(a);
	return b64url(a);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

function form(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

export class GoogleAuth {
	private refreshing: Promise<string> | null = null;

	constructor(private store: AuthStore) {}

	isSignedIn(): boolean {
		return !!this.store.tokens()?.refreshToken;
	}

	private checkConfig(): AuthConfig {
		const c = this.store.config();
		if (!c.clientId || !c.clientSecret || !c.redirectUri) {
			throw new AuthError("Fill in Client ID, Client secret and Redirect URL in the plugin settings first.");
		}
		return c;
	}

	async startSignIn(): Promise<void> {
		const c = this.checkConfig();
		const verifier = randomString(48);
		const state = randomString(16);
		// Saved to disk: Android may close Obsidian while the browser is open.
		await this.store.setPending({ state, verifier, createdAt: Date.now() });
		const url =
			"https://accounts.google.com/o/oauth2/v2/auth?" +
			form({
				client_id: c.clientId,
				redirect_uri: c.redirectUri,
				response_type: "code",
				scope: SCOPE,
				access_type: "offline", // ask for a refresh token
				prompt: "consent", // always return a refresh token, even on a second sign-in
				code_challenge: await pkceChallenge(verifier),
				code_challenge_method: "S256",
				state,
			});
		window.open(url);
	}

	/** Called from the obsidian:// protocol handler. */
	async handleRedirect(params: Record<string, string>): Promise<void> {
		if (params.error) throw new AuthError(`Google sign-in failed: ${params.error}`);
		const pending = this.store.pending();
		if (!pending || pending.state !== params.state) {
			throw new AuthError("This sign-in link is not the one this device started. Tap Sign in again.");
		}
		if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
			await this.store.setPending(null);
			throw new AuthError("Sign-in took longer than 15 minutes. Tap Sign in again.");
		}
		if (!params.code) throw new AuthError("Google did not return a sign-in code.");
		const c = this.checkConfig();
		const res = await requestUrl({
			url: "https://oauth2.googleapis.com/token",
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: form({
				code: params.code,
				client_id: c.clientId,
				client_secret: c.clientSecret,
				redirect_uri: c.redirectUri,
				grant_type: "authorization_code",
				code_verifier: pending.verifier,
			}),
			throw: false,
		});
		await this.store.setPending(null);
		if (res.status !== 200) throw new AuthError(`Token exchange failed (${res.status}): ${res.text}`);
		const j = res.json;
		if (!j.refresh_token) {
			throw new AuthError("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and sign in again.");
		}
		await this.store.setTokens({
			accessToken: j.access_token,
			expiresAt: Date.now() + (j.expires_in - 60) * 1000,
			refreshToken: j.refresh_token,
		});
	}

	async signOut(): Promise<void> {
		const t = this.store.tokens();
		await this.store.setTokens(null);
		if (t?.refreshToken) {
			// Best effort: tell Google to drop this device's token too.
			try {
				await requestUrl({
					url: "https://oauth2.googleapis.com/revoke",
					method: "POST",
					contentType: "application/x-www-form-urlencoded",
					body: form({ token: t.refreshToken }),
					throw: false,
				});
			} catch {
				/* offline: the token is already gone locally */
			}
		}
	}

	/** Returns a valid access token, refreshing it when it is about to expire. */
	async accessToken(forceRefresh = false): Promise<string> {
		const t = this.store.tokens();
		if (!t) throw new AuthError("Not signed in to Google Drive.");
		if (!forceRefresh && t.accessToken && Date.now() < t.expiresAt) return t.accessToken;
		if (!this.refreshing) {
			this.refreshing = this.refresh(t).finally(() => (this.refreshing = null));
		}
		return this.refreshing;
	}

	private async refresh(t: TokenSet): Promise<string> {
		const c = this.checkConfig();
		const res = await requestUrl({
			url: "https://oauth2.googleapis.com/token",
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: form({
				client_id: c.clientId,
				client_secret: c.clientSecret,
				refresh_token: t.refreshToken,
				grant_type: "refresh_token",
			}),
			throw: false,
		});
		if (res.status === 400 || res.status === 401) {
			// invalid_grant: token revoked, or expired because the Google app is still in "Testing".
			await this.store.setTokens(null);
			new Notice("Drive Vault Sync: Google sign-in expired. Sign in again in the plugin settings.", 10000);
			throw new AuthError(`Sign-in expired (${res.text})`);
		}
		if (res.status !== 200) throw new Error(`Token refresh failed (${res.status})`);
		const j = res.json;
		await this.store.setTokens({
			accessToken: j.access_token,
			expiresAt: Date.now() + (j.expires_in - 60) * 1000,
			refreshToken: j.refresh_token ?? t.refreshToken,
		});
		return j.access_token;
	}
}
