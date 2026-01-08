/**
 * Icon Generator Script
 * Generates placeholder PNG icons for the extension
 *
 * Run with: node generate-icons.js
 *
 * Note: This script creates minimal valid PNG files without external dependencies.
 * The icons are simple colored squares that can be replaced with proper graphics later.
 */

const fs = require('fs');
const path = require('path');

/**
 * Creates a minimal valid PNG file with a solid color
 * @param {number} size - Width and height of the icon
 * @param {number[]} color - RGB color values [r, g, b]
 * @returns {Buffer} PNG file buffer
 */
function createPNG(size, color) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk (image header)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);  // width
  ihdrData.writeUInt32BE(size, 4);  // height
  ihdrData.writeUInt8(8, 8);        // bit depth
  ihdrData.writeUInt8(2, 9);        // color type (RGB)
  ihdrData.writeUInt8(0, 10);       // compression
  ihdrData.writeUInt8(0, 11);       // filter
  ihdrData.writeUInt8(0, 12);       // interlace

  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk (image data)
  // Create raw image data (filter byte + RGB for each pixel per row)
  const rowSize = 1 + size * 3; // filter byte + RGB values
  const rawData = Buffer.alloc(rowSize * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowSize;
    rawData[rowStart] = 0; // No filter
    for (let x = 0; x < size; x++) {
      const pixelStart = rowStart + 1 + x * 3;
      rawData[pixelStart] = color[0];     // R
      rawData[pixelStart + 1] = color[1]; // G
      rawData[pixelStart + 2] = color[2]; // B
    }
  }

  // Compress with zlib (deflate)
  const zlib = require('zlib');
  const compressedData = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressedData);

  // IEND chunk (image end)
  const iend = createChunk('IEND', Buffer.alloc(0));

  // Combine all parts
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Creates a PNG chunk with CRC
 * @param {string} type - Chunk type (4 characters)
 * @param {Buffer} data - Chunk data
 * @returns {Buffer} Complete chunk
 */
function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * Calculate CRC32 for PNG chunks
 * @param {Buffer} data - Data to calculate CRC for
 * @returns {number} CRC32 value
 */
function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = getCRC32Table();

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }

  return crc ^ 0xFFFFFFFF;
}

/**
 * Generate CRC32 lookup table
 * @returns {number[]} CRC32 table
 */
function getCRC32Table() {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
}

// Icon sizes and color (blue - #4285F4)
const sizes = [16, 48, 128];
const color = [66, 133, 244]; // Google Blue

const imagesDir = path.join(__dirname, 'images');

// Ensure images directory exists
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Generate icons
sizes.forEach(size => {
  const filename = `icon-${size}.png`;
  const filepath = path.join(imagesDir, filename);
  const png = createPNG(size, color);
  fs.writeFileSync(filepath, png);
  console.log(`Created: ${filename}`);
});

console.log('Icon generation complete!');
