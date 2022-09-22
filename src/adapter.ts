import { URL } from "url";

import {
  Headers as NodeHeaders,
  Request as NodeRequest
} from "@remix-run/node";
import { createRequestHandler as createRemixRequestHandler } from "@remix-run/server-runtime";

import type {
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontHeaders
} from "aws-lambda";
import type { AppLoadContext, ServerBuild } from "@remix-run/server-runtime";
import type { Response as NodeResponse } from "@remix-run/node";

export interface GetLoadContextFunction {
  (event: CloudFrontRequestEvent): AppLoadContext;
}

export type RequestHandler = ReturnType<typeof createRequestHandler>;

export function createRequestHandler({
  getBuild,
  getLoadContext,
  mode = process.env.NODE_ENV,
  originPaths = [],
  debug = false,
  onError = () => {}
}: {
  getBuild: () => ServerBuild;
  getLoadContext?: GetLoadContextFunction;
  mode?: string;
  originPaths?: (
    | string
    | RegExp
    | { test: RegExp; mapper: ((s: string) => Promise<string>) | null }
  )[];
  debug?: boolean;
  onError?: (e: Error) => void;
}): CloudFrontRequestHandler {
  return (event, context, callback) => {
    const originPathRegexes = originPaths.map(s =>
      typeof s === "string"
        ? { test: new RegExp(s), mapper: null }
        : s instanceof RegExp
        ? { test: s, mapper: null }
        : s
    );

    const cloudfrontRequest = event.Records[0].cf.request;
    if (debug)
      console.log(
        `HANDLING ${cloudfrontRequest.method} ${cloudfrontRequest.uri} ${
          cloudfrontRequest.querystring
        } ${JSON.stringify(cloudfrontRequest.headers, null, 4)}`
      );
    const originPathMatched = originPathRegexes.find(r =>
      r.test.test(cloudfrontRequest.uri)
    );
    if (originPathMatched) {
      /* Continue this work if you foresee viability of s3Origin
      const s3headers = new Set([
        "origin",
        "access-control-request-headers",
        "access-control-request-method",
        "accept-encoding",
        "content-length",
        "if-modified-since",
        "if-none-match",
        "if-range",
        "if-unmodified-since",
        "transfer-encoding",
        "via",
      ]);
      Object.keys(cloudfrontRequest.headers).forEach(k => {
        if (!s3headers.has(k)) {
          delete cloudfrontRequest.headers[k];
        }
      });
      */
      context.callbackWaitsForEmptyEventLoop = false;
      if (originPathMatched.mapper) {
        return originPathMatched
          .mapper(cloudfrontRequest.uri)
          .then(newUri => {
            cloudfrontRequest.uri = newUri;
            return cloudfrontRequest;
          })
          .catch(() => {
            return cloudfrontRequest;
          });
      }
      return callback(undefined, cloudfrontRequest);
    }
    let handleRequest = createRemixRequestHandler(getBuild(), mode);

    let request = createRemixRequest(event);

    let loadContext =
      typeof getLoadContext === "function" ? getLoadContext(event) : {};

    return handleRequest(request as unknown as Request, {
      ...loadContext,
      lambdaContext: context
    })
      .then(async response => ({
        status: String(response.status),
        headers: createCloudFrontHeaders(
          (response as unknown as NodeResponse).headers
        ),
        bodyEncoding: "text" as const,
        body: await response.text()
      }))
      .catch(e => {
        console.error("Remix failed to handle request:");
        console.error(e);
        onError(e);
        return {
          status: "500",
          headers: {},
          bodyEncoding: "text" as const,
          body: e.message
        };
      });
  };
}

export function createCloudFrontHeaders(
  responseHeaders: NodeHeaders
): CloudFrontHeaders {
  let headers: CloudFrontHeaders = {};
  let rawHeaders = responseHeaders.raw();

  for (let key in rawHeaders) {
    let value = rawHeaders[key];
    for (let v of value) {
      headers[key] = [...(headers[key] || []), { key, value: v }];
    }
  }

  return headers;
}

export function createRemixHeaders(
  requestHeaders: CloudFrontHeaders
): NodeHeaders {
  let headers = new NodeHeaders();

  for (let [key, values] of Object.entries(requestHeaders)) {
    for (let { value } of values) {
      if (value) {
        headers.append(key, value);
      }
    }
  }

  return headers;
}

export function createRemixRequest(event: CloudFrontRequestEvent): NodeRequest {
  let request = event.Records[0].cf.request;

  let host = request.headers["host"]
    ? request.headers["host"][0].value
    : undefined;
  let search = request.querystring.length ? `?${request.querystring}` : "";
  let url = new URL(request.uri + search, `https://${host}`);

  return new NodeRequest(url.toString(), {
    method: request.method,
    headers: createRemixHeaders(request.headers),
    body: request.body?.data
      ? request.body.encoding === "base64"
        ? Buffer.from(request.body.data, "base64").toString()
        : request.body.data
      : undefined
  });
}
