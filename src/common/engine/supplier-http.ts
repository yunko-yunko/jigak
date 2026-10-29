/** Bound the decoded body as well as time spent waiting for supplier headers/body. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface SupplierRequest {
  request: (signal: AbortSignal) => Promise<Response>;
  validateResponse: (response: Response) => void;
  timeoutMs: number;
  timeoutError: () => Error;
  responseError: () => Error;
}

/**
 * A supplier transport can ignore abort, including while reading or cancelling
 * a body. The deadline owns completion; cleanup is best effort and cannot hold
 * a route search open. A late response is still cancelled when it arrives.
 */
export async function requestSupplierText(options: SupplierRequest): Promise<string> {
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelStarted = false;

  const cancelBody = () => {
    if (cancelStarted || !response?.body) {
      return;
    }

    cancelStarted = true;

    try {
      void (reader ? reader.cancel() : response.body.cancel()).catch(() => {});
    } catch {
      /* Cleanup cannot replace the supplier result. */
    }
  };

  let timer: ReturnType<typeof setTimeout>;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancelBody();
      reject(options.timeoutError());
    }, options.timeoutMs);
  });

  const operation = (async () => {
    response = await options.request(controller.signal);

    try {
      if (controller.signal.aborted) {
        throw options.timeoutError();
      }

      options.validateResponse(response);

      const advertisedBytes = Number(response.headers.get('content-length'));

      if (advertisedBytes > MAX_RESPONSE_BYTES) {
        throw options.responseError();
      }

      if (!response.body) {
        return '';
      }

      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let bytes = 0,
        result = '';

      while (true) {
        const part = await reader.read();

        if (controller.signal.aborted) {
          throw options.timeoutError();
        }

        if (part.done) {
          break;
        }

        bytes += part.value.byteLength;

        if (bytes > MAX_RESPONSE_BYTES) {
          throw options.responseError();
        }

        result += decoder.decode(part.value, {
          stream: true,
        });
      }

      result += decoder.decode();
      reader.releaseLock();

      return result;
    } catch (error) {
      cancelBody();

      if (controller.signal.aborted) {
        throw options.timeoutError();
      }

      throw error;
    }
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
