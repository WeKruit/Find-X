import { NextResponse } from "next/server";
import type { SearchQuery } from "@/types";
import { runSearch } from "@/lib/crawl/engine";
import { storeSession, toDTO } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    if (body.name.trim().length > 200 || (body.context && body.context.length > 500)) {
      return NextResponse.json(
        { error: "Input too long" },
        { status: 400 }
      );
    }

    const query: SearchQuery = {
      mode: "person",
      name: body.name.trim(),
      context: typeof body.context === "string" ? body.context.trim() || undefined : undefined,
    };

    const session = await runSearch(query);
    storeSession(session);

    return NextResponse.json(toDTO(session));
  } catch (error) {
    console.error("Search API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
