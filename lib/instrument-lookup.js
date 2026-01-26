import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CACHE_FILE = path.join(ROOT, 'instruments-cache.json');
const INSTRUMENTS_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let instrumentsBySymbol = new Map();
let instrumentsByToken = new Map();

function isCacheValid() {
  if (!fs.existsSync(CACHE_FILE)) return false;

  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(cache.timestamp).getTime();
    return age < CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function downloadInstruments() {
  console.log('Downloading instrument master...');

  const res = await fetch(INSTRUMENTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to download instruments: ${res.status}`);
  }

  const instruments = await res.json();

  const cache = {
    timestamp: new Date().toISOString(),
    instruments
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`Cached ${instruments.length} instruments`);

  return instruments;
}

function loadFromCache() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  console.log(`Loaded ${cache.instruments.length} instruments from cache`);
  return cache.instruments;
}

function buildLookupMaps(instruments) {
  instrumentsBySymbol.clear();
  instrumentsByToken.clear();

  for (const inst of instruments) {
    // Key: EXCHANGE:SYMBOL (e.g., NSE:RELIANCE-EQ)
    const key = `${inst.exch_seg}:${inst.symbol}`;
    instrumentsBySymbol.set(key, inst);

    // Also key by token
    instrumentsByToken.set(inst.token, inst);

    // For NSE equity, also index by trading symbol without -EQ suffix
    if (inst.exch_seg === 'NSE' && inst.symbol.endsWith('-EQ')) {
      const shortKey = `NSE:${inst.symbol.replace('-EQ', '')}`;
      if (!instrumentsBySymbol.has(shortKey)) {
        instrumentsBySymbol.set(shortKey, inst);
      }
    }
  }
}

export async function initializeInstruments() {
  let instruments;

  if (isCacheValid()) {
    instruments = loadFromCache();
  } else {
    instruments = await downloadInstruments();
  }

  buildLookupMaps(instruments);
}

export function lookupInstrument(symbol, exchange = 'NSE') {
  // Try exact match with exchange
  let key = `${exchange}:${symbol}`;
  let inst = instrumentsBySymbol.get(key);
  if (inst) return inst;

  // Try with -EQ suffix for NSE
  if (exchange === 'NSE') {
    key = `NSE:${symbol}-EQ`;
    inst = instrumentsBySymbol.get(key);
    if (inst) return inst;
  }

  // Try BSE if NSE not found
  if (exchange === 'NSE') {
    key = `BSE:${symbol}`;
    inst = instrumentsBySymbol.get(key);
    if (inst) return inst;
  }

  return null;
}

export function lookupByToken(token) {
  return instrumentsByToken.get(token) || null;
}
