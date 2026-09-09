/**
 * Criptomonedas admitidas para el cobro diario.
 * `krakenAsset` es el codigo que usa Kraken y `pair` el par contra EUR.
 * Las expresiones regulares son un control de sanidad del formato: la comprobacion
 * real la hace Kraken al dar de alta la direccion en su lista blanca.
 */
export const ASSETS = {
  BTC: {
    label: 'Bitcoin (BTC)',
    krakenAsset: 'XBT',
    pair: 'XBTEUR',
    networks: ['Bitcoin'],
    pattern: /^(bc1[02-9ac-hj-np-z]{7,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/,
    decimals: 8,
  },
  ETH: {
    label: 'Ethereum (ETH)',
    krakenAsset: 'ETH',
    pair: 'ETHEUR',
    networks: ['Ethereum', 'Arbitrum One', 'Base', 'Optimism'],
    pattern: /^0x[a-fA-F0-9]{40}$/,
    decimals: 8,
  },
  USDT: {
    label: 'Tether (USDT)',
    krakenAsset: 'USDT',
    pair: 'USDTEUR',
    networks: ['Ethereum', 'Tron', 'Solana'],
    pattern: /^(0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})$/,
    decimals: 6,
  },
  USDC: {
    label: 'USD Coin (USDC)',
    krakenAsset: 'USDC',
    pair: 'USDCEUR',
    networks: ['Ethereum', 'Solana', 'Base', 'Polygon'],
    pattern: /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/,
    decimals: 6,
  },
  SOL: {
    label: 'Solana (SOL)',
    krakenAsset: 'SOL',
    pair: 'SOLEUR',
    networks: ['Solana'],
    pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    decimals: 8,
  },
  LTC: {
    label: 'Litecoin (LTC)',
    krakenAsset: 'XLTC',
    pair: 'LTCEUR',
    networks: ['Litecoin'],
    pattern: /^(ltc1[02-9ac-hj-np-z]{7,71}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
    decimals: 8,
  },
};

export const ASSET_CODES = Object.keys(ASSETS);

export function getAsset(code) {
  return ASSETS[String(code || '').toUpperCase()] || null;
}

/**
 * @returns {{ok: true, asset: string, network: string, address: string} | {ok: false, error: string}}
 */
export function validateWallet({ asset, network, address }) {
  const code = String(asset || '').toUpperCase();
  const spec = getAsset(code);
  if (!spec) return { ok: false, error: 'Criptomoneda no admitida.' };

  const net = String(network || '').trim();
  if (!spec.networks.includes(net)) {
    return { ok: false, error: `Red no valida para ${code}. Opciones: ${spec.networks.join(', ')}.` };
  }

  const addr = String(address || '').trim();
  if (!addr) return { ok: false, error: 'La direccion no puede estar vacia.' };
  if (addr.length > 128) return { ok: false, error: 'La direccion es demasiado larga.' };
  if (!spec.pattern.test(addr)) {
    return { ok: false, error: `El formato de la direccion no parece valido para ${code} en ${net}.` };
  }

  return { ok: true, asset: code, network: net, address: addr };
}
