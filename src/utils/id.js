const crypto = require('crypto');

/**
 * Generates a deterministic or random 32-character hex string.
 * @param {string} [seed] - Optional input to make the hash deterministic.
 * @returns {string} 32-char hex string (MD5)
 */
const generateHash32 = (seed) => {
  const input = seed || crypto.randomBytes(16).toString('hex');
  return crypto.createHash('md5').update(input).digest('hex');
};

module.exports = { generateHash32 };