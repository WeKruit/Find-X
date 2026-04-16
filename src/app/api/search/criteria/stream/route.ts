import { NextResponse } from "next/server";
import { runCriteriaSearch } from "@/lib/crawl/criteria-engine";

export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.criteria || typeof body.criteria !== "string" || body.criteria.trim().length === 0) {
      return NextResponse.json({ error: "Criteria is required" }, { status: 400 });
    }

    if (body.criteria.trim().length > 1000) {
      return NextResponse.json({ error: "Criteria too long (max 1000 characters)" }, { status: 400 });
    }

    const criteria = body.criteria.trim();
    const maxResults = Math.min(100, Math.max(5, Number(body.maxResults) || 20));

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;

        function safeEnqueue(chunk: Uint8Array) {
          if (!closed) {
            try {
              controller.enqueue(chunk);
            } catch {
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
              // Already closed
            }
          }
        }

        try {
          const session = await runCriteriaSearch(
            criteria,
            (event) => {
              const data = JSON.stringify(event);
              safeEnqueue(encoder.encode(`data: ${data}\n\n`));
            },
            { maxCandidates: maxResults }
          );

          const finalData = JSON.stringify({
            type: "complete",
            session: {
              id: session.id,
              status: session.status,
              criteria: session.criteria,
              candidates: session.candidates,
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
    console.error("Criteria stream API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
