import { NextResponse } from "next/server";
import { getSession, toDTO } from "@/lib/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = getSession(id);

  if (!session) {
    return NextResponse.json(
      { error: "Search session not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(toDTO(session));
}
