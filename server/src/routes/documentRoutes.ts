import { Router } from 'express';
import multer from 'multer';
import { uploadDocument } from '../controllers/documentController.js';

const router = Router();

// Configure Multer
// Senior Trick: memoryStorage() keeps the file in RAM. Perfect for RAG.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Limit file size to 10MB (Security/DoS prevention)
  },
  fileFilter: (req, file, cb) => {
    // Only accept PDFs
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'));
    }
  },
});

// Route: POST /api/documents/upload
router.post('/upload', upload.single('document'), uploadDocument);

export default router;