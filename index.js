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
import { initializeInstruments, lookupInstrument } from './lib/instrument-lookup.js';
import { parseSignal } from './lib/signal-parser.js';

/* -----------------------------------------------------
   Paths / Config
----------------------------------------------------- */

const ROOT = process.cwd();
const SESSION_FILE = path.join(ROOT, 'session.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

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
   Message Listener
----------------------------------------------------- */

function startListener(channels) {
  const channelIds = new Set(channels.map(c => String(c.id)));
  const channelMap = new Map(channels.map(c => [String(c.id), c.title]));

  client.addEventHandler(
    async event => {
      const msg = event.message;
      if (!msg?.text) return;

      // Get ID from message (channel or group)
      const channelId = msg.peerId?.channelId?.toString();
      const chatId = msg.peerId?.chatId?.toString();
      const peerId = channelId || chatId;

      // Debug: show all messages
      console.log(chalk.gray('--------------------------------------------------'));
      console.log(chalk.gray(`[DEBUG] peerId: ${peerId}, channelId: ${channelId}, chatId: ${chatId}`));
      console.log(chalk.gray(`[DEBUG] Watching: ${[...channelIds].join(', ')}`));

      if (!peerId || !channelIds.has(peerId)) {
        console.log(chalk.gray(`[DEBUG] Ignoring - not from watched channel`));
        return;
      }

      const channelTitle = channelMap.get(peerId) || 'Unknown';

      console.log(chalk.cyan(`[${channelTitle}]`), chalk.white(msg.text));

      // Parse and execute trade signal
      const signal = parseSignal(msg.text);
      if (signal) {
        console.log(chalk.magenta('Signal detected:'), signal);
        await executeOrder(signal, channelTitle);
      } else {
        console.log(chalk.gray('[DEBUG] Not a valid signal format'));
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

    // Select channels
    const channels = await selectChannels();

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
