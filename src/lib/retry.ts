/**
 * Retry utility with exponential backoff
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelayMs = 1000, maxDelayMs = 30000 } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) break;

      // Calculate delay with jitter
      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000
      );

      console.log(
        `[Retry] Attempt ${attempt}/${maxRetries} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
