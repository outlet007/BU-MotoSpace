const sharp = require('sharp');

// Generate a simple perceptual hash
async function generateHash(imagePath) {
  try {
    const { data } = await sharp(imagePath)
      .resize(16, 16, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Array.from(data);
    const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;
    const hash = pixels.map(p => (p > avg ? '1' : '0')).join('');
    // Convert binary to hex
    let hex = '';
    for (let i = 0; i < hash.length; i += 4) {
      hex += parseInt(hash.substring(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch (err) {
    console.error('Hash generation failed:', err);
    return null;
  }
}

// Compare two hashes (hamming distance)
function compareHashes(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 1;
  
  let diff = 0;
  for (let i = 0; i < hash1.length; i++) {
    const b1 = parseInt(hash1[i], 16);
    const b2 = parseInt(hash2[i], 16);
    let xor = b1 ^ b2;
    while (xor) {
      diff += xor & 1;
      xor >>= 1;
    }
  }
  // Normalize to 0-1 (0 = identical, 1 = completely different)
  return diff / (hash1.length * 4);
}

module.exports = { generateHash, compareHashes };
