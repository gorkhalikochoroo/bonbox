// Paint from memory, refresh behind (premium feel P7).
// The last SERVER answer each tab drew, in memory only, so a return paints at once and
// refreshes behind. Never persisted. Never local state with local flags (_pending, _ck, _new,
// tmp- rows): those would replay their entrance on the next mount. Cleared when the portal
// unmounts (disconnect, another token).
const mem = new Map();
export const recall = (token, key) => mem.get(`${token}|${key}`);
export const remember = (token, key, value) => { mem.set(`${token}|${key}`, value); };
export const forgetAll = () => mem.clear();
