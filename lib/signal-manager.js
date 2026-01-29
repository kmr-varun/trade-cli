/**
 * Signal State Manager
 *
 * Tracks active options signals with their states.
 * Persists to signals-state.json for crash recovery.
 *
 * Signal states:
 *   PENDING  - Signal parsed but order not yet placed
 *   ACTIVE   - Order placed, waiting for target/SL/exit
 *   WAITING  - Received "WAIT TO ACTIVATE", on hold
 *   CLOSED   - Position exited (profit/loss/cost)
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, 'signals-state.json');

// In-memory store: messageId -> signal
const signals = new Map();

/**
 * Load signals from persistent storage
 */
export function loadSignals() {
  if (!fs.existsSync(STATE_FILE)) {
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(data.signals)) {
      for (const signal of data.signals) {
        signals.set(signal.messageId, signal);
      }
      console.log(`Loaded ${signals.size} signals from state file`);
    }
  } catch (err) {
    console.log(`Failed to load signals state: ${err.message}`);
  }
}

/**
 * Save signals to persistent storage
 */
function saveSignals() {
  const data = {
    updatedAt: new Date().toISOString(),
    signals: Array.from(signals.values())
  };

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`Failed to save signals state: ${err.message}`);
  }
}

/**
 * Add a new signal
 * @param {object} signal - Parsed options signal
 */
export function addSignal(signal) {
  signals.set(signal.messageId, {
    ...signal,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveSignals();
}

/**
 * Get a signal by message ID
 * @param {number} messageId
 * @returns {object|null}
 */
export function getSignal(messageId) {
  return signals.get(messageId) || null;
}

/**
 * Update a signal's status
 * @param {number} messageId
 * @param {string} status - New status (PENDING, ACTIVE, WAITING, CLOSED)
 * @param {object} extra - Additional fields to update
 */
export function updateSignalStatus(messageId, status, extra = {}) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    ...extra,
    status,
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Update signal with order details
 * @param {number} messageId
 * @param {string} orderId - Angel One order ID
 */
export function setSignalOrderId(messageId, orderId) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    orderId,
    status: 'ACTIVE',
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Update signal entry price (for revised entries)
 * @param {number} messageId
 * @param {number} newPrice
 * @param {number} newSL
 */
export function updateSignalEntry(messageId, newPrice, newSL) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    entryPrice: newPrice,
    stopLoss: newSL,
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Update signal stop loss
 * @param {number} messageId
 * @param {number} newSL
 */
export function updateSignalSL(messageId, newSL) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    stopLoss: newSL,
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Update signal target
 * @param {number} messageId
 * @param {number} newTarget
 */
export function updateSignalTarget(messageId, newTarget) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    target: newTarget,
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Update signal stop loss and target
 * @param {number} messageId
 * @param {number} newSL
 * @param {number} newTarget
 */
export function updateSignalSLAndTarget(messageId, newSL, newTarget) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    stopLoss: newSL,
    target: newTarget,
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Close a signal
 * @param {number} messageId
 * @param {string} reason - PROFIT, SL_HIT, COST, MANUAL
 * @param {number} exitPrice
 */
export function closeSignal(messageId, reason, exitPrice = null) {
  const signal = signals.get(messageId);
  if (!signal) return null;

  const updated = {
    ...signal,
    status: 'CLOSED',
    closeReason: reason,
    exitPrice,
    closedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  signals.set(messageId, updated);
  saveSignals();
  return updated;
}

/**
 * Get all active signals (PENDING, ACTIVE, WAITING)
 * @returns {object[]}
 */
export function getActiveSignals() {
  return Array.from(signals.values()).filter(
    s => s.status !== 'CLOSED'
  );
}

/**
 * Get all signals
 * @returns {object[]}
 */
export function getAllSignals() {
  return Array.from(signals.values());
}

/**
 * Remove old closed signals (cleanup)
 * @param {number} maxAgeDays - Remove signals older than this
 */
export function cleanupOldSignals(maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const [messageId, signal] of signals) {
    if (signal.status === 'CLOSED') {
      const closedAt = new Date(signal.closedAt || signal.updatedAt).getTime();
      if (closedAt < cutoff) {
        signals.delete(messageId);
        removed++;
      }
    }
  }

  if (removed > 0) {
    saveSignals();
    console.log(`Cleaned up ${removed} old signals`);
  }
}
