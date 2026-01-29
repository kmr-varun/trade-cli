/**
 * Parse options trading signals from Telegram messages.
 *
 * Entry Signal Format (multi-line):
 *   BUY HINDZINC
 *   750 CE ABOVE 33
 *   SL 30.5 TARGET 36 40
 *   FEBRUARY SERIES
 *
 * Reply Message Formats:
 *   36.4, BOOK OR TRAIL     -> Book profit / exit
 *   CLOSE NEAR COST         -> Exit at entry price
 *   WAIT TO ACTIVATE        -> Set status to WAITING
 *   FOLLOW IT               -> No action needed
 *   SL                      -> Stop loss hit, exit immediately
 *   BUY AT CMP 58, SL 53    -> Revised entry with new SL
 */

// Month name to abbreviation mapping
const MONTH_MAP = {
  JANUARY: 'JAN',
  FEBRUARY: 'FEB',
  MARCH: 'MAR',
  APRIL: 'APR',
  MAY: 'MAY',
  JUNE: 'JUN',
  JULY: 'JUL',
  AUGUST: 'AUG',
  SEPTEMBER: 'SEP',
  OCTOBER: 'OCT',
  NOVEMBER: 'NOV',
  DECEMBER: 'DEC'
};

/**
 * Parse multi-line options entry signal
 * @param {string} message - Raw message text
 * @param {number} messageId - Telegram message ID
 * @returns {object|null} Parsed signal or null if not a valid signal
 */
export function parseOptionsSignal(message, messageId) {
  if (!message || typeof message !== 'string') return null;

  const lines = message.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  // Line 1: BUY/SELL SYMBOL
  const line1Match = lines[0].match(/^(BUY|SELL)\s+([A-Z0-9&_-]+)$/i);
  if (!line1Match) return null;

  const action = line1Match[1].toUpperCase();
  const symbol = line1Match[2].toUpperCase();

  // Line 2: STRIKE CE/PE ABOVE PRICE
  const line2Match = lines[1].match(/^(\d+(?:\.\d+)?)\s+(CE|PE)\s+ABOVE\s+(\d+(?:\.\d+)?)$/i);
  if (!line2Match) return null;

  const strike = parseFloat(line2Match[1]);
  const optionType = line2Match[2].toUpperCase();
  const entryPrice = parseFloat(line2Match[3]);

  // Line 3: SL X TARGET T1 T2 ...
  const line3Match = lines[2].match(/^SL\s+(\d+(?:\.\d+)?)\s+TARGET\s+(.+)$/i);
  if (!line3Match) return null;

  const definedSL = parseFloat(line3Match[1]);
  // Use 50% of the defined stop loss
  const stopLoss = definedSL * 0.5;
  const targetsStr = line3Match[2].trim();
  const allTargets = targetsStr.split(/\s+/).map(t => parseFloat(t)).filter(t => !isNaN(t));
  // Only use the first target
  const target = allTargets.length > 0 ? allTargets[0] : null;

  // Line 4: MONTH SERIES (optional, default to current month)
  let expiry = getCurrentMonthAbbr();
  if (lines.length >= 4) {
    const line4Match = lines[3].match(/^([A-Z]+)\s+SERIES$/i);
    if (line4Match) {
      const monthName = line4Match[1].toUpperCase();
      expiry = MONTH_MAP[monthName] || monthName.substring(0, 3);
    }
  }

  return {
    messageId,
    action,
    symbol,
    strike,
    optionType,
    entryPrice,
    stopLoss,
    originalSL: definedSL,  // Keep original SL for reference
    target,                  // Single target (first one only)
    expiry,
    status: 'PENDING'
  };
}

/**
 * Parse reply messages and determine action to take
 * @param {string} message - Reply message text
 * @returns {object|null} Action object or null if not a recognized reply
 */
