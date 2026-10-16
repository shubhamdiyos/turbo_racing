/**
 * Sandbox storefront + launch-offer window.
 *
 * package.json has no billing SDK, so nothing here can take real money.
 * PURCHASES_ARE_SANDBOX gates the charge path and every price in the UI says so out loud.
 * When Play Billing / StoreKit lands, only requestPurchase() changes — the grant shape that
 * main.js applies stays the same.
 */

export const PURCHASES_ARE_SANDBOX = true;

const LTO_MS = 12 * 60 * 60 * 1000;
const LTO_OFF = 0.7;

// unlockCars are indices into CAR_SPECS and must track that table's order.
export const PRODUCTS = [
  {
    id: 'starter_pack', title: 'LAUNCH STARTER PACK', cents: 1499, oneShot: true,
    blurb: 'Viper + Hyper chassis, 2,500 coins, 3 headstart tokens, ad-free.',
    grants: { coins: 2500, headstarts: 3, noAds: true, unlockCars: [1, 2] }
  },
  {
    id: 'vip_pass', title: 'ALL-ACCESS GARAGE PASS', cents: 3999, oneShot: true,
    blurb: 'Every chassis in the game, 12,000 coins, 5 headstart tokens, ad-free.',
    grants: { coins: 12000, headstarts: 5, noAds: true, unlockAllCars: true }
  },
  {
    id: 'no_ads', title: 'REMOVE ADS', cents: 699, oneShot: true,
    blurb: 'No interstitials between runs, ever.',
    grants: { noAds: true }
  },
  {
    id: 'headstart_5', title: 'HEADSTART 5-PACK', cents: 299,
    blurb: 'Five tokens: launch every run already morphed.',
    grants: { headstarts: 5 }
  },
  {
    id: 'coins_3k', title: 'COIN SACK', cents: 499,
    blurb: '3,000 coins for the tuning bay.',
    grants: { coins: 3000 }
  }
];

export function initOffer(save, now = Date.now()) {
  if (!save.offer || typeof save.offer.expiresAt !== 'number') {
    save.offer = { expiresAt: now + LTO_MS };
  }
  return save.offer;
}

export function offerLive(save, now = Date.now()) {
  return typeof save.offer?.expiresAt === 'number' && now < save.offer.expiresAt;
}

export function offerRemaining(save, now = Date.now()) {
  return Math.max(0, (save.offer?.expiresAt || 0) - now);
}

export function countdown(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function priceOf(save, product, now = Date.now()) {
  const live = offerLive(save, now);
  const pay = live ? Math.max(1, Math.round(product.cents * (1 - LTO_OFF))) : product.cents;
  return { pay, list: product.cents, off: live && pay !== product.cents };
}

export const LTO_OFF_PCT = Math.round(LTO_OFF * 100);

export function isOwned(save, product) {
  return !!product.oneShot && !!save.purchases?.[product.id];
}

export function markPurchased(save, product) {
  if (!save.purchases) save.purchases = {};
  save.purchases[product.id] = (save.purchases[product.id] || 0) + 1;
}

// Real per-country prices are whatever the store SDK reports. Until then this is a single
// USD list, formatted for the device locale but never converted.
export function usd(cents) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
  } catch (e) {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export async function requestPurchase(save, product, now = Date.now()) {
  if (!PURCHASES_ARE_SANDBOX) {
    console.error('[store] billing SDK is not wired — refusing to show a payable button');
    return false;
  }
  const p = priceOf(save, product, now);
  const deal = p.off ? `${usd(p.pay)}  (was ${usd(p.list)}, ${LTO_OFF_PCT}% OFF)` : usd(p.pay);
  return confirm(
    `SANDBOX PURCHASE — no real charge\n\n${product.title}\n${deal}\n\n${product.blurb}`
  );
}
