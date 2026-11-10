import { Request, Response } from 'express';
import { PDFParse } from 'pdf-parse'; // 1. Import the Class directly


export const uploadDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Check if a file was uploaded
    // Senior Trick: TypeScript doesn't know what req.file is by default.
    // Multer adds it, so we check if it exists.
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Please upload a PDF.' });
      return;
    }

    // 2. Extract text from the PDF buffer (in memory)
    const parser = new PDFParse({data: req.file.buffer});
   // 3. Call the getText() method
    const pdfData = await parser.getText();
    const rawText = pdfData.text;
    // 3. Clean the text (remove extra newlines, spaces)
    const cleanedText = rawText.replace(/\s+/g, ' ').trim();

    // 4. Return the text to the user for now (We will save this to DB in Step 3)
    res.status(200).json({
      message: 'File processed successfully',
      fileName: req.file.originalname,
      textLength: cleanedText.length,
      preview: cleanedText.substring(0, 200) + '...', // Just show a preview
    });

  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: 'Failed to process the document.' });
  }
};