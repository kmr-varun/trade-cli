/**
 * Parse trade signals from Telegram messages.
 *
 * Supported formats:
 *   BUY RELIANCE 100 @ 2500
 *   SELL INFY 50 @ 1800
 *   BUY NSE:SBIN 200 @ 750            (with exchange)
 *   BUY RELIANCE 100 @ 2500 DELIVERY  (with product type)
 *   BUY RELIANCE 100 MARKET           (market order)
 */

// Pattern to match trade signals
// Groups: action, exchange (optional), symbol, quantity, orderType/price, productType (optional)
const SIGNAL_REGEX =
  /^(BUY|SELL)\s+(?:([A-Z]+):)?([A-Z0-9&_-]+)\s+(\d+)\s+(?:@\s*(\d+(?:\.\d+)?)|MARKET)(?:\s+(DELIVERY|INTRADAY))?$/i;

export function isTradeSignal(message) {
  if (!message || typeof message !== 'string') return false;
  return SIGNAL_REGEX.test(message.trim());
}

export function parseSignal(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.trim();
  const match = text.match(SIGNAL_REGEX);

  if (!match) return null;

  const [, action, exchange, symbol, quantity, price, productType] = match;

  const isMarketOrder = text.toUpperCase().includes('MARKET');

  return {
    action: action.toUpperCase(),
    symbol: symbol.toUpperCase(),
    quantity: parseInt(quantity, 10),
    price: isMarketOrder ? 0 : parseFloat(price),
    orderType: isMarketOrder ? 'MARKET' : 'LIMIT',
    exchange: exchange?.toUpperCase() || 'NSE',
    productType: productType?.toUpperCase() || 'INTRADAY'
  };
}
