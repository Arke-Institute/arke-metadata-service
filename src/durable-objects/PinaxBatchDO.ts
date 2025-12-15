/**
 * PINAX Batch Durable Object
 *
 * Processes a batch of PIs in parallel:
 * 1. Fetch context from IPFS for each PI (text files, refs with OCR, child pinaxes)
 * 2. Generate PINAX metadata using LLM (with retry)
 * 3. Upload pinax.json to IPFS
 * 4. Update entities with new versions
 * 5. Callback to orchestrator with results
 *
 * IMPORTANT: PI states are stored in separate DO storage keys to avoid
 * exceeding the 128KB per-value limit. Each PI gets its own key.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  Env,
  ProcessRequest,
  BatchState,
  PIState,
  Phase,
  CallbackPayload,
  PinaxMetadata,
} from '../types';
import { IPFSClient } from '../services/ipfs-client';
import { fetchPinaxContext } from '../lib/context-fetcher';
import { extractMetadata } from '../metadata-extractor';
import { withRetry } from '../lib/retry';

export class PinaxBatchDO extends DurableObject<Env> {
  private state: BatchState | null = null;
  private ipfsClient: IPFSClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ipfsClient = new IPFSClient(env.IPFS_WRAPPER);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/process') {
      return this.handleProcess(request);
    }

    if (url.pathname === '/status') {
      return this.handleStatus();
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /**
   * Handle POST /process - Start batch processing
   */
  private async handleProcess(request: Request): Promise<Response> {
    const body = (await request.json()) as ProcessRequest;

    // Check if already processing
    await this.loadState();
    if (this.state && this.state.phase !== 'DONE' && this.state.phase !== 'ERROR') {
      return Response.json({
        status: 'already_processing',
        chunk_id: this.state.chunk_id,
        phase: this.state.phase,
      });
    }

    const chunkId = `${body.batch_id}:${body.chunk_id}`;
    console.log(`[Pinax:${chunkId}] Starting batch with ${body.pis.length} PIs`);

    // Initialize batch state (just metadata, no PI data)
    this.state = {
      batch_id: body.batch_id,
      chunk_id: body.chunk_id,
      r2_prefix: body.r2_prefix,
      custom_prompt: body.custom_prompt,
      institution: body.institution,
      phase: 'PROCESSING',
      started_at: new Date().toISOString(),
      pi_list: body.pis.map((p) => p.pi),
      callback_retry_count: 0,
    };

    await this.saveState();

    // Initialize each PI's state separately
    for (const p of body.pis) {
      const piState: PIState = {
        pi: p.pi,
        status: 'pending',
        retry_count: 0,
      };
      await this.savePIState(p.pi, piState);
    }

    // Schedule immediate processing
    await this.ctx.storage.setAlarm(Date.now() + 100);

    return Response.json({
      status: 'accepted',
      chunk_id: body.chunk_id,
      total_pis: body.pis.length,
    });
  }

  /**
   * Handle GET /status - Return current status
   */
  private async handleStatus(): Promise<Response> {
    if (!this.state) {
      await this.loadState();
    }

    if (!this.state) {
      return Response.json({ status: 'not_found' });
    }

    // Count statuses from individual PI states
    let pending = 0,
      processing = 0,
      done = 0,
      failed = 0;

    for (const pi of this.state.pi_list) {
      const piState = await this.loadPIState(pi);
      if (!piState) continue;
      switch (piState.status) {
        case 'pending':
          pending++;
          break;
        case 'processing':
          processing++;
          break;
        case 'done':
          done++;
          break;
        case 'error':
          failed++;
          break;
      }
    }

    return Response.json({
      status: this.state.phase.toLowerCase(),
      phase: this.state.phase,
      progress: {
        total: this.state.pi_list.length,
        pending,
        processing,
        done,
        failed,
      },
    });
  }

  /**
   * Alarm handler - Process state machine
   */
  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) return;

    const chunkId = `${this.state.batch_id}:${this.state.chunk_id}`;

    try {
      switch (this.state.phase) {
        case 'PROCESSING':
          await this.processPhase();
          break;
        case 'PUBLISHING':
          await this.publishPhase();
          break;
        case 'CALLBACK':
          await this.callbackPhase();
          break;
        case 'DONE':
        case 'ERROR':
          await this.cleanup();
          break;
      }
    } catch (error) {
      console.error(`[Pinax:${chunkId}] Alarm error:`, error);
      this.state.phase = 'ERROR';
      this.state.global_error = (error as Error).message;
      await this.saveState();
      // Move to callback to report error
      this.state.phase = 'CALLBACK';
      await this.saveState();
      await this.scheduleNextAlarm();
    }
  }

  /**
   * PROCESSING phase: Fetch context and generate PINAX metadata for all PIs
   */
  private async processPhase(): Promise<void> {
    const chunkId = `${this.state!.batch_id}:${this.state!.chunk_id}`;
    const maxRetries = parseInt(this.env.MAX_RETRIES_PER_PI || '3');

    // Load all PI states and filter for pending
    const pendingPIs: PIState[] = [];
    for (const pi of this.state!.pi_list) {
      const piState = await this.loadPIState(pi);
      if (piState && piState.status === 'pending') {
        pendingPIs.push(piState);
      }
    }

    if (pendingPIs.length === 0) {
      // All done processing, move to publishing
      console.log(`[Pinax:${chunkId}] Processing complete, moving to PUBLISHING`);
      this.state!.phase = 'PUBLISHING';
      await this.saveState();
      await this.scheduleNextAlarm();
      return;
    }

    console.log(`[Pinax:${chunkId}] Processing ${pendingPIs.length} PIs in parallel`);

    // Mark all as processing
    for (const pi of pendingPIs) {
      pi.status = 'processing';
      await this.savePIState(pi.pi, pi);
    }

    // Process all in parallel
    const results = await Promise.allSettled(pendingPIs.map((pi) => this.processPI(pi)));

    // Update states based on results
    for (let i = 0; i < pendingPIs.length; i++) {
      const pi = pendingPIs[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        pi.status = 'done';
        pi.pinax = result.value;
        // Clear context to save storage space after successful processing
        delete pi.context;
        console.log(`[Pinax:${chunkId}] ✓ ${pi.pi}`);
      } else {
        pi.retry_count++;
        const errorMsg = result.reason?.message || 'Unknown error';

        if (pi.retry_count >= maxRetries) {
          pi.status = 'error';
          pi.error = errorMsg;
          // Clear context on error too
          delete pi.context;
          console.error(
            `[Pinax:${chunkId}] ✗ ${pi.pi} (max retries ${maxRetries}): ${errorMsg}`
          );
        } else {
          pi.status = 'pending'; // Will retry on next alarm
          console.warn(
            `[Pinax:${chunkId}] ⟳ ${pi.pi} retry ${pi.retry_count}/${maxRetries}: ${errorMsg}`
          );
        }
      }

      await this.savePIState(pi.pi, pi);
    }

    await this.scheduleNextAlarm();
  }

  /**
   * Process a single PI: fetch context and generate PINAX metadata
   */
  private async processPI(pi: PIState): Promise<PinaxMetadata> {
    // Fetch context from IPFS if not cached
    if (!pi.context) {
      pi.context = await fetchPinaxContext(pi.pi, this.ipfsClient, this.env);
    }

    // Skip if no content at all
    if (pi.context.files.length === 0) {
      console.log(`[Pinax] ${pi.pi}: No content, creating minimal metadata`);
      // Return minimal metadata for empty directories
      return {
        id: pi.pi,
        title: pi.context.directory_name,
        type: 'Collection',
        creator: 'Unknown',
        institution: this.state!.institution || 'Unknown',
        created: new Date().getFullYear().toString(),
        access_url: `https://arke.institute/${pi.pi}`,
        source: 'PINAX',
      };
    }

    // Call existing extraction logic
    const result = await extractMetadata(
      {
        directory_name: pi.context.directory_name,
        files: pi.context.files,
        access_url: `https://arke.institute/${pi.pi}`,
        manual_metadata: this.state!.institution ? { institution: this.state!.institution } : {},
        custom_prompt: this.state!.custom_prompt,
      },
      this.env
    );

    console.log(
      `[Pinax] Generated PINAX for ${pi.pi}: ${result.metadata.title} (${result.tokens} tokens, $${result.cost_usd.toFixed(4)})`
    );

    return result.metadata;
  }

  /**
   * PUBLISHING phase: Upload PINAX metadata to IPFS and update entities
   */
  private async publishPhase(): Promise<void> {
    const chunkId = `${this.state!.batch_id}:${this.state!.chunk_id}`;

    // Get PIs that have PINAX but haven't been published yet
    const toPublish: PIState[] = [];
    for (const pi of this.state!.pi_list) {
      const piState = await this.loadPIState(pi);
      if (piState && piState.status === 'done' && piState.pinax && !piState.pinax_cid) {
        toPublish.push(piState);
      }
    }

    if (toPublish.length === 0) {
      // All published, move to callback
      console.log(`[Pinax:${chunkId}] Publishing complete, moving to CALLBACK`);
      this.state!.phase = 'CALLBACK';
      await this.saveState();
      await this.scheduleNextAlarm();
      return;
    }

    console.log(`[Pinax:${chunkId}] Publishing ${toPublish.length} results`);

    // Publish in parallel
    const results = await Promise.allSettled(toPublish.map((pi) => this.publishPI(pi)));

    // Update states
    for (let i = 0; i < toPublish.length; i++) {
      const pi = toPublish[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        pi.pinax_cid = result.value.cid;
        pi.new_tip = result.value.tip;
        pi.new_version = result.value.ver;
        console.log(`[Pinax:${chunkId}] ✓ Published ${pi.pi} v${pi.new_version}`);
      } else {
        // Publishing failed - mark as error
        pi.status = 'error';
        pi.error = `Publish failed: ${result.reason?.message}`;
        console.error(`[Pinax:${chunkId}] ✗ Publish ${pi.pi}: ${pi.error}`);
      }

      await this.savePIState(pi.pi, pi);
    }

    await this.scheduleNextAlarm();
  }

  /**
   * Publish a single PI's PINAX metadata to IPFS
   *
   * NOTE: Fetches fresh tip inside retry loop to avoid stale tip bugs.
   * The orchestrator's tip can be stale due to bidirectional parent-child updates.
   */
  private async publishPI(
    pi: PIState
  ): Promise<{ cid: string; tip: string; ver: number }> {
    // Format PINAX as JSON
    const pinaxJson = JSON.stringify(pi.pinax, null, 2);

    // Upload to IPFS
    const cid = await this.ipfsClient.uploadContent(pinaxJson, 'pinax.json');

    // Append version to entity with retry for CAS conflicts
    // IMPORTANT: Fetch fresh tip inside retry loop to handle concurrent updates
    const result = await withRetry(
      async () => {
        // Always fetch fresh tip before attempting update
        const entity = await this.ipfsClient.getEntity(pi.pi);
        const freshTip = entity.tip;

        return this.ipfsClient.appendVersion(
          pi.pi,
          freshTip,
          { 'pinax.json': cid },
          'Added PINAX metadata'
        );
      },
      { maxRetries: 3, baseDelayMs: 500 }
    );

    return { cid, tip: result.tip, ver: result.ver };
  }

  /**
   * CALLBACK phase: Send results to orchestrator
   */
  private async callbackPhase(): Promise<void> {
    const chunkId = `${this.state!.batch_id}:${this.state!.chunk_id}`;
    const maxRetries = parseInt(this.env.MAX_CALLBACK_RETRIES || '3');

    // Load all PI states for callback
    const piStates: PIState[] = [];
    for (const pi of this.state!.pi_list) {
      const piState = await this.loadPIState(pi);
      if (piState) {
        piStates.push(piState);
      }
    }

    // Build callback payload
    const succeeded = piStates.filter((p) => p.status === 'done' && p.new_tip);
    const failed = piStates.filter((p) => p.status === 'error');

    const payload: CallbackPayload = {
      batch_id: this.state!.batch_id,
      chunk_id: this.state!.chunk_id,
      status:
        failed.length === 0
          ? 'success'
          : succeeded.length === 0
            ? 'error'
            : 'partial',
      results: piStates.map((pi) => ({
        pi: pi.pi,
        status: pi.status === 'done' && pi.new_tip ? 'success' : 'error',
        new_tip: pi.new_tip,
        new_version: pi.new_version,
        error: pi.error,
      })),
      summary: {
        total: piStates.length,
        succeeded: succeeded.length,
        failed: failed.length,
        processing_time_ms: Date.now() - new Date(this.state!.started_at).getTime(),
      },
      error: this.state!.global_error,
    };

    try {
      // Use service binding to call orchestrator
      const callbackPath = `/callback/pinax/${this.state!.batch_id}`;
      console.log(
        `[Pinax:${chunkId}] Sending callback via service binding to ${callbackPath}`
      );

      const resp = await this.env.ORCHESTRATOR.fetch(
        `https://orchestrator${callbackPath}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      if (!resp.ok) {
        throw new Error(`Callback failed: ${resp.status} ${await resp.text()}`);
      }

      console.log(
        `[Pinax:${chunkId}] Callback sent: ${succeeded.length} succeeded, ${failed.length} failed`
      );
      this.state!.phase = 'DONE';
      this.state!.completed_at = new Date().toISOString();
      await this.saveState();
      await this.scheduleNextAlarm(); // Will trigger cleanup
    } catch (error) {
      this.state!.callback_retry_count++;

      if (this.state!.callback_retry_count >= maxRetries) {
        console.error(
          `[Pinax:${chunkId}] Callback failed after ${maxRetries} retries, giving up`
        );
        this.state!.phase = 'DONE'; // Mark done anyway, log the failure
        this.state!.completed_at = new Date().toISOString();
        await this.saveState();
        await this.scheduleNextAlarm();
      } else {
        console.warn(
          `[Pinax:${chunkId}] Callback failed (attempt ${this.state!.callback_retry_count}/${maxRetries}), will retry: ${(error as Error).message}`
        );
        await this.saveState();
        // Retry with backoff
        const delay = 1000 * Math.pow(2, this.state!.callback_retry_count);
        await this.ctx.storage.setAlarm(Date.now() + delay);
      }
    }
  }

  /**
   * Cleanup: Clear DO storage after completion
   */
  private async cleanup(): Promise<void> {
    const chunkId = this.state
      ? `${this.state.batch_id}:${this.state.chunk_id}`
      : 'unknown';
    console.log(`[Pinax:${chunkId}] Cleaning up DO storage`);
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  /**
   * Load batch state from DO storage
   */
  private async loadState(): Promise<void> {
    this.state = (await this.ctx.storage.get<BatchState>('state')) || null;
  }

  /**
   * Save batch state to DO storage
   */
  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put('state', this.state);
    }
  }

  /**
   * Load a single PI's state from DO storage
   */
  private async loadPIState(pi: string): Promise<PIState | null> {
    return (await this.ctx.storage.get<PIState>(`pi:${pi}`)) || null;
  }

  /**
   * Save a single PI's state to DO storage
   */
  private async savePIState(pi: string, piState: PIState): Promise<void> {
    await this.ctx.storage.put(`pi:${pi}`, piState);
  }

  /**
   * Schedule next alarm
   */
  private async scheduleNextAlarm(): Promise<void> {
    const delay = parseInt(this.env.ALARM_INTERVAL_MS || '100');
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
