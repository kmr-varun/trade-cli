import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { SmartAPI } from 'smartapi-javascript';
import open from 'open';

const ROOT = process.cwd();
const SESSION_FILE = path.join(ROOT, 'angelone-session.json');

const apiKey = process.env.ANGELONE_API_KEY;
const clientCode = process.env.ANGELONE_CLIENT_CODE;

// Publisher login URL for OAuth-style authentication
const LOGIN_URL = `https://smartapi.angelone.in/publisher-login/?api_key=${apiKey}&state=statevariable`;

let smartApi = null;

function readSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSession(data) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

/**
 * Extract tokens from the redirect URL after publisher login
 * Expected format: https://...?auth_token=xxx&refresh_token=xxx&feed_token=xxx
 */
function extractTokensFromUrl(redirectUrl) {
  try {
    const url = new URL(redirectUrl);
    const params = url.searchParams;

    const authToken = params.get('auth_token');
    const refreshToken = params.get('refresh_token');
    const feedToken = params.get('feed_token');

    if (!authToken) {
      throw new Error('auth_token not found in redirect URL');
    }

    return {
      accessToken: authToken,
      refreshToken: refreshToken || '',
      feedToken: feedToken || '',
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    throw new Error(`Failed to parse redirect URL: ${err.message}`);
  }
}

async function freshLogin() {
  console.log('\nOpening Angel One login page in your browser...');
  console.log(`URL: ${LOGIN_URL}\n`);

  // Try to open the URL in default browser
  try {
    await open(LOGIN_URL);
  } catch {
    console.log('Could not open browser automatically. Please open the URL manually.');
  }

  console.log('After logging in, you will be redirected to a URL containing your tokens.');
  console.log('Please copy and paste the full redirect URL below:\n');

  const { redirectUrl } = await inquirer.prompt({
    name: 'redirectUrl',
    message: 'Paste redirect URL:'
  });

  const tokens = extractTokensFromUrl(redirectUrl.trim());

  // Initialize SmartAPI with the extracted tokens
  smartApi = new SmartAPI({
    api_key: apiKey,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken
  });

  // Verify the tokens work
  try {
    const profile = await smartApi.getProfile();
    if (!profile.status) {
      throw new Error(profile.message || 'Profile fetch failed');
    }
    console.log(`Logged in as: ${profile.data.name || clientCode}`);
  } catch (err) {
    throw new Error(`Token verification failed: ${err.message}`);
  }

  writeSession(tokens);
  console.log('Angel One login successful');

  return smartApi;
}

async function tryRefreshToken(saved) {
  try {
    smartApi = new SmartAPI({
      api_key: apiKey,
      access_token: saved.accessToken,
      refresh_token: saved.refreshToken
    });

    const refreshed = await smartApi.generateToken(saved.refreshToken);

    if (refreshed.status) {
      const tokens = {
        accessToken: refreshed.data.jwtToken,
        refreshToken: refreshed.data.refreshToken,
        feedToken: refreshed.data.feedToken || saved.feedToken,
        createdAt: new Date().toISOString()
      };

      writeSession(tokens);
      console.log('Angel One token refreshed');
      return true;
    }
  } catch {
    // Refresh failed, will need fresh login
  }
  return false;
}

async function verifySession() {
  try {
    const profile = await smartApi.getProfile();
    return profile.status === true;
  } catch {
    return false;
  }
}

export async function initializeSmartAPI() {
  if (!apiKey) {
    throw new Error('Missing ANGELONE_API_KEY in .env');
  }

  const saved = readSession();

  if (saved?.accessToken) {
    // Try to use existing session
    smartApi = new SmartAPI({
      api_key: apiKey,
      access_token: saved.accessToken,
      refresh_token: saved.refreshToken
    });

    if (await verifySession()) {
      console.log('Angel One session restored');
      return smartApi;
    }

    // Session expired, try refresh
    if (saved.refreshToken && await tryRefreshToken(saved)) {
      if (await verifySession()) {
        return smartApi;
      }
    }

    console.log('Session expired, need fresh login');
  }

  // No saved session or refresh failed
  return freshLogin();
}

export function getSmartAPI() {
  if (!smartApi) {
    throw new Error('SmartAPI not initialized. Call initializeSmartAPI() first.');
  }
  return smartApi;
}

export async function placeOrder(params) {
  const api = getSmartAPI();
  return api.placeOrder(params);
}