export function parseReplyMessage(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.trim().toUpperCase();

  // Pattern: "36.4, BOOK OR TRAIL" or "BOOK OR TRAIL"
  const bookMatch = text.match(/^(\d+(?:\.\d+)?)?,?\s*BOOK\s+OR\s+TRAIL$/i) ||
                    text.match(/^BOOK\s+OR\s+TRAIL$/i);
  if (bookMatch) {
    return {
      type: 'BOOK_PROFIT',
      price: bookMatch[1] ? parseFloat(bookMatch[1]) : null
    };
  }

  // Pattern: "CLOSE NEAR COST"
  if (text.includes('CLOSE NEAR COST') || text.includes('CLOSE AT COST') || text.includes('EXIT NEAR COST')) {
    return {
      type: 'EXIT_COST'
    };
  }

  // Pattern: "WAIT TO ACTIVATE" or "WAIT"
  if (text.includes('WAIT TO ACTIVATE') || text === 'WAIT') {
    return {
      type: 'WAIT'
    };
  }

  // Pattern: "FOLLOW IT" or "FOLLOW"
  if (text.includes('FOLLOW IT') || text === 'FOLLOW') {
    return {
      type: 'FOLLOW'
    };
  }

  // Pattern: Just "SL" or "SL HIT" or "STOP LOSS"
  if (text === 'SL' || text === 'SL HIT' || text === 'STOP LOSS' || text === 'STOPLOSS') {
    return {
      type: 'SL_HIT'
    };
  }

  // Pattern: "BUY AT CMP 58, SL 53" or "BUY AT CMP 58 SL 53"
  const revisedMatch = text.match(/^BUY\s+AT\s+CMP\s+(\d+(?:\.\d+)?)[,\s]+SL\s+(\d+(?:\.\d+)?)$/i);
  if (revisedMatch) {
    return {
      type: 'REVISED_ENTRY',
      price: parseFloat(revisedMatch[1]),
      newSL: parseFloat(revisedMatch[2])
    };
  }

  // Pattern: SL update - "SL 35", "UPDATE SL 35", "TRAIL SL TO 35", "NEW SL 35", "SL TO 35"
  const slUpdateMatch = text.match(/(?:UPDATE\s+)?(?:TRAIL\s+)?(?:NEW\s+)?SL\s+(?:TO\s+)?(\d+(?:\.\d+)?)/i);
  if (slUpdateMatch && !text.includes('TARGET')) {
    return {
      type: 'UPDATE_SL',
      newSL: parseFloat(slUpdateMatch[1])
    };
  }

  // Pattern: Target update - "TARGET 45", "NEW TARGET 45", "UPDATE TARGET 45", "TGT 45"
  const targetUpdateMatch = text.match(/(?:UPDATE\s+)?(?:NEW\s+)?(?:TARGET|TGT)\s+(?:TO\s+)?(\d+(?:\.\d+)?)/i);
  if (targetUpdateMatch && !text.includes('HIT') && !text.includes('DONE') && !text.includes('BOOK')) {
    return {
      type: 'UPDATE_TARGET',
      newTarget: parseFloat(targetUpdateMatch[1])
    };
  }

  // Pattern: Both SL and Target update - "SL 35 TARGET 45" or "SL 35 TGT 45"
  const slTargetMatch = text.match(/SL\s+(\d+(?:\.\d+)?)\s+(?:TARGET|TGT)\s+(\d+(?:\.\d+)?)/i);
  if (slTargetMatch) {
    return {
      type: 'UPDATE_SL_TARGET',
      newSL: parseFloat(slTargetMatch[1]),
      newTarget: parseFloat(slTargetMatch[2])
    };
  }

  // Pattern: Target hit with price e.g., "36.4" or "T1 HIT" or "TARGET 1 DONE"
  const priceOnlyMatch = text.match(/^(\d+(?:\.\d+)?)[,\s]*/);
  if (priceOnlyMatch && text.length < 20) {
    return {
      type: 'BOOK_PROFIT',
      price: parseFloat(priceOnlyMatch[1])
    };
  }

  return null;
}

/**
 * Check if a message is an options entry signal
 * @param {string} message - Raw message text
 * @returns {boolean}
 */
export function isOptionsSignal(message) {
  if (!message || typeof message !== 'string') return false;

  const lines = message.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;

  // Check first line for BUY/SELL SYMBOL pattern
  const line1Match = lines[0].match(/^(BUY|SELL)\s+([A-Z0-9&_-]+)$/i);
  if (!line1Match) return false;

  // Check second line for STRIKE CE/PE ABOVE pattern
  const line2Match = lines[1].match(/^(\d+(?:\.\d+)?)\s+(CE|PE)\s+ABOVE\s+/i);
  return !!line2Match;
}

/**
 * Get current month abbreviation
 * @returns {string}
 */
function getCurrentMonthAbbr() {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return months[new Date().getMonth()];
}

/**
 * Build Angel One option trading symbol
 * Format: {SYMBOL}{YY}{MON}{STRIKE}{CE/PE}
 * Example: HINDZINC26FEB750CE
 *
 * @param {string} symbol - Base symbol
 * @param {number} strike - Strike price
 * @param {string} optionType - CE or PE
 * @param {string} expiry - Month abbreviation (JAN, FEB, etc.)
 * @returns {string}
 */
export function buildOptionSymbol(symbol, strike, optionType, expiry) {
  const year = new Date().getFullYear().toString().slice(-2);
  // Strike should not have decimal places for symbol
  const strikeStr = Number.isInteger(strike) ? strike.toString() : strike.toFixed(0);
  return `${symbol}${year}${expiry}${strikeStr}${optionType}`;
}
