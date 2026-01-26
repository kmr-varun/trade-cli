# Trade Signal Examples

The following message formats will trigger automatic order placement when received in monitored Telegram channels.

## Basic Format

```
ACTION SYMBOL QUANTITY @ PRICE
```

## Examples

### Buy Orders (Limit)

```
BUY RELIANCE 100 @ 2500
BUY INFY 50 @ 1450.50
BUY TCS 25 @ 3800
BUY HDFCBANK 10 @ 1650
BUY SBIN 200 @ 750
```

### Sell Orders (Limit)

```
SELL RELIANCE 100 @ 2550
SELL INFY 50 @ 1500
SELL TCS 25 @ 3850
```

### Market Orders

```
BUY RELIANCE 100 MARKET
SELL INFY 50 MARKET
```

### With Exchange Prefix

```
BUY NSE:RELIANCE 100 @ 2500
BUY BSE:INFY 50 @ 1450
SELL NSE:TCS 25 @ 3800
```

### With Product Type

```
BUY RELIANCE 100 @ 2500 DELIVERY
SELL INFY 50 @ 1450 INTRADAY
BUY SBIN 200 @ 750 DELIVERY
```

### Combined (Exchange + Product Type)

```
BUY NSE:RELIANCE 100 @ 2500 DELIVERY
SELL BSE:INFY 50 @ 1450 INTRADAY
```

## Field Descriptions

| Field | Required | Description | Default |
|-------|----------|-------------|---------|
| ACTION | Yes | `BUY` or `SELL` | - |
| EXCHANGE | No | `NSE` or `BSE` | NSE |
| SYMBOL | Yes | Stock symbol (e.g., RELIANCE, INFY) | - |
| QUANTITY | Yes | Number of shares | - |
| PRICE | Yes* | Limit price (*use `MARKET` for market orders) | - |
| PRODUCT | No | `INTRADAY` or `DELIVERY` | INTRADAY |

## Notes

- Signals are case-insensitive (`buy` works the same as `BUY`)
- Symbol must match Angel One instrument master
- The `@` symbol is required for limit orders
- Use `MARKET` keyword instead of `@ PRICE` for market orders
