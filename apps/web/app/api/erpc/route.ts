import { RpcAuthMiddlewareLive, RpcsLive } from "@cap/web-backend";
import { Rpcs } from "@cap/web-domain";
import { HttpServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Layer } from "effect";
import { ensureEditedDownloadLookup } from "@/lib/register-edited-download";
import { Dependencies } from "@/lib/server";

ensureEditedDownloadLookup();

const rpcLayer = Layer.mergeAll(
	RpcAuthMiddlewareLive,
	RpcsLive,
	RpcSerialization.layerJson,
	HttpServer.layerContext,
);

const { handler } = RpcServer.toWebHandler(Rpcs, {
	layer: Layer.provide(Dependencies)(rpcLayer),
});

export const GET = (r: Request) => handler(r);
export const POST = (r: Request) => handler(r);
