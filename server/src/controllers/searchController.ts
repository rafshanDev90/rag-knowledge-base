import { Request, Response } from 'express';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { generateEmbeddings } from '../services/embeddingService.js';

export const searchDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body;

    if (!query) {
      res.status(400).json({ error: 'Query is required.' });
      return;
    }

    // 1. Embed the user's query using the exact same model
    const queryEmbedding = (await generateEmbeddings([query]))[0];

    // 2. Perform MongoDB Atlas Vector Search
    // Senior Trick: The $vectorSearch pipeline stage MUST be the very first stage.
    const results = await DocumentChunk.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index', // The name we gave it in Atlas
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100, // How many candidates to consider before scoring
          limit: 3,           // How many final results to return
        },
      },
      {
        // 3. Project what we want to return (We exclude the embedding to save bandwidth)
        $project: {
          _id: 0,
          text: 1,
          sourceFile: 1,
          chunkIndex: 1,
          score: { $meta: 'vectorSearchScore' }, // Shows how similar the chunk is
        },
      },
    ]);

    res.status(200).json({
      query,
      results,
    });
  } catch (error: any) {
    console.error('Search Error:', error);
    res.status(500).json({ error: error.message || 'Failed to search.' });
  }
};