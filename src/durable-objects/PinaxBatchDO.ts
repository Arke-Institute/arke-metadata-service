/**
 * PINAX Batch Durable Object (SQLite-backed)
 *
 * Processes a batch of PIs in parallel:
 * 1. Fetch context from IPFS for each PI (text files, refs with OCR, child pinaxes)
 * 2. Generate PINAX metadata using LLM (with retry)
 * 3. Upload pinax.json to IPFS
 * 4. Update entities with new versions
 * 5. Callback to orchestrator with results
 *
 * Uses SQLite storage for robustness with large content:
 * - 10GB per DO (vs 128KB per value with KV)
 * - Can store entire books, large collections, etc.
 * - Context files stored in separate rows for efficient access
 */

import { DurableObject } from 'cloudflare:workers';
import {
  Env,
  ProcessRequest,
  PIState,
  Phase,
  CallbackPayload,
  PinaxMetadata,
  PinaxContext,
} from '../types';
import { IPFSClient } from '../services/ipfs-client';
import { fetchPinaxContext } from '../lib/context-fetcher';
import { extractMetadata } from '../metadata-extractor';
import { withRetry } from '../lib/retry';

export class PinaxBatchDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private ipfsClient: IPFSClient;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ipfsClient = new IPFSClient(env.IPFS_WRAPPER);
  }

  /**
   * Initialize SQL tables if needed
   */
  private initTables(): void {
    if (this.initialized) return;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS batch_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        batch_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        r2_prefix TEXT,
        custom_prompt TEXT,
        institution TEXT,
        phase TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        callback_retry_count INTEGER DEFAULT 0,
        global_error TEXT
      );

      CREATE TABLE IF NOT EXISTS pi_list (
        pi TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS pi_state (
        pi TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        pinax_json TEXT,
        pinax_cid TEXT,
        new_tip TEXT,
        new_version INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS context_files (
        pi TEXT NOT NULL,
        idx INTEGER NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (pi, idx)
      );

      CREATE TABLE IF NOT EXISTS context_meta (
        pi TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        existing_pinax_json TEXT
      );
    `);

    this.initialized = true;
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
    this.initTables();
    const body = (await request.json()) as ProcessRequest;

    // Check if already processing (use toArray() since .one() throws if no results)
    const existingRows = [...this.sql.exec('SELECT phase FROM batch_state WHERE id = 1')];
    if (existingRows.length > 0) {
      const phase = existingRows[0].phase as Phase;
      if (phase !== 'DONE' && phase !== 'ERROR') {
        return Response.json({
          status: 'already_processing',
          chunk_id: body.chunk_id,
          phase,
        });
      }
      // Clear old state for reprocessing
      this.sql.exec('DELETE FROM batch_state');
      this.sql.exec('DELETE FROM pi_list');
      this.sql.exec('DELETE FROM pi_state');
      this.sql.exec('DELETE FROM context_files');
      this.sql.exec('DELETE FROM context_meta');
    }

    const chunkId = `${body.batch_id}:${body.chunk_id}`;
    console.log(`[Pinax:${chunkId}] Starting batch with ${body.pis.length} PIs`);

    // Initialize batch state
    this.sql.exec(
      `INSERT INTO batch_state (id, batch_id, chunk_id, r2_prefix, custom_prompt, institution, phase, started_at, callback_retry_count)
       VALUES (1, ?, ?, ?, ?, ?, 'PROCESSING', ?, 0)`,
      body.batch_id,
      body.chunk_id,
      body.r2_prefix || '',
      body.custom_prompt || null,
      body.institution || null,
      new Date().toISOString()
    );

    // Initialize PI list and states
    for (const pi of body.pis) {
      this.sql.exec('INSERT INTO pi_list (pi) VALUES (?)', pi);
      this.sql.exec(
        'INSERT INTO pi_state (pi, status, retry_count) VALUES (?, ?, 0)',
        pi,
        'pending'
      );
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
    this.initTables();

    const stateRows = [...this.sql.exec('SELECT * FROM batch_state WHERE id = 1')];
    if (stateRows.length === 0) {
      return Response.json({ status: 'not_found' });
    }
    const state = stateRows[0];

    // Count statuses
    const countRows = [...this.sql.exec(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
      FROM pi_state
    `)];
    const counts = countRows[0];

    return Response.json({
      status: (state.phase as string).toLowerCase(),
      phase: state.phase,
      progress: {
        total: counts?.total || 0,
        pending: counts?.pending || 0,
        processing: counts?.processing || 0,
        done: counts?.done || 0,
        failed: counts?.failed || 0,
      },
    });
  }

  /**
   * Alarm handler - Process state machine
   */
  async alarm(): Promise<void> {
    this.initTables();

    const stateRows = [...this.sql.exec('SELECT * FROM batch_state WHERE id = 1')];
    if (stateRows.length === 0) return;
    const state = stateRows[0];

    const chunkId = `${state.batch_id}:${state.chunk_id}`;

    try {
      switch (state.phase as Phase) {
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
      this.sql.exec(
        'UPDATE batch_state SET phase = ?, global_error = ? WHERE id = 1',
        'CALLBACK',
        (error as Error).message
      );
      await this.scheduleNextAlarm();
    }
  }

  /**
   * PROCESSING phase: Fetch context and generate PINAX metadata for all PIs
   */
  private async processPhase(): Promise<void> {
    const stateRows = [...this.sql.exec('SELECT * FROM batch_state WHERE id = 1')];
    const state = stateRows[0];
    const chunkId = `${state.batch_id}:${state.chunk_id}`;
    const maxRetries = parseInt(this.env.MAX_RETRIES_PER_PI || '3');

    // Get pending PIs
    const pendingRows = [...this.sql.exec("SELECT pi FROM pi_state WHERE status = 'pending'")];

    if (pendingRows.length === 0) {
      console.log(`[Pinax:${chunkId}] Processing complete, moving to PUBLISHING`);
      this.sql.exec("UPDATE batch_state SET phase = 'PUBLISHING' WHERE id = 1");
      await this.scheduleNextAlarm();
      return;
    }

    console.log(`[Pinax:${chunkId}] Processing ${pendingRows.length} PIs in parallel`);

    // Mark all as processing
    for (const row of pendingRows) {
      this.sql.exec("UPDATE pi_state SET status = 'processing' WHERE pi = ?", row.pi);
    }

    // Process all in parallel
    const results = await Promise.allSettled(
      pendingRows.map((row) => this.processPI(row.pi as string, state))
    );

    // Update states based on results
    for (let i = 0; i < pendingRows.length; i++) {
      const pi = pendingRows[i].pi as string;
      const result = results[i];

      // Clear context after processing (success or failure)
      this.sql.exec('DELETE FROM context_files WHERE pi = ?', pi);
      this.sql.exec('DELETE FROM context_meta WHERE pi = ?', pi);

      if (result.status === 'fulfilled') {
        this.sql.exec(
          "UPDATE pi_state SET status = 'done', pinax_json = ? WHERE pi = ?",
          JSON.stringify(result.value),
          pi
        );
        console.log(`[Pinax:${chunkId}] ✓ ${pi}`);
      } else {
        const errorMsg = result.reason?.message || 'Unknown error';
        const retryRows = [...this.sql.exec('SELECT retry_count FROM pi_state WHERE pi = ?', pi)];
        const currentRetry = (retryRows[0]?.retry_count as number) || 0;
        const newRetry = currentRetry + 1;

        if (newRetry >= maxRetries) {
          this.sql.exec(
            "UPDATE pi_state SET status = 'error', retry_count = ?, error = ? WHERE pi = ?",
            newRetry,
            errorMsg,
            pi
          );
          console.error(`[Pinax:${chunkId}] ✗ ${pi} (max retries ${maxRetries}): ${errorMsg}`);
        } else {
          this.sql.exec(
            "UPDATE pi_state SET status = 'pending', retry_count = ? WHERE pi = ?",
            newRetry,
            pi
          );
          console.warn(`[Pinax:${chunkId}] ⟳ ${pi} retry ${newRetry}/${maxRetries}: ${errorMsg}`);
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  /**
   * Process a single PI: fetch context and generate PINAX metadata
   */
  private async processPI(pi: string, state: Record<string, SqlStorageValue>): Promise<PinaxMetadata> {
    // Check if we have cached context
    let context = this.loadContext(pi);

    // Fetch context from IPFS if not cached
    if (!context) {
      context = await fetchPinaxContext(pi, this.ipfsClient, this.env);
      // Store context in SQL for potential retry
      this.saveContext(pi, context);
    }

    // Skip if no content at all
    if (context.files.length === 0) {
      console.log(`[Pinax] ${pi}: No content, creating minimal metadata`);
      return {
        id: pi,
        title: context.directory_name,
        type: 'Collection',
        creator: 'Unknown',
        institution: (state.institution as string) || 'Unknown',
        created: new Date().getFullYear().toString(),
        access_url: `https://arke.institute/${pi}`,
        source: 'PINAX',
      };
    }

    // Call extraction logic
    const result = await extractMetadata(
      {
        directory_name: context.directory_name,
        files: context.files,
        access_url: `https://arke.institute/${pi}`,
        manual_metadata: state.institution ? { institution: state.institution as string } : {},
        custom_prompt: state.custom_prompt as string | undefined,
      },
      this.env
    );

    console.log(
      `[Pinax] Generated PINAX for ${pi}: ${result.metadata.title} (${result.tokens} tokens, $${result.cost_usd.toFixed(4)})`
    );

    return result.metadata;
  }

  /**
   * Load cached context from SQL
   */
  private loadContext(pi: string): PinaxContext | null {
    const metaRows = [...this.sql.exec('SELECT * FROM context_meta WHERE pi = ?', pi)];
    if (metaRows.length === 0) return null;
    const meta = metaRows[0];

    const fileRows = [...this.sql.exec(
      'SELECT filename, content FROM context_files WHERE pi = ? ORDER BY idx',
      pi
    )];

    return {
      directory_name: meta.directory_name as string,
      files: fileRows.map((r) => ({
        name: r.filename as string,
        content: r.content as string,
      })),
      existing_pinax: meta.existing_pinax_json
        ? JSON.parse(meta.existing_pinax_json as string)
        : undefined,
    };
  }

  /**
   * Save context to SQL for potential retry
   */
  private saveContext(pi: string, context: PinaxContext): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO context_meta (pi, directory_name, existing_pinax_json) VALUES (?, ?, ?)',
      pi,
      context.directory_name,
      context.existing_pinax ? JSON.stringify(context.existing_pinax) : null
    );

    for (let i = 0; i < context.files.length; i++) {
      this.sql.exec(
        'INSERT OR REPLACE INTO context_files (pi, idx, filename, content) VALUES (?, ?, ?, ?)',
        pi,
        i,
        context.files[i].name,
        context.files[i].content
      );
    }
  }

  /**
   * PUBLISHING phase: Upload PINAX metadata to IPFS and update entities
   */
  private async publishPhase(): Promise<void> {
    const stateRows = [...this.sql.exec('SELECT * FROM batch_state WHERE id = 1')];
    const state = stateRows[0];
    const chunkId = `${state.batch_id}:${state.chunk_id}`;

    // Get PIs that have PINAX but haven't been published yet
    const toPublish = [
      ...this.sql.exec(
        "SELECT pi, pinax_json FROM pi_state WHERE status = 'done' AND pinax_cid IS NULL"
      ),
    ];

    if (toPublish.length === 0) {
      console.log(`[Pinax:${chunkId}] Publishing complete, moving to CALLBACK`);
      this.sql.exec("UPDATE batch_state SET phase = 'CALLBACK' WHERE id = 1");
      await this.scheduleNextAlarm();
      return;
    }

    console.log(`[Pinax:${chunkId}] Publishing ${toPublish.length} results`);

    // Publish in parallel
    const results = await Promise.allSettled(
      toPublish.map((row) =>
        this.publishPI(row.pi as string, JSON.parse(row.pinax_json as string))
      )
    );

    // Update states
    for (let i = 0; i < toPublish.length; i++) {
      const pi = toPublish[i].pi as string;
      const result = results[i];

      if (result.status === 'fulfilled') {
        this.sql.exec(
          'UPDATE pi_state SET pinax_cid = ?, new_tip = ?, new_version = ? WHERE pi = ?',
          result.value.cid,
          result.value.tip,
          result.value.ver,
          pi
        );
        console.log(`[Pinax:${chunkId}] ✓ Published ${pi} v${result.value.ver}`);
      } else {
        this.sql.exec(
          "UPDATE pi_state SET status = 'error', error = ? WHERE pi = ?",
          `Publish failed: ${result.reason?.message}`,
          pi
        );
        console.error(`[Pinax:${chunkId}] ✗ Publish ${pi}: ${result.reason?.message}`);
      }
    }

    await this.scheduleNextAlarm();
  }

  /**
   * Publish a single PI's PINAX metadata to IPFS
   */
  private async publishPI(
    pi: string,
    pinax: PinaxMetadata
  ): Promise<{ cid: string; tip: string; ver: number }> {
    const pinaxJson = JSON.stringify(pinax, null, 2);

    // Upload to IPFS
    const cid = await this.ipfsClient.uploadContent(pinaxJson, 'pinax.json');

    // Append version with retry for CAS conflicts
    const result = await withRetry(
      async () => {
        const entity = await this.ipfsClient.getEntity(pi);
        return this.ipfsClient.appendVersion(
          pi,
          entity.tip,
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
    const stateRows = [...this.sql.exec('SELECT * FROM batch_state WHERE id = 1')];
    const state = stateRows[0];
    const chunkId = `${state.batch_id}:${state.chunk_id}`;
    const maxRetries = parseInt(this.env.MAX_CALLBACK_RETRIES || '3');

    // Load all PI states for callback
    const piStates = [...this.sql.exec('SELECT * FROM pi_state')];

    // Build callback payload
    const succeeded = piStates.filter((p) => p.status === 'done' && p.new_tip);
    const failed = piStates.filter((p) => p.status === 'error');

    const payload: CallbackPayload = {
      batch_id: state.batch_id as string,
      chunk_id: state.chunk_id as string,
      status:
        failed.length === 0 ? 'success' : succeeded.length === 0 ? 'error' : 'partial',
      results: piStates.map((pi) => ({
        pi: pi.pi as string,
        status: pi.status === 'done' && pi.new_tip ? 'success' : 'error',
        new_tip: pi.new_tip as string | undefined,
        new_version: pi.new_version as number | undefined,
        error: pi.error as string | undefined,
      })),
      summary: {
        total: piStates.length,
        succeeded: succeeded.length,
        failed: failed.length,
        processing_time_ms:
          Date.now() - new Date(state.started_at as string).getTime(),
      },
      error: state.global_error as string | undefined,
    };

    try {
      const callbackPath = `/callback/pinax/${state.batch_id}`;
      console.log(`[Pinax:${chunkId}] Sending callback via service binding to ${callbackPath}`);

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
      this.sql.exec(
        "UPDATE batch_state SET phase = 'DONE', completed_at = ? WHERE id = 1",
        new Date().toISOString()
      );
      await this.scheduleNextAlarm(); // Will trigger cleanup
    } catch (error) {
      const retryCount = ((state.callback_retry_count as number) || 0) + 1;

      if (retryCount >= maxRetries) {
        console.error(`[Pinax:${chunkId}] Callback failed after ${maxRetries} retries, giving up`);
        this.sql.exec(
          "UPDATE batch_state SET phase = 'DONE', completed_at = ?, callback_retry_count = ? WHERE id = 1",
          new Date().toISOString(),
          retryCount
        );
        await this.scheduleNextAlarm();
      } else {
        console.warn(
          `[Pinax:${chunkId}] Callback failed (attempt ${retryCount}/${maxRetries}), will retry: ${(error as Error).message}`
        );
        this.sql.exec(
          'UPDATE batch_state SET callback_retry_count = ? WHERE id = 1',
          retryCount
        );
        const delay = 1000 * Math.pow(2, retryCount);
        await this.ctx.storage.setAlarm(Date.now() + delay);
      }
    }
  }

  /**
   * Cleanup: Clear all tables after completion
   */
  private async cleanup(): Promise<void> {
    const stateRows = [...this.sql.exec('SELECT batch_id, chunk_id FROM batch_state WHERE id = 1')];
    const chunkId = stateRows.length > 0 ? `${stateRows[0].batch_id}:${stateRows[0].chunk_id}` : 'unknown';
    console.log(`[Pinax:${chunkId}] Cleaning up DO storage`);

    this.sql.exec('DELETE FROM batch_state');
    this.sql.exec('DELETE FROM pi_list');
    this.sql.exec('DELETE FROM pi_state');
    this.sql.exec('DELETE FROM context_files');
    this.sql.exec('DELETE FROM context_meta');
  }

  /**
   * Schedule next alarm
   */
  private async scheduleNextAlarm(): Promise<void> {
    const delay = parseInt(this.env.ALARM_INTERVAL_MS || '100');
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
