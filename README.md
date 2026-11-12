<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 1100px; margin: 0 auto; padding: 24px;">
  <header style="border-bottom: 1px solid #e5e7eb; padding-bottom: 18px; margin-bottom: 24px;">
    <h1 style="margin: 0 0 8px; font-size: 2rem; color: #111827;">RAG Knowledge Base</h1>
    <p style="margin: 0; font-size: 1rem; color: #4b5563;">
      A lightweight document-powered knowledge system built to ingest, chunk, and prepare PDF content for future retrieval and AI-driven answers.
    </p>
  </header>

  <section style="margin-bottom: 28px;">
    <h2 style="font-size: 1.3rem; color: #111827; margin-bottom: 12px;">What we are building</h2>
    <ul style="margin: 0; padding-left: 20px; color: #374151;">
      <li>PDF upload and document ingestion workflow</li>
      <li>Text extraction and chunk-based document segmentation</li>
      <li>MongoDB storage for structured, retrievable knowledge chunks</li>
      <li>Scalable backend foundation for future semantic search and LLM responses</li>
    </ul>
  </section>

  <section style="margin-bottom: 28px;">
    <h2 style="font-size: 1.3rem; color: #111827; margin-bottom: 12px;">How we are building it</h2>
    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">Node.js</span>
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">TypeScript</span>
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">Express</span>
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">MongoDB</span>
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">PDF Parsing</span>
      <span style="padding: 8px 12px; border-radius: 999px; background: #f3f4f6; color: #111827; font-size: 0.9rem;">Chunking Pipeline</span>
    </div>
  </section>

  <section style="margin-bottom: 28px;">
    <h2 style="font-size: 1.3rem; color: #111827; margin-bottom: 12px;">Project structure</h2>
    <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; overflow: auto;">
      <pre style="margin: 0; font-size: 0.9rem; color: #1f2937; white-space: pre-wrap;">
rag-knowledge-base/
├─ client/
├─ doc/
│  └─ ch3.pdf
├─ server/
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/
│     ├─ app.ts
│     ├─ server.ts
│     ├─ config/
│     │  ├─ db.ts
│     │  └─ env.ts
│     ├─ controllers/
│     │  └─ documentController.ts
│     ├─ models/
│     │  └─ DocumentChunk.ts
│     ├─ routes/
│     │  └─ documentRoutes.ts
│     └─ services/
│        └─ chunkingService.ts
      </pre>
    </div>
  </section>

  <section style="margin-bottom: 28px;">
    <h2 style="font-size: 1.3rem; color: #111827; margin-bottom: 12px;">Current API</h2>
    <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #fff;">
      <thead>
        <tr style="background: #f3f4f6; text-align: left;">
          <th style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">Method</th>
          <th style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">Endpoint</th>
          <th style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">GET</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">/health</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">Checks whether the backend is running.</td>
        </tr>
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">POST</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">/api/documents/upload</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">Uploads a PDF, extracts text, chunks it, and stores the chunks in MongoDB.</td>
        </tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2 style="font-size: 1.3rem; color: #111827; margin-bottom: 12px;">Current status</h2>
    <p style="margin: 0; color: #374151;">
      The project currently focuses on the ingestion pipeline: upload a document, extract its text, split it into reusable chunks, and save those chunks with metadata for future retrieval workflows.
    </p>
  </section>
</div>
