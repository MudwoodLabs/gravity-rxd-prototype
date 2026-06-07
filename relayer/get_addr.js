const rxd = require('@radiant-core/radiantjs');
const fs = require('fs');
const wif = fs.readFileSync('/tmp/maker-rxd.wif', 'utf8').trim();
const priv = new rxd.PrivateKey(wif);
const addr = priv.toPublicKey().toAddress();
console.log('Maker addr:', addr.toString());
console.log('Maker PKH:', priv.toPublicKey().toAddress().hashBuffer.toString('hex'));
// Use maker's own address as the "taker" destination for attack txs (just needs to be valid)
