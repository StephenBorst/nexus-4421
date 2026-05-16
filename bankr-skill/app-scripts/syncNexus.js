// syncNexus.js — GET-first with session_not_cached structured error
// Wallet resolved from ctx.caller (read:wallet) or args fallback
const wallet = (ctx?.caller?.walletAddress || args?.walletAddress || '').toLowerCase().trim();
if (!wallet) return { error: 'wallet_not_connected', hint: 'Connect your wallet to Bankr.' };

const BASE = 'https://og.nexustradinglabs.com';

// Fast path — no walletSig needed if session is warm
const res = await http.fetch(`${BASE}/account-snapshot?wallet=${wallet}`);
const data = await res.json();

if (data.error === 'session_not_cached' || data.error === 'wallet_not_registered') {
  // Structured error — iframe will show the handoff button
  return {
    error: data.error,
    needsAgent: true,
    hint: data.hint || 'Open the Nexus skill in chat to activate your session.',
  };
}

if (data.error) return { error: data.error };

// Scope snapshot to this wallet — no cross-user collisions
const key = 'nexus_snapshot_' + wallet;
await appKV.set(key, {
  orders:    data.orders    || [],
  positions: data.positions || [],
  syncedAt:  Date.now(),
});

return { ok: true, orderCount: data.orders.length, positionCount: data.positions.length };
