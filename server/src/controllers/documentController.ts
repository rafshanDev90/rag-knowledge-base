import { Request, Response } from 'express';
import { PDFParse } from 'pdf-parse';
import { processAndSaveChunks } from '../services/chunkingService.js';
import { DocumentChunk } from '../models/DocumentChunk.js';

const DEFAULT_TENANT = 'tenant_default_123';

const clampInt = (
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number => {
  const parsed =
    typeof value === 'string'
      ? Number.parseInt(value, 10)
      : typeof value === 'number'
        ? value
        : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

export const uploadDocument = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();

  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Use the "document" form field.' });
      return;
    }

    const tenantId =
      typeof req.body?.tenantId === 'string' && req.body.tenantId.trim()
        ? req.body.tenantId.trim()
        : DEFAULT_TENANT;

    const chunkSize = clampInt(req.body?.chunkSize, 200, 4000, 1000);
    const chunkOverlap = clampInt(
      req.body?.chunkOverlap,
      0,
      chunkSize - 1,
      Math.min(200, chunkSize - 1)
    );

    const parser = new PDFParse({ data: req.file.buffer });
    const pdfData = await parser.getText();

    if (!pdfData.text || pdfData.text.trim().length === 0) {
      res.status(422).json({
        error:
          'No extractable text found in this PDF. It may be scanned; OCR is not supported yet.',
      });
      return;
    }

    const pages = (pdfData.pages ?? []).map((page) => ({
      num: page.num,
      text: page.text,
    }));

    const result = await processAndSaveChunks(pdfData.text, req.file.originalname, {
      tenantId,
      chunkSize,
      chunkOverlap,
      pages,
    });

    res.status(200).json({
      message: result.skipped
        ? 'File already ingested; no duplicate chunks were created.'
        : 'File processed successfully.',
      fileName: req.file.originalname,
      tenantId,
      totalPages: pdfData.total ?? pages.length,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (error: any) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process the document.' });
  }
};

/**
 * List ingested modules for a tenant, grouped by document.
 * Used by the CLI `/modules` command.
 */
export const listDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId =
      typeof req.query.tenantId === 'string' && req.query.tenantId.trim()
        ? req.query.tenantId.trim()
        : DEFAULT_TENANT;

    const documents = await DocumentChunk.aggregate([
      { $match: { tenantId } },
      {
        $group: {
          _id: { sourceHash: '$sourceHash', sourceFile: '$sourceFile' },
          chunks: { $sum: 1 },
          tokens: { $sum: '$tokenCount' },
          pages: { $max: '$page' },
          ingestedAt: { $min: '$ingestedAt' },
        },
      },
      {
        $project: {
          _id: 0,
          sourceHash: '$_id.sourceHash',
          sourceFile: '$_id.sourceFile',
          chunks: 1,
          tokens: 1,
          pages: 1,
          ingestedAt: 1,
        },
      },
      { $sort: { ingestedAt: -1 } },
    ]);

    res.status(200).json({ count: documents.length, documents });
  } catch (error: any) {
    console.error('List Documents Error:', error);
    res.status(500).json({ error: error.message || 'Failed to list documents.' });
  }
};
