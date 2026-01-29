#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';

import { initializeSmartAPI, getSmartAPI } from './lib/angelone.js';
import { initializeInstruments, lookupInstrument, lookupOption, getLotSize } from './lib/instrument-lookup.js';
import { parseSignal } from './lib/signal-parser.js';
import { parseOptionsSignal, parseReplyMessage, isOptionsSignal } from './lib/options-signal-parser.js';
import {
  loadSignals,
  addSignal,
  getSignal,
  updateSignalStatus,
  setSignalOrderId,
  updateSignalEntry,
  updateSignalSL,
  updateSignalTarget,
  updateSignalSLAndTarget,
  closeSignal
} from './lib/signal-manager.js';

/* -----------------------------------------------------
   Paths / Config
----------------------------------------------------- */

const ROOT = process.cwd();
const SESSION_FILE = path.join(ROOT, 'session.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MESSAGES_DIR = path.join(ROOT, 'messages');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
  process.exit(1);
}

/* -----------------------------------------------------
   Utilities
----------------------------------------------------- */

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function header(title) {
  console.log(
    chalk.gray('--------------------------------------------------')
  );
  console.log(chalk.white.bold(title));
  console.log(
    chalk.gray('--------------------------------------------------')
  );
}

/* -----------------------------------------------------
   Telegram Client
----------------------------------------------------- */

