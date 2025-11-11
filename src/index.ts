/**
 * metadata-service
 *
 * Cloudflare Worker that performs PINAX metadata extraction and validation
 * for the Arke Institute photo archive.
 */

import type {
  Env,
  ExtractMetadataRequest,
  ValidateMetadataRequest
} from './types';
import { extractMetadata } from './metadata-extractor';
import { validatePinaxMetadata } from './metadata-validator';

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

    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed. Use POST.' }),
        {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // Route handling
    const url = new URL(request.url);

    // Metadata extraction endpoint
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
    return new Response(
      JSON.stringify({
        error: 'Not found',
        available_endpoints: ['/extract-metadata', '/validate-metadata']
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
};
