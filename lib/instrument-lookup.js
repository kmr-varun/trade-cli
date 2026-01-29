import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CACHE_FILE = path.join(ROOT, 'instruments-cache.json');
const INSTRUMENTS_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let instrumentsBySymbol = new Map();
let instrumentsByToken = new Map();
let nfoInstruments = [];

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
  nfoInstruments = [];

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

    // Store NFO instruments separately for option lookup
    if (inst.exch_seg === 'NFO') {
      nfoInstruments.push(inst);
    }
  }

  console.log(`Indexed ${nfoInstruments.length} NFO instruments`);
}

export async function initializeInstruments() {
  // Always download fresh instruments data on startup
  const instruments = await downloadInstruments();
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

/**
 * Look up an option contract in NFO
 *
 * @param {string} symbol - Base symbol (e.g., HINDZINC)
 * @param {number} strike - Strike price (e.g., 750)
 * @param {string} optionType - CE or PE
 * @param {string} expiry - Month abbreviation (e.g., FEB)
 * @returns {object|null} Instrument with symbol and token
 */
export function lookupOption(symbol, strike, optionType, expiry) {
  // Build the expected trading symbol pattern
  // Format: {SYMBOL}{YY}{MON}{STRIKE}{CE/PE}
  // Example: HINDZINC26FEB750CE
  const year = new Date().getFullYear().toString().slice(-2);
  const strikeStr = Number.isInteger(strike) ? strike.toString() : strike.toFixed(0);
  const expectedSymbol = `${symbol}${year}${expiry}${strikeStr}${optionType}`;

  // First try exact match
  const exactKey = `NFO:${expectedSymbol}`;
  const exact = instrumentsBySymbol.get(exactKey);
  if (exact) {
    return exact;
  }

  // Search in NFO instruments for matching option
  // Angel One symbol format might vary, so search flexibly
  const symbolUpper = symbol.toUpperCase();
  const optionTypeUpper = optionType.toUpperCase();
  const expiryUpper = expiry.toUpperCase();

  for (const inst of nfoInstruments) {
    const instSymbol = inst.symbol || '';
    const instName = inst.name || '';

    // Check if this is an option (OPTSTK or OPTIDX)
    if (inst.instrumenttype !== 'OPTSTK' && inst.instrumenttype !== 'OPTIDX') {
      continue;
    }

    // Check symbol contains base name
    if (!instSymbol.includes(symbolUpper) && !instName.includes(symbolUpper)) {
      continue;
    }

    // Check option type (CE/PE)
    if (!instSymbol.endsWith(optionTypeUpper)) {
      continue;
    }

    // Check strike price
    if (inst.strike && parseFloat(inst.strike) / 100 !== strike) {
      // Angel One stores strike * 100
      continue;
    }

    // Check expiry month
    if (!instSymbol.includes(expiryUpper)) {
      continue;
    }

    return inst;
  }

  // Try alternative: search by parts
  for (const inst of nfoInstruments) {
    if (inst.instrumenttype !== 'OPTSTK' && inst.instrumenttype !== 'OPTIDX') {
      continue;
    }

    const instSymbol = (inst.symbol || '').toUpperCase();

    // Match pattern: starts with symbol, has year, month, strike, and option type
    if (
      instSymbol.startsWith(symbolUpper) &&
      instSymbol.includes(year) &&
      instSymbol.includes(expiryUpper) &&
      instSymbol.includes(strikeStr) &&
      instSymbol.endsWith(optionTypeUpper)
    ) {
      return inst;
    }
  }

  return null;
}

/**
 * Get lot size for an instrument
 * @param {object} instrument - Instrument object from lookup
 * @returns {number} Lot size (default 1)
 */
export function getLotSize(instrument) {
  if (!instrument) return 1;
  return parseInt(instrument.lotsize, 10) || 1;
}