const savedSession = readJSON(SESSION_FILE, {}).session || '';
const client = new TelegramClient(
  new StringSession(savedSession),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

/* -----------------------------------------------------
   Login
----------------------------------------------------- */

async function login() {
  if (savedSession) {
    await client.connect();
    return;
  }

  await client.start({
    phoneNumber: async () => {
      const { phone } = await inquirer.prompt({
        name: 'phone',
        message: 'Phone number (with country code):'
      });
      return phone;
    },
    phoneCode: async () => {
      const { code } = await inquirer.prompt({
        name: 'code',
        message: 'OTP code:'
      });
      return code;
    },
    onError: err => console.error(err)
  });

  writeJSON(SESSION_FILE, { session: client.session.save() });
}

/* -----------------------------------------------------
   Channel Selection
----------------------------------------------------- */

async function selectChannels() {
  const saved = readJSON(CONFIG_FILE, null);
  if (saved?.channels?.length) {
    return saved.channels;
  }

  const dialogs = await client.getDialogs();
  const options = dialogs
    .filter(d => d.isChannel || d.isGroup || d.isMegagroup)
    .map(d => ({
      name: d.title,
      value: {
        id: String(d.entity.id),
        title: d.title
      }
    }));

  if (options.length === 0) {
    console.error('No channels or groups found');
    process.exit(1);
  }

  const { selected } = await inquirer.prompt({
    type: 'checkbox',
    name: 'selected',
    message: 'Select channels to listen to (SPACE to select):',
    choices: options,
    validate: v => v.length > 0 || 'Select at least one channel'
  });

  writeJSON(CONFIG_FILE, { channels: selected });
  return selected;
}

/* -----------------------------------------------------
   Fetch & Save Message History
----------------------------------------------------- */

async function fetchAndSaveMessages(channels) {
  // Create messages directory if it doesn't exist
  if (!fs.existsSync(MESSAGES_DIR)) {
    fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  }

  // Get all dialogs to find proper entities
  const dialogs = await client.getDialogs();
  const dialogMap = new Map();
  for (const d of dialogs) {
    dialogMap.set(String(d.entity.id), d.entity);
  }

  for (const channel of channels) {
    const sanitizedTitle = channel.title.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = path.join(MESSAGES_DIR, `${sanitizedTitle}_${channel.id}.txt`);

    console.log(chalk.yellow(`Fetching messages from: ${channel.title}...`));

    try {
      // Get the entity from dialogs
      const entity = dialogMap.get(channel.id);
      if (!entity) {
        console.log(chalk.red(`Could not find entity for: ${channel.title}`));
        continue;
      }

      // Fetch all messages (limit can be adjusted or removed for all messages)
      const messages = [];
      for await (const msg of client.iterMessages(entity, { limit: 1000 })) {
        messages.push(msg);
      }

      // Reverse to get chronological order (oldest first)
      messages.reverse();

      // Build a map of message ID to message for reply lookup
      const messageMap = new Map();
      messages.forEach(msg => {
        messageMap.set(msg.id, msg);
      });

      // Format and write to file
      const lines = [];
      lines.push(`==========================================================`);
      lines.push(`Channel: ${channel.title}`);
      lines.push(`Total Messages: ${messages.length}`);
      lines.push(`Exported: ${new Date().toISOString()}`);
      lines.push(`==========================================================\n`);

      for (const msg of messages) {
        const date = msg.date ? new Date(msg.date * 1000).toLocaleString() : 'Unknown';
        const sender = msg.senderId ? `User ${msg.senderId}` : 'Unknown';

        lines.push(`----------------------------------------------------------`);
        lines.push(`[Message ID: ${msg.id}]`);
        lines.push(`Date: ${date}`);
        lines.push(`From: ${sender}`);

        // Check if this is a reply
        if (msg.replyTo?.replyToMsgId) {
          const replyToId = msg.replyTo.replyToMsgId;
          const originalMsg = messageMap.get(replyToId);
          lines.push(`>> REPLY TO Message ID: ${replyToId}`);
          if (originalMsg?.text) {
            const preview = originalMsg.text.substring(0, 100).replace(/\n/g, ' ');
            lines.push(`>> Original: "${preview}${originalMsg.text.length > 100 ? '...' : ''}"`);
          }
        }

        lines.push(`\n${msg.text || '[No text content]'}\n`);
      }

      fs.writeFileSync(filename, lines.join('\n'), 'utf8');
      console.log(chalk.green(`Saved ${messages.length} messages to: ${filename}`));

    } catch (err) {
      console.log(chalk.red(`Failed to fetch messages from ${channel.title}: ${err.message}`));
    }
  }
}

/* -----------------------------------------------------
   Order Execution
----------------------------------------------------- */

async function executeOrder(signal, channelTitle) {
  const instrument = lookupInstrument(signal.symbol, signal.exchange);
  if (!instrument) {
    console.log(chalk.red(`Instrument not found: ${signal.symbol}`));
    return;
  }

  const orderParams = {
    variety: 'NORMAL',
    tradingsymbol: instrument.symbol,
    symboltoken: instrument.token,
    transactiontype: signal.action,
    exchange: signal.exchange,
    ordertype: signal.orderType,
    producttype: signal.productType,
    duration: 'DAY',
    price: String(signal.price),
    quantity: String(signal.quantity)
  };

  console.log(chalk.yellow(`Placing order: ${signal.action} ${signal.symbol} x${signal.quantity}`));

  try {
    const result = await getSmartAPI().placeOrder(orderParams);
    if (result.status) {
      console.log(chalk.green(`Order placed: ${result.data.orderid}`));
    } else {
      console.log(chalk.red(`Order failed: ${result.message}`));
    }
  } catch (err) {
    console.log(chalk.red(`Order error: ${err.message}`));
  }
}

/* -----------------------------------------------------
   Options Order Execution
----------------------------------------------------- */

async function executeOptionsEntry(signal) {
  // Look up the option instrument
  const instrument = lookupOption(signal.symbol, signal.strike, signal.optionType, signal.expiry);
  if (!instrument) {
    console.log(chalk.red(`Option not found: ${signal.symbol} ${signal.strike} ${signal.optionType} ${signal.expiry}`));
    return null;
  }

  const lotSize = getLotSize(instrument);

  const orderParams = {
    variety: 'NORMAL',
    tradingsymbol: instrument.symbol,
    symboltoken: instrument.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'LIMIT',
    producttype: 'INTRADAY',
    duration: 'DAY',
    price: String(signal.entryPrice),
    quantity: String(lotSize)
  };

  console.log(chalk.yellow(`Placing options order: BUY ${instrument.symbol} @ ${signal.entryPrice} x${lotSize}`));

  try {
    const result = await getSmartAPI().placeOrder(orderParams);
    if (result.status) {
      console.log(chalk.green(`Options order placed: ${result.data.orderid}`));
      return result.data.orderid;
    } else {
      console.log(chalk.red(`Options order failed: ${result.message}`));
      return null;
    }
  } catch (err) {
    console.log(chalk.red(`Options order error: ${err.message}`));
    return null;
  }
}

async function executeOptionsExit(signal, orderType = 'MARKET', price = 0) {
  // Look up the option instrument
  const instrument = lookupOption(signal.symbol, signal.strike, signal.optionType, signal.expiry);
  if (!instrument) {
    console.log(chalk.red(`Option not found for exit: ${signal.symbol} ${signal.strike} ${signal.optionType}`));
    return null;
  }

  const lotSize = getLotSize(instrument);

  const orderParams = {
    variety: 'NORMAL',
    tradingsymbol: instrument.symbol,
    symboltoken: instrument.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: orderType,
    producttype: 'INTRADAY',
    duration: 'DAY',
    price: orderType === 'LIMIT' ? String(price) : '0',
    quantity: String(lotSize)
  };

  console.log(chalk.yellow(`Placing exit order: SELL ${instrument.symbol} @ ${orderType} x${lotSize}`));

  try {
    const result = await getSmartAPI().placeOrder(orderParams);
    if (result.status) {
      console.log(chalk.green(`Exit order placed: ${result.data.orderid}`));
      return result.data.orderid;
    } else {
      console.log(chalk.red(`Exit order failed: ${result.message}`));
      return null;
    }
  } catch (err) {
    console.log(chalk.red(`Exit order error: ${err.message}`));
    return null;
  }
}

async function handleOptionsSignal(msg) {
  const signal = parseOptionsSignal(msg.text, msg.id);
  if (!signal) return;

  console.log(chalk.magenta('Options signal detected:'), signal);

  // Add to signal manager
  addSignal(signal);

  // Execute entry order
  const orderId = await executeOptionsEntry(signal);
  if (orderId) {
    setSignalOrderId(signal.messageId, orderId);
    console.log(chalk.green(`Signal ${signal.messageId} is now ACTIVE`));
  } else {
    updateSignalStatus(signal.messageId, 'PENDING');
  }
}

async function handleReplyMessage(msg, replyToMsgId) {
  // Get original signal
  const originalSignal = getSignal(replyToMsgId);
  if (!originalSignal) {
    console.log(chalk.gray(`No tracked signal for message ${replyToMsgId}`));
    return;
  }

  // Parse reply action
  const action = parseReplyMessage(msg.text);
  if (!action) {
    console.log(chalk.gray(`Unrecognized reply: ${msg.text}`));
    return;
  }

  console.log(chalk.magenta(`Reply action for signal ${replyToMsgId}:`), action);

  switch (action.type) {
    case 'BOOK_PROFIT':
      // Exit position at market
      console.log(chalk.green('Booking profit - exiting position'));
      await executeOptionsExit(originalSignal, 'MARKET');
      closeSignal(replyToMsgId, 'PROFIT', action.price);
      break;

    case 'EXIT_COST':
      // Exit at entry price
      console.log(chalk.yellow('Exiting at cost'));
      await executeOptionsExit(originalSignal, 'LIMIT', originalSignal.entryPrice);
      closeSignal(replyToMsgId, 'COST', originalSignal.entryPrice);
      break;

    case 'WAIT':
      // Set status to WAITING
      console.log(chalk.yellow('Signal set to WAITING'));
      updateSignalStatus(replyToMsgId, 'WAITING');
      break;

    case 'FOLLOW':
      // No action needed
      console.log(chalk.gray('Following signal - no action'));
      break;

    case 'SL_HIT':
      // Stop loss hit - exit immediately
      console.log(chalk.red('Stop loss hit - exiting position'));
      await executeOptionsExit(originalSignal, 'MARKET');
      closeSignal(replyToMsgId, 'SL_HIT');
      break;

    case 'REVISED_ENTRY':
      // Update entry price and SL, place new order
      console.log(chalk.cyan(`Revised entry: ${action.price}, SL: ${action.newSL}`));
      updateSignalEntry(replyToMsgId, action.price, action.newSL);
      const updatedSignal = getSignal(replyToMsgId);
      if (updatedSignal) {
        const orderId = await executeOptionsEntry(updatedSignal);
        if (orderId) {
          setSignalOrderId(replyToMsgId, orderId);
        }
      }
      break;

    case 'UPDATE_SL':
      // Update stop loss only
      console.log(chalk.cyan(`Updating SL to: ${action.newSL}`));
      updateSignalSL(replyToMsgId, action.newSL);
      console.log(chalk.green(`Signal ${replyToMsgId} SL updated to ${action.newSL}`));
      break;

    case 'UPDATE_TARGET':
      // Update target only
      console.log(chalk.cyan(`Updating target to: ${action.newTarget}`));
      updateSignalTarget(replyToMsgId, action.newTarget);
      console.log(chalk.green(`Signal ${replyToMsgId} target updated to ${action.newTarget}`));
      break;

    case 'UPDATE_SL_TARGET':
      // Update both SL and target
      console.log(chalk.cyan(`Updating SL to: ${action.newSL}, Target to: ${action.newTarget}`));
      updateSignalSLAndTarget(replyToMsgId, action.newSL, action.newTarget);
      console.log(chalk.green(`Signal ${replyToMsgId} SL updated to ${action.newSL}, target updated to ${action.newTarget}`));
      break;
  }
}

/* -----------------------------------------------------
   Message Listener
----------------------------------------------------- */

function startListener(channels) {
  const channelIds = new Set(channels.map(c => String(c.id)));
  const channelMap = new Map(channels.map(c => [String(c.id), c.title]));
  const processedMessages = new Set();

  client.addEventHandler(
    async event => {
      const msg = event.message;
      if (!msg?.text) return;

      // Deduplicate messages by ID
      const msgKey = `${msg.peerId?.channelId || msg.peerId?.chatId}-${msg.id}`;
      console.log(chalk.gray(`[DEBUG] Event received - msgKey: ${msgKey}, msgId: ${msg.id}`));
      console.log(chalk.gray(`[DEBUG] Already processed: ${[...processedMessages].join(', ')}`));

      if (processedMessages.has(msgKey)) {
        console.log(chalk.yellow(`[DEBUG] SKIPPING duplicate message: ${msgKey}`));
        return;
      }
      processedMessages.add(msgKey);

      // Clean up old message IDs (keep last 100)
      if (processedMessages.size > 100) {
        const oldest = [...processedMessages][0];
        processedMessages.delete(oldest);
      }

      // Get ID from message (channel or group)
      const channelId = msg.peerId?.channelId?.toString();
      const chatId = msg.peerId?.chatId?.toString();
      const peerId = channelId || chatId;

      if (!peerId || !channelIds.has(peerId)) {
        return;
      }

      const channelTitle = channelMap.get(peerId) || 'Unknown';

      console.log(chalk.gray('--------------------------------------------------'));
      console.log(chalk.cyan(`[${channelTitle}]`), chalk.white(msg.text));

      // Check if this is a reply to an existing message
      const replyToMsgId = msg.replyTo?.replyToMsgId;

      if (replyToMsgId) {
        // Handle as reply message (potential exit/update signal)
        console.log(chalk.gray(`Reply to message ${replyToMsgId}`));
        await handleReplyMessage(msg, replyToMsgId);
      } else if (isOptionsSignal(msg.text)) {
        // Handle as new options signal
        await handleOptionsSignal(msg);
      } else {
        // Try legacy signal format
        const signal = parseSignal(msg.text);
        if (signal) {
          console.log(chalk.magenta('Signal detected:'), signal);
          await executeOrder(signal, channelTitle);
        }
      }
    },
    new NewMessage()
  );
}

/* -----------------------------------------------------
   Main
----------------------------------------------------- */

(async () => {
  try {
    header('Telegram Trading CLI');

    // Telegram login
    await login();
    const me = await client.getMe();
    console.log('Logged in as:', me.firstName || me.username);

    // Angel One SmartAPI initialization
    header('Angel One');
    try {
      await initializeSmartAPI();
    } catch (err) {
      console.log(chalk.red(`Angel One login failed: ${err.message}`));
      process.exit(1);
    }

    // Load instrument master
    header('Instruments');
    try {
      await initializeInstruments();
    } catch (err) {
      console.log(chalk.red(`Failed to load instruments: ${err.message}`));
      process.exit(1);
    }

    // Load saved signals for recovery
    header('Signals');
    loadSignals();

    // Select channels
    const channels = await selectChannels();

    // Fetch and save message history
    header('Fetching Message History');
    await fetchAndSaveMessages(channels);

    // Start listening
    header('Listening');
    console.log('Channels:', channels.map(c => c.title).join(', '));

    startListener(channels);

    console.log('Waiting for messages...');
    await new Promise(() => {});
  } catch (err) {
    console.log(chalk.red(`Fatal error: ${err.message}`));
    process.exit(1);
  }
})();
