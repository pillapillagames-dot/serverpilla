const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Genera una key legible tipo: PILLA-XXXX-XXXX-XXXX-XXXX
function generateKey() {
  const groups = [];
  for (let i = 0; i < 4; i++) {
    groups.push(crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4));
  }
  return `PILLA-${groups.join('-')}`;
}

function hashKey(plainKey) {
  return bcrypt.hashSync(plainKey, 10);
}

function verifyKey(plainKey, hash) {
  return bcrypt.compareSync(plainKey, hash);
}

function prefixOf(plainKey) {
  return plainKey.slice(0, 11); // "PILLA-XXXX-"
}

module.exports = { generateKey, hashKey, verifyKey, prefixOf };
