import express from 'express';
import cors from 'cors';
import documentRoutes from './routes/documentRoutes.js';

const app = express();

app.use(cors()); // Allows our React frontend to talk to our backend
app.use(express.json()); // Allows us to read JSON data sent in requests

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'RAG Backend is running!' });
});

app.use('/api/documents', documentRoutes); // Use the document routes under the /api/documents path


export default app;