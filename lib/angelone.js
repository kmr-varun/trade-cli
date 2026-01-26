import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { SmartAPI } from 'smartapi-javascript';

const ROOT = process.cwd();
const SESSION_FILE = path.join(ROOT, 'angelone-session.json');

const apiKey = process.env.ANGELONE_API_KEY;
const clientCode = process.env.ANGELONE_CLIENT_CODE;
const password = process.env.ANGELONE_PASSWORD;

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

async function promptTOTP() {
  const { totp } = await inquirer.prompt({
    name: 'totp',
    message: 'Enter Angel One TOTP:'
  });
  return totp;
}

async function freshLogin(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const totp = await promptTOTP();

    smartApi = new SmartAPI({ api_key: apiKey });

    try {
      const session = await smartApi.generateSession(clientCode, password, totp);

      if (!session.status) {
        console.log(`Login failed: ${session.message}`);
        if (attempt < maxAttempts) {
          console.log(`Attempt ${attempt}/${maxAttempts}. Please try again.`);
          continue;
        }
        throw new Error(`Login failed after ${maxAttempts} attempts: ${session.message}`);
      }

      const tokens = {
        accessToken: session.data.jwtToken,
        refreshToken: session.data.refreshToken,
        feedToken: session.data.feedToken,
        createdAt: new Date().toISOString()
      };

      writeSession(tokens);
      console.log('Angel One login successful');

      return smartApi;
    } catch (err) {
      if (err.message.includes('Login failed after')) throw err;
      console.log(`Login error: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log(`Attempt ${attempt}/${maxAttempts}. Please try again.`);
        continue;
      }
      throw new Error(`Login failed after ${maxAttempts} attempts: ${err.message}`);
    }
  }
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
  if (!apiKey || !clientCode || !password) {
    throw new Error(
      'Missing ANGELONE_API_KEY, ANGELONE_CLIENT_CODE, or ANGELONE_PASSWORD in .env'
    );
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
    if (await tryRefreshToken(saved)) {
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
