import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import documentRoutes from './routes/documentRoutes.js';

const app = express();

app.use(cors()); // Allows our React frontend to talk to our backend
app.use(express.json()); // Allows us to read JSON data sent by clients

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'RAG Backend is running!' });
});

app.use('/api/documents', documentRoutes); // Upload, search, chat, module list

// Centralized error handler. Multer rejects oversized files and non-PDF
// uploads before the controller runs, so return a clean 400 for those.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const isUploadError =
    err?.name === 'MulterError' || err?.message === 'Only PDF files are allowed!';
  const status = isUploadError ? 400 : 500;

  console.error('Request Error:', err);
  res.status(status).json({
    error: err?.message || 'Internal server error.',
  });
});

export default app;
