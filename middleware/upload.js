const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function uploadTypeError(message) {
  const err = new Error(message);
  err.code = 'EUPLOADTYPE';
  return err;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads/';
    if (file.fieldname === 'motorcycle_photo') folder += 'motorcycles/';
    else if (file.fieldname === 'plate_photo') folder += 'plates/';
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

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const imageExtensions = ['jpeg', 'jpg', 'png', 'webp'];
  const imageMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

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
    cb(uploadTypeError('อนุญาตเฉพาะไฟล์ภาพ (JPEG, PNG, WebP)'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

function cleanupUploadedFiles(req) {
  const paths = [];

  if (req.file && req.file.path) {
    paths.push(req.file.path);
  }

  if (req.files) {
    if (Array.isArray(req.files)) {
      req.files.forEach(file => {
        if (file && file.path) paths.push(file.path);
      });
    } else {
      Object.values(req.files).forEach(files => {
        (Array.isArray(files) ? files : [files]).forEach(file => {
          if (file && file.path) paths.push(file.path);
        });
      });
    }
  }

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
