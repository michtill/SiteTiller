// Automated fixtures always stay offline, even if an inherited environment requests providers.
process.env.SITETILLER_NETWORK_MODE = 'offline';
process.env.SITETILLER_OFFLINE = '1';
await import('./network-policy.mjs');
