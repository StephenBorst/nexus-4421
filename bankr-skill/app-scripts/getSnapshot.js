const wallet = (ctx?.caller?.walletAddress || args?.walletAddress || '').toLowerCase().trim();
const key = wallet ? 'nexus_snapshot_' + wallet : 'nexus_snapshot';

const snapshot = await appKV.get(key);
const meta = await appKV.get('nexus_meta');
return { snapshot: snapshot || { orders: [], positions: [], syncedAt: null }, meta: meta || {} };
