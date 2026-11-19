// CSV upload was removed from itaOS (19 Nov 2026). Sales are recorded in the chat, ad spend comes from Meta.
// Kept as a stub so old links get a clear answer instead of an error page.
Deno.serve((req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  return new Response(JSON.stringify({ error: "CSV upload has been removed from itaOS." }), { status: 410, headers });
});
