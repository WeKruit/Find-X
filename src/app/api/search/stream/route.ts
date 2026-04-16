import { NextResponse } from "next/server";
import type { SearchQuery } from "@/types";
import { runSearch } from "@/lib/crawl/engine";
import { storeSession } from "@/lib/store";

export const maxDuration = 300; // 5 minutes max for Vercel

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (body.name.trim().length > 200 || (body.context && body.context.length > 500)) {
      return NextResponse.json({ error: "Input too long" }, { status: 400 });
    }

    const query: SearchQuery = {
      mode: "person",
      name: body.name.trim(),
      context: typeof body.context === "string" ? body.context.trim() || undefined : undefined,
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;

        function safeEnqueue(chunk: Uint8Array) {
          if (!closed) {
            try {
              controller.enqueue(chunk);
            } catch {
              // Controller was closed (client disconnected) — ignore
              closed = true;
            }
          }
        }

        function safeClose() {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed — ignore
            }
          }
        }

        try {
          const session = await runSearch(query, (event) => {
            const data = JSON.stringify(event);
            safeEnqueue(encoder.encode(`data: ${data}\n\n`));
          });

          storeSession(session);

          // Send final result
          const finalData = JSON.stringify({
            type: "complete",
            session: {
              id: session.id,
              status: session.status,
              profiles: session.profiles,
              clusterData: session.clusterData || [],
              crawlState: {
                pagesVisited: session.crawlState.pagesVisited,
                pageBudget: session.crawlState.pageBudget,
                domainsVisited: Array.from(session.crawlState.domainsVisited),
                tokenUsage: session.crawlState.tokenUsage,
              },
              error: session.error,
            },
          });
          safeEnqueue(encoder.encode(`data: ${finalData}\n\n`));
          safeClose();
        } catch (error) {
          const errorData = JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
          safeEnqueue(encoder.encode(`data: ${errorData}\n\n`));
          safeClose();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Stream API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
