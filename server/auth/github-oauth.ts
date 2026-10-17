/**
 * GitHub OAuth mechanics.
 *
 * Pure functions — no HTTP routes, no session state, no DB. Every
 * caller (routes in auth.ts) is responsible for their own flow control.
 *
 * Scope: read:user user:email — enough to identify the user and get
 * their verified primary email. No token is stored; the access token
 * is used once to fetch user info, then discarded.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_USER = 'https://api.github.com/user';
const GITHUB_API_EMAILS = 'https://api.github.com/user/emails';

const SCOPE = 'read:user user:email';

export interface GitHubUser {
  id: string;
  login: string;
  email: string | null;
  name: string | null;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

let cachedConfig: OAuthConfig | null = null;

function loadConfig(): OAuthConfig {
  if (cachedConfig) return cachedConfig;

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_OAUTH_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      '[github-oauth] Missing env vars. Set GITHUB_OAUTH_CLIENT_ID, ' +
      'GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_CALLBACK_URL.'
    );
  }

  cachedConfig = { clientId, clientSecret, callbackUrl };
  return cachedConfig;
}

/**
 * Whether OAuth is configured. Routes use this to decide whether to
 * expose the "Sign in with GitHub" button on the login page. Returns
 * false without throwing if env vars are missing.
 */
export function isGithubOAuthEnabled(): boolean {
  try {
    loadConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the URL to redirect the user to. `state` must be a one-time
 * token that we later verify in the callback (see oauth-state.ts).
 */
export function getAuthorizeUrl(state: string): string {
  const { clientId, callbackUrl } = loadConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: SCOPE,
    state,
    allow_signup: 'false', // B4: closed signup, only existing users
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the OAuth `code` for an access token. Throws on any
 * non-success response — the error message is safe to log (contains
 * GitHub's error reason, not the secret).
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const { clientId, clientSecret, callbackUrl } = loadConfig();

  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`[github-oauth] token exchange failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.access_token) {
    throw new Error(
      `[github-oauth] token exchange failed: ${data.error || 'no access_token'}`
    );
  }

  return data.access_token;
}

/**
 * Fetch the authenticated user's identity. Combines /user and
 * /user/emails — the second call is needed because /user's `email`
 * field is null when the user has set a private email.
 *
 * Returns a verified primary email if GitHub exposes one. Never returns
 * an unverified email.
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'CodeTeach-OAuth',
  };

  const userRes = await fetch(GITHUB_API_USER, { headers });
  if (!userRes.ok) {
    throw new Error(`[github-oauth] user fetch failed: HTTP ${userRes.status}`);
  }

  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
  };

  // /user's email is null for private-email users. Try /user/emails.
  let email: string | null = user.email;

  if (!email) {
    try {
      const emailsRes = await fetch(GITHUB_API_EMAILS, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        if (primary) email = primary.email;
      }
    } catch {
      // Non-fatal — fall through with email = null
    }
  }

  return {
    id: String(user.id),
    login: user.login,
    email,
    name: user.name,
  };
}
