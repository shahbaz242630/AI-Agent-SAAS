import { NextResponse, type NextRequest } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { bookExportQueryString, parseBookFilters } from "@/products/lead-follow-up/lead-book";

/**
 * The enquiry book as a file (founder, 2026-09-05: *"the user should be able
 * to download a csv of the enquiries"*).
 *
 * ⚠️ THROUGH THE APP, NOT STRAIGHT TO THE API. A plain link to the api would
 * arrive with no session — the bearer token lives on the server side of this
 * app and never in the browser. So the browser asks here, this handler asks
 * the api with the session, and hands the bytes and the two headers that
 * make them a download straight back.
 *
 * ⚠️ THE FILTERS ARE RE-PARSED, NOT FORWARDED. Whatever is on the address is
 * read through `parseBookFilters`, so only the four filters the book knows
 * reach the api, and a junk parameter is dropped rather than passed on.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) return NextResponse.redirect(new URL("/sign-in", request.url));

  const organisations = await fetchOrganisations<{ id: string }>(accessToken);
  const organisation = organisations[0];
  if (!organisation) return new Response("Create an organisation first.", { status: 404 });

  const { filters } = parseBookFilters(Object.fromEntries(request.nextUrl.searchParams));
  const query = bookExportQueryString(filters);

  try {
    const upstream = await apiFetch(
      `/organisations/${organisation.id}/leads/export.csv${query ? `?${query}` : ""}`,
      accessToken,
    );
    // ⚠️ BYTES, NOT TEXT. `text()` decodes the body and, by the WHATWG
    // rule, silently drops the byte-order mark the api put first — which
    // is the one thing that stops Excel on Windows reading every £ and
    // every accented name as noise. Found in the founder's first two
    // downloads on 2026-09-05: the api's mark never reached the file.
    return new Response(await upstream.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "text/csv; charset=utf-8",
        "Content-Disposition":
          upstream.headers.get("content-disposition") ?? 'attachment; filename="enquiries.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return NextResponse.redirect(new URL("/sign-in", request.url));
    }
    // The api's own sentence, with its status: a 402 or 403 here is the same
    // refusal the book screen shows, and inventing a different one helps nobody.
    if (error instanceof ApiError) return new Response(error.message, { status: error.status });
    throw error;
  }
}
