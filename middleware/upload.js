const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads/';
    if (file.fieldname === 'motorcycle_photo') folder += 'motorcycles/';
    else if (file.fieldname === 'plate_photo') folder += 'plates/';
    else if (file.fieldname === 'id_card_photo') folder += 'id-cards/';
    else if (file.fieldname === 'evidence_photo') folder += 'evidence/';
    else if (file.fieldname === 'written_document') folder += 'summons-documents/';
    else if (file.fieldname === 'search_image') folder += 'temp/';
    else folder += 'misc/';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const imageExtensions = ['jpeg', 'jpg', 'png', 'webp'];
  const imageMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

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

    return cb(new Error('อนุญาตเฉพาะไฟล์ PDF, Word หรือรูปภาพ (JPEG, PNG, WebP)'), false);
  }

  if (imageExtensions.includes(ext) && imageMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('อนุญาตเฉพาะไฟล์ภาพ (JPEG, PNG, WebP)'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

module.exports = upload;
