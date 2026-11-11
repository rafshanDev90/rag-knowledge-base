import { Request, Response } from 'express';
import { PDFParse } from 'pdf-parse';
import { processAndSaveChunks } from '../services/chunkingService.js';

export const uploadDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }

    const parser = new PDFParse({ data: req.file.buffer });
    const pdfData = await parser.getText();
    
    // We mock a tenantId for now (we'll add real auth later)
    const tenantId = "tenant_default_123";

    // Process chunks
    const result = await processAndSaveChunks(pdfData.text, req.file.originalname, {
      tenantId: tenantId,
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    res.status(200).json({
      message: 'File processed successfully',
      fileName: req.file.originalname,
      ...result, // Spreads sourceHash, totalChunks, insertedCount, etc.
    });

  } catch (error: any) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process the document.' });
  }
};