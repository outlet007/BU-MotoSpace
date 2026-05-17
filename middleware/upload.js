const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

const MAX_IMAGE_DIMENSION = 1200;
const RESIZABLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_MAGIC = Buffer.from([0x66, 0x74, 0x79, 0x70]); // 'ftyp' at offset 4

function uploadTypeError(message) {
  const err = new Error(message);
  err.code = 'EUPLOADTYPE';
  return err;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads/';
    if (file.fieldname === 'motorcycle_photo' || file.fieldname === 'motorcycle_photo_2') folder += 'motorcycles/';
    else if (file.fieldname === 'plate_photo' || file.fieldname === 'plate_photo_2') folder += 'plates/';
    else if (file.fieldname === 'id_card_photo') folder += 'id-cards/';
    else if (file.fieldname === 'evidence_photo') folder += 'evidence/';
    else if (file.fieldname === 'written_document') folder += 'summons-documents/';
    else if (file.fieldname === 'search_image' || file.fieldname === 'file') folder += 'temp/';
    else folder += 'misc/';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// ตรวจสอบ magic bytes ของไฟล์ว่าเป็น HEIC/HEIF จริงหรือไม่
function isHeicByMagic(filePath) {
  try {
    const buf = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    // HEIC: bytes 4–7 = 'ftyp'
    return buf.slice(4, 8).equals(HEIC_MAGIC);
  } catch {
    return false;
  }
}

// แปลง HEIC → JPEG แล้วเขียนทับไฟล์เดิม
async function convertHeicToJpeg(file) {
  const inputBuffer = await fs.promises.readFile(file.path);
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.92,
  });
  await fs.promises.writeFile(file.path, outputBuffer);
  // อัปเดต metadata ของ file object
  file.mimetype = 'image/jpeg';
  const newExt = '.jpg';
  const oldPath = file.path;
  const newPath = oldPath.replace(/\.[^.]+$/, newExt);
  if (oldPath !== newPath) {
    await fs.promises.rename(oldPath, newPath);
    file.path = newPath;
    file.filename = path.basename(newPath);
  }
  const stat = await fs.promises.stat(file.path);
  file.size = stat.size;
  console.log(`[HEIC] Converted ${file.originalname} → JPEG (${stat.size} bytes)`);
}

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const imageExtensions = ['jpeg', 'jpg', 'png', 'webp', 'heic', 'heif'];
  const imageMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', ...HEIC_MIME_TYPES];

  if (file.fieldname === 'file') {
    const importExtensions = ['csv', 'xls', 'xlsx'];
    const importMimeTypes = [
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ];

    if (importExtensions.includes(ext) && importMimeTypes.includes(file.mimetype)) {
      return cb(null, true);
    }

    return cb(uploadTypeError('อนุญาตเฉพาะไฟล์ CSV, XLS หรือ XLSX'), false);
  }

  if (file.fieldname === 'written_document') {
    const documentExtensions = ['pdf', 'doc', 'docx', ...imageExtensions];
    const documentMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ...imageMimeTypes,
    ];
    const hasValidDocumentExt = documentExtensions.includes(ext);
    const hasValidDocumentMime = documentMimeTypes.includes(file.mimetype) || file.mimetype === 'application/octet-stream';

    if (hasValidDocumentExt && hasValidDocumentMime) {
      return cb(null, true);
    }

    return cb(uploadTypeError('อนุญาตเฉพาะไฟล์ PDF, Word หรือรูปภาพ (JPEG, PNG, WebP)'), false);
  }

  if (imageExtensions.includes(ext) && imageMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(uploadTypeError('อนุญาตเฉพาะไฟล์ภาพ (JPEG, PNG, WebP, HEIC)'), false);
  }
};

const multerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

function collectUploadedFiles(req) {
  const files = [];

  if (req.file) {
    files.push(req.file);
  }

  if (req.files) {
    if (Array.isArray(req.files)) {
      files.push(...req.files);
    } else {
      Object.values(req.files).forEach(fileGroup => {
        files.push(...(Array.isArray(fileGroup) ? fileGroup : [fileGroup]));
      });
    }
  }

  return files.filter(file => file && file.path);
}

function isResizableImage(file) {
  return RESIZABLE_IMAGE_MIME_TYPES.has(file.mimetype);
}

async function resizeUploadedImage(file) {
  // ── Step 1: แปลง HEIC → JPEG ก่อน (ถ้าจำเป็น) ──────────────────────────────
  const isHeicMime = HEIC_MIME_TYPES.has(file.mimetype);
  const isHeicExt  = /\.(heic|heif)$/i.test(file.originalname || '');
  // บางครั้ง iPhone ส่ง mimetype เป็น image/jpeg แต่จริงๆ เป็น HEIC
  const isHeicMagicBytes = !isHeicMime && !isHeicExt ? isHeicByMagic(file.path) : false;

  if (isHeicMime || isHeicExt || isHeicMagicBytes) {
    await convertHeicToJpeg(file);
  }

  // ── Step 2: Resize ด้วย Sharp ────────────────────────────────────────────────
  if (!isResizableImage(file)) return;

  const tmpPath = `${file.path}.resized-${crypto.randomBytes(6).toString('hex')}`;
  let pipeline = sharp(file.path)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

  if (file.mimetype === 'image/png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (file.mimetype === 'image/webp') {
    pipeline = pipeline.webp({ quality: 82 });
  } else {
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  }

  await pipeline.toFile(tmpPath);
  await fs.promises.rename(tmpPath, file.path);

  const stat = await fs.promises.stat(file.path);
  file.size = stat.size;
}

async function resizeUploadedImages(req, res, next) {
  try {
    const files = collectUploadedFiles(req);
    await Promise.all(files.map(resizeUploadedImage));
    next();
  } catch (err) {
    cleanupUploadedFiles(req);
    next(err);
  }
}

function wrapUploadMethod(methodName) {
  const originalMethod = multerUpload[methodName].bind(multerUpload);
  return (...args) => [originalMethod(...args), resizeUploadedImages];
}

const upload = multerUpload;
upload.single = wrapUploadMethod('single');
upload.array = wrapUploadMethod('array');
upload.fields = wrapUploadMethod('fields');
upload.any = wrapUploadMethod('any');
upload.resizeUploadedImages = resizeUploadedImages;

function cleanupUploadedFiles(req) {
  const paths = collectUploadedFiles(req).map(file => file.path);

  paths.forEach(filePath => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Failed to remove uploaded file:', err.message);
    }
  });
}

upload.cleanupUploadedFiles = cleanupUploadedFiles;

module.exports = upload;
