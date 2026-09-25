// CONTRACT STUB (owned by W-D)
// Integrator replaces this route with VideosPolicy-checked mint/refresh.
// Do not log the request body or any bearer.

export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(
		{ error: "grant-unavailable" },
		{
			status: 501,
			headers: { "cache-control": "private, no-store" },
		},
	);
}
