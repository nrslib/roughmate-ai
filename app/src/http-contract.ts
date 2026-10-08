export interface HttpRequest {
  rawPath: string;
  rawQueryString: string;
  body?: string;
  isBase64Encoded: boolean;
  cookies?: string[];
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: { timeEpoch: number; http: { method: string } };
}
export interface HttpResponse { statusCode?: number; headers?: Record<string, string | number | boolean>; cookies?: string[]; body?: string; isBase64Encoded?: boolean; }
