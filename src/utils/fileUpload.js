'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const Jimp = require('jimp');
const { env } = require('../config/env');
const { logger } = require('./logger');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage');

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOCUMENT_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf']);

// file-type is ESM-only (v17+) while this project stays CommonJS for
// broad compatibility with cPanel's Node.js Selector/Passenger — so it's
// loaded via dynamic import() and cached, rather than require(). This is
// the CURRENT (patched) major version deliberately: file-type 13-21.3.0
// has a known infinite-loop DoS in its ASF parser
// (GHSA-5v7r-6r5c-r473). Sniffing the real file content (not trusting
// the client's declared MIME type or filename extension) is the whole
// point of this module, so this dependency has to be current.
let fileTypeModulePromise = null;
function getFileType() {
  if (!fileTypeModulePromise) {
    fileTypeModulePromise = import('file-type');
  }
  return fileTypeModulePromise;
}

/**
 * Multer configured with memoryStorage (not diskStorage) — files land as
 * an in-memory Buffer, not on disk, so we can sniff and validate the
 * REAL content type before anything ever touches the filesystem. This
 * mirrors the PHP version's approach: never trust the client-supplied
 * filename, extension, or Content-Type header.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_SIZE, files: 15 },
});

function randomFilename(ext) {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

function extForMime(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mime];
}

/**
 * Store a PUBLIC image (property photo, avatar, company logo).
 * Re-encodes through Jimp, which decodes and re-draws the pixel data —
 * anything in the original file that isn't genuine image data (a
 * polyglot payload, embedded script, malformed trailer bytes) does not
 * survive the round trip. Also caps dimensions so a 40MP phone photo
 * doesn't chew through a shared-hosting storage quota.
 *
 * @param {Buffer} buffer
 * @param {string} subfolder e.g. "properties"
 * @returns {Promise<string>} relative path under public/, e.g. "uploads/properties/xxxx.jpg"
 */
async function storeImage(buffer, subfolder) {
  const { fileTypeFromBuffer } = await getFileType();
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_IMAGE_MIME.has(detected.mime)) {
    const err = new Error('Only JPG, PNG or WEBP images are allowed.');
    err.status = 422;
    err.field = 'file';
    throw err;
  }

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (e) {
    const err = new Error('Uploaded file is not a valid image.');
    err.status = 422;
    err.field = 'file';
    throw err;
  }

  const MAX_DIMENSION = 2000;
  if (image.bitmap.width > MAX_DIMENSION || image.bitmap.height > MAX_DIMENSION) {
    image.scaleToFit(MAX_DIMENSION, MAX_DIMENSION);
  }

  // Jimp (via its pure-JS webp decoder) can READ webp, but can only WRITE
  // jpeg or png — so png stays png, everything else (jpeg, webp) is
  // normalized to jpeg on the way out. That's a fine tradeoff: it's the
  // re-encode step that matters for security, not preserving webp specifically.
  const outputMime = detected.mime === 'image/png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
  const outputExt = outputMime === Jimp.MIME_PNG ? 'png' : 'jpg';
  if (outputMime === Jimp.MIME_JPEG) {
    image.quality(85);
  }

  const filename = randomFilename(outputExt);
  const destDir = path.join(PUBLIC_ROOT, 'uploads', subfolder);
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);

  await image.writeAsync(destPath);
  fs.chmodSync(destPath, 0o644);

  return path.posix.join('uploads', subfolder, filename);
}

/**
 * Store a PRIVATE/sensitive document (government ID, CAC certificate,
 * title deed, proof of payment). Lands under storage/ — outside the web
 * root — and is only ever readable through an authenticated, ownership-
 * checked download route. Never re-encoded (can't re-draw a PDF the way
 * we re-draw an image), so validation here rests entirely on real
 * content-type sniffing plus the size cap.
 *
 * @returns {Promise<string>} absolute path on disk (stored as-is in the DB column)
 */
async function storeDocument(buffer, subfolder) {
  const { fileTypeFromBuffer } = await getFileType();
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_DOCUMENT_MIME.has(detected.mime)) {
    const err = new Error('Only JPG, PNG or PDF documents are allowed.');
    err.status = 422;
    err.field = 'file';
    throw err;
  }

  const ext = extForMime(detected.mime);
  const filename = randomFilename(ext);
  const destDir = path.join(STORAGE_ROOT, 'uploads', 'documents', subfolder);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o750 });
  const destPath = path.join(destDir, filename);

  fs.writeFileSync(destPath, buffer, { mode: 0o640 });
  logger.info('Document stored', { path: destPath });

  return destPath;
}

module.exports = { upload, storeImage, storeDocument, STORAGE_ROOT };
