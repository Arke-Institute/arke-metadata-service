/**
 * metadata-service
 *
 * Cloudflare Worker that performs PINAX metadata extraction and validation
 * for the Arke Institute photo archive.
 *
 * Endpoints:
 * - POST /process - Batch processing via Durable Object (async, callbacks to orchestrator)
 * - GET /status/:chunkId - Check batch processing status
 * - POST /extract-metadata - Direct synchronous extraction (for testing/debugging)
 * - POST /validate-metadata - Schema validation
 */

import type {
  Env,
  ExtractMetadataRequest,
  ValidateMetadataRequest,
  ProcessRequest,
} from './types';
import { extractMetadata } from './metadata-extractor';
import { validatePinaxMetadata } from './metadata-validator';

// Re-export the Durable Object class
export { PinaxBatchDO } from './durable-objects/PinaxBatchDO';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Route handling
    const url = new URL(request.url);

    // === Durable Object routes (batch processing) ===

    // POST /process - Start batch processing
    if (request.method === 'POST' && url.pathname === '/process') {
      try {
        const body = (await request.json()) as ProcessRequest;

        // Validate required fields
        if (!body.batch_id || !body.chunk_id || !body.pis) {
          return Response.json(
            { error: 'Missing required fields: batch_id, chunk_id, pis' },
            { status: 400 }
          );
        }

        // Get or create DO instance using chunk_id as the unique identifier
        const doId = env.PINAX_BATCH_DO.idFromName(body.chunk_id);
        const stub = env.PINAX_BATCH_DO.get(doId);

        // Forward request to DO
        return stub.fetch(new Request('https://do/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      } catch (error) {
        console.error('Error starting batch process:', error);
        return Response.json(
          { error: (error as Error).message },
          { status: 500 }
        );
      }
    }

    // GET /status/:chunkId - Check batch status
    if (request.method === 'GET' && url.pathname.startsWith('/status/')) {
      try {
        const chunkId = url.pathname.slice('/status/'.length);
        if (!chunkId) {
          return Response.json({ error: 'Missing chunk_id' }, { status: 400 });
        }

        const doId = env.PINAX_BATCH_DO.idFromName(chunkId);
        const stub = env.PINAX_BATCH_DO.get(doId);

        return stub.fetch(new Request('https://do/status'));
      } catch (error) {
        console.error('Error checking status:', error);
        return Response.json(
          { error: (error as Error).message },
          { status: 500 }
        );
      }
    }

    // === Legacy synchronous endpoints ===

    // Only accept POST for remaining endpoints
    if (request.method !== 'POST') {
      return Response.json(
        { error: 'Method not allowed. Use POST for extraction/validation.' },
        {
          status: 405,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    // Metadata extraction endpoint (synchronous, for testing)
    if (url.pathname === '/extract-metadata') {
      try {
        // Parse request body
        let body: ExtractMetadataRequest;
        try {
          body = await request.json() as ExtractMetadataRequest;
        } catch (e) {
          return new Response(
            JSON.stringify({ error: 'Invalid JSON in request body' }),
            {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            }
          );
        }

        // Validate environment variables
        if (!env.DEEPINFRA_API_KEY || !env.DEEPINFRA_BASE_URL) {
          throw new Error('API configuration missing');
        }

        // Extract metadata
        const result = await extractMetadata(body, env);

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (error) {
        console.error('Error extracting metadata:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(
          JSON.stringify({
            error: errorMessage,
            timestamp: new Date().toISOString()
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }
    }

    // Metadata validation endpoint
    if (url.pathname === '/validate-metadata') {
      try {
        // Parse request body
        let body: ValidateMetadataRequest;
        try {
          body = await request.json() as ValidateMetadataRequest;
        } catch (e) {
          return new Response(
            JSON.stringify({ error: 'Invalid JSON in request body' }),
            {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            }
          );
        }

        // Validate metadata
        const validation = validatePinaxMetadata(body.metadata);

        return new Response(JSON.stringify(validation), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (error) {
        console.error('Error validating metadata:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(
          JSON.stringify({ error: errorMessage }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }
    }

    // Unknown endpoint
    return Response.json(
      {
        error: 'Not found',
        available_endpoints: [
          'POST /process',
          'GET /status/:chunkId',
          'POST /extract-metadata',
          'POST /validate-metadata',
        ],
      },
      {
        status: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }
    );
  },
};
