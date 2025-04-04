import { Writable } from "node:stream";
import zlib from "node:zlib";

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyResultV2,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import type { WrapperHandler } from "types/overrides";

import type { InternalResult, StreamCreator } from "types/open-next";
import type {
  WarmerEvent,
  WarmerResponse,
} from "../../adapters/warmer-function";

type AwsLambdaEvent =
  | APIGatewayProxyEventV2
  | CloudFrontRequestEvent
  | APIGatewayProxyEvent
  | WarmerEvent;

type AwsLambdaReturn =
  | APIGatewayProxyResultV2
  | APIGatewayProxyResult
  | CloudFrontRequestResult
  | WarmerResponse;

function formatWarmerResponse(event: WarmerEvent) {
  return new Promise<WarmerResponse>((resolve) => {
    setTimeout(() => {
      resolve({ serverId, type: "warmer" } satisfies WarmerResponse);
    }, event.delay);
  });
}

const handler: WrapperHandler =
  async (handler, converter) =>
  async (event: AwsLambdaEvent): Promise<AwsLambdaReturn> => {
    // Handle warmer event
    if ("type" in event) {
      return formatWarmerResponse(event);
    }

    const internalEvent = await converter.convertFrom(event);
    const acceptEncoding = internalEvent.headers['accept-encoding'] ?? internalEvent.headers['Accept-Encoding'] ?? '';

    //TODO: create a simple reproduction and open an issue in the node repo
    //This is a workaround, there is an issue in node that causes node to crash silently if the OpenNextNodeResponse stream is not consumed
    //This does not happen everytime, it's probably caused by suspended component in ssr (either via <Suspense> or loading.tsx)
    //Everyone that wish to create their own wrapper without a StreamCreator should implement this workaround
    //This is not necessary if the underlying handler does not use OpenNextNodeResponse (At the moment, OpenNextNodeResponse is used by the node runtime servers and the image server)
    const fakeStream: StreamCreator = {
      writeHeaders: () => {
        return new Writable({
          write: (_chunk, _encoding, callback) => {
            callback();
          },
        });
      },
    };

    const handlerResponse = await handler(internalEvent, {
      streamCreator: fakeStream,
    });

    // handle compression
    let contentEncoding: string;
    let compressedBody;
    const bodyString = typeof handlerResponse.body === 'string' ? handlerResponse.body : JSON.stringify(handlerResponse.body)
    if (acceptEncoding.includes("br")) {
      contentEncoding = "br";
      compressedBody = zlib.brotliCompressSync(bodyString);
    } else if (acceptEncoding.includes("gzip")) {
      contentEncoding = "gzip";
      compressedBody = zlib.gzipSync(bodyString);
    } else {
      contentEncoding = "identity";
      compressedBody = Buffer.from(bodyString);
    }

    console.log({
      acceptEncoding,
      contentEncoding,
      length: compressedBody.length,
    })

    const response: InternalResult = {
      ...handlerResponse,
      body: compressedBody.toString("base64"),
      headers: {
        ...handlerResponse.headers,
        "content-encoding": contentEncoding,
      },
      isBase64Encoded: true,
    }
    
    return converter.convertTo(response, event);
  };

export default {
  wrapper: handler,
  name: "aws-lambda",
  supportStreaming: false,
};
