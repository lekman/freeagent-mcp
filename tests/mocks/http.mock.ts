import type { IHttpClient } from "../../src/auth";

/** One recorded request. */
export interface RecordedRequest {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

/** Scripted HTTP client: queued responses in, recorded requests out. */
export class HttpMock implements IHttpClient {
  /** Requests seen, in order. */
  readonly requests: RecordedRequest[] = [];
  private readonly responses: { body: string; status: number }[];

  constructor(responses: { body: string; status: number }[] = []) {
    this.responses = [...responses];
  }

  /** Record the request and return the next scripted response. */
  async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ body: string; status: number }> {
    this.requests.push({ body, headers, method, url });
    const next = this.responses.shift();
    if (!next) throw new Error(`HttpMock has no response for ${method} ${url}`);
    return next;
  }
}
