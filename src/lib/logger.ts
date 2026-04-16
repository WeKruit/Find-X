import fs from "fs";
import path from "path";
import type { CrawlEvent, SearchQuery, PersonProfile } from "@/types";

const LOGS_DIR = path.join(process.cwd(), "logs");

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class SessionLogger {
  private logPath: string;
  private stream: fs.WriteStream;
  private sessionId: string;
  private startTime: Date;

  constructor(sessionId: string, query: SearchQuery) {
    ensureLogsDir();
    this.sessionId = sessionId;
    this.startTime = new Date();

    const label = query.mode === "criteria"
      ? sanitizeFilename(query.criteria || "criteria")
      : sanitizeFilename(query.name);
    const timestamp = formatTimestamp(this.startTime);
    const filename = `${timestamp}_${label}_${sessionId.slice(0, 8)}.log`;
    this.logPath = path.join(LOGS_DIR, filename);

    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });

    // Write header
    this.writeLine("=".repeat(80));
    this.writeLine(`GenSearch Session Log`);
    this.writeLine(`Session ID: ${sessionId}`);
    this.writeLine(`Started:    ${this.startTime.toISOString()}`);
    this.writeLine(`Mode:       ${query.mode}`);
    if (query.mode === "person") {
      this.writeLine(`Query:      ${query.name}`);
      if (query.context) this.writeLine(`Context:    ${query.context}`);
    } else {
      this.writeLine(`Criteria:   ${query.criteria}`);
      if (query.maxResults) this.writeLine(`Max Results: ${query.maxResults}`);
    }
    this.writeLine("=".repeat(80));
    this.writeLine("");
  }

  /** Log a crawl event */
  logEvent(event: CrawlEvent): void {
    const ts = event.timestamp.toISOString().slice(11, 23); // HH:MM:SS.mmm
    const prefix = `[${ts}] [${event.type.toUpperCase().padEnd(7)}]`;
    let line = `${prefix} ${event.message}`;
    if (event.url) {
      line += `\n${" ".repeat(prefix.length + 1)}URL: ${event.url}`;
    }
    if (event.data) {
      const dataStr = JSON.stringify(event.data, null, 2);
      // Only include data if it's not too large
      if (dataStr.length < 2000) {
        const indented = dataStr.split("\n").map((l) => " ".repeat(prefix.length + 1) + l).join("\n");
        line += `\n${indented}`;
      }
    }
    this.writeLine(line);
  }

  /** Log extraction results */
  logExtraction(url: string, result: {
    mentionsTarget: boolean;
    confidence: number;
    extracted: Record<string, unknown>;
    otherPeople?: unknown[];
  } | null): void {
    if (!result) {
      this.writeLine(`  [EXTRACTION] No data extracted from ${url}`);
      return;
    }

    this.writeLine(`  [EXTRACTION] ${url}`);
    this.writeLine(`    Mentions target: ${result.mentionsTarget} (confidence: ${result.confidence.toFixed(3)})`);

    const e = result.extracted;
    if (e.names) this.writeLine(`    Names: ${JSON.stringify(e.names)}`);
    if (e.title) this.writeLine(`    Title: ${e.title}`);
    if (e.company) this.writeLine(`    Company: ${e.company}`);
    if (e.location) this.writeLine(`    Location: ${e.location}`);
    if (e.email) this.writeLine(`    Email: ${e.email}`);
    if (e.bioSnippet) this.writeLine(`    Bio: ${String(e.bioSnippet).slice(0, 200)}`);

    const edu = e.education as unknown[];
    if (edu && Array.isArray(edu) && edu.length > 0) {
      this.writeLine(`    Education: ${JSON.stringify(edu)}`);
    }
    const skills = e.skills as unknown[];
    if (skills && Array.isArray(skills) && skills.length > 0) {
      this.writeLine(`    Skills: ${JSON.stringify(skills.slice(0, 10))}`);
    }
    const facts = e.additionalFacts as unknown[];
    if (facts && Array.isArray(facts) && facts.length > 0) {
      this.writeLine(`    Facts: ${JSON.stringify(facts.slice(0, 10))}`);
    }
    const social = e.socialLinks as unknown[];
    if (social && Array.isArray(social) && social.length > 0) {
      this.writeLine(`    Social: ${JSON.stringify(social)}`);
    }
    const rels = e.relationships as unknown[];
    if (rels && Array.isArray(rels) && rels.length > 0) {
      this.writeLine(`    Relationships: ${JSON.stringify(rels)}`);
    }

    if (result.otherPeople && result.otherPeople.length > 0) {
      this.writeLine(`    Other people found: ${result.otherPeople.length}`);
      for (const other of result.otherPeople) {
        this.writeLine(`      ${JSON.stringify(other)}`);
      }
    }
  }

  /** Log link scoring results */
  logLinkScoring(sourceUrl: string, scored: { url: string; score: number; reason: string }[]): void {
    this.writeLine(`  [LINK SCORING] From: ${sourceUrl}`);
    for (const link of scored.slice(0, 15)) {
      this.writeLine(`    ${link.score.toFixed(2)} ${link.url} — ${link.reason}`);
    }
    if (scored.length > 15) {
      this.writeLine(`    ... and ${scored.length - 15} more`);
    }
  }

  /** Log entity resolution results */
  logResolution(clusters: { mentions: { sourceUrl: string; extracted: { names: string[] } }[]; isPrimaryTarget: boolean }[]): void {
    this.writeLine("");
    this.writeLine("-".repeat(60));
    this.writeLine(`[RESOLUTION] ${clusters.length} cluster(s) identified`);
    this.writeLine("-".repeat(60));

    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const names = [...new Set(c.mentions.flatMap((m) => m.extracted.names))];
      const urls = c.mentions.map((m) => m.sourceUrl);
      this.writeLine(`  Cluster ${i + 1} [${c.isPrimaryTarget ? "PRIMARY" : "non-target"}]:`);
      this.writeLine(`    Names: ${names.join(", ")}`);
      this.writeLine(`    Mentions: ${c.mentions.length} from ${new Set(urls).size} source(s)`);
      for (const url of [...new Set(urls)]) {
        this.writeLine(`      - ${url}`);
      }
    }
    this.writeLine("");
  }

  /** Log final profiles */
  logProfiles(profiles: PersonProfile[]): void {
    this.writeLine("");
    this.writeLine("=".repeat(60));
    this.writeLine(`[PROFILES] ${profiles.length} profile(s) built`);
    this.writeLine("=".repeat(60));

    for (const p of profiles) {
      this.writeLine(`  Profile: ${p.names.map((n) => n.value).join(" / ")}`);
      this.writeLine(`    Confidence: ${p.confidence.toFixed(3)}`);
      const curExp = p.experiences?.find((e) => e.value.isCurrent) ?? p.experiences?.[0];
      if (curExp) {
        const roleStr = [curExp.value.title, curExp.value.company].filter(Boolean).join(" at ");
        if (roleStr) this.writeLine(`    Role: ${roleStr}`);
      }
      if (p.education.length > 0) {
        this.writeLine(`    Education: ${p.education.map((e) => e.value.institution).join(", ")}`);
      }
      if (p.locations.length > 0) {
        this.writeLine(`    Locations: ${p.locations.map((l) => l.value.city).join(", ")}`);
      }
      if (p.skills.length > 0) {
        this.writeLine(`    Skills: ${p.skills.slice(0, 10).map((s) => s.value).join(", ")}`);
      }
      if (p.emails.length > 0) {
        this.writeLine(`    Emails: ${p.emails.map((e) => e.value).join(", ")}`);
      }
      if (p.socialProfiles.length > 0) {
        this.writeLine(`    Social: ${p.socialProfiles.map((s) => `${s.value.platform}: ${s.value.url}`).join(", ")}`);
      }
      if (p.llmSummary) {
        this.writeLine(`    Summary: ${p.llmSummary}`);
      } else if (p.bioSnippet) {
        this.writeLine(`    Bio: ${p.bioSnippet.slice(0, 300)}`);
      }
      if (p.additionalFacts.length > 0) {
        this.writeLine(`    Facts:`);
        for (const f of p.additionalFacts.slice(0, 15)) {
          this.writeLine(`      - ${f.value}`);
        }
      }
      this.writeLine(`    Sources: ${p.sources.length}`);
      for (const s of p.sources) {
        this.writeLine(`      - ${s.url} (reliability: ${s.reliability.toFixed(2)})`);
      }
      this.writeLine("");
    }
  }

  /** Log token usage summary */
  logTokenUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number; llmCalls: number }): void {
    this.writeLine("");
    this.writeLine("-".repeat(40));
    this.writeLine(`[TOKEN USAGE]`);
    this.writeLine(`  LLM Calls:     ${usage.llmCalls}`);
    this.writeLine(`  Input Tokens:  ${usage.inputTokens.toLocaleString()}`);
    this.writeLine(`  Output Tokens: ${usage.outputTokens.toLocaleString()}`);
    this.writeLine(`  Total Tokens:  ${usage.totalTokens.toLocaleString()}`);
    this.writeLine("-".repeat(40));
  }

  /** Finalize the log */
  close(status: string): void {
    const endTime = new Date();
    const durationMs = endTime.getTime() - this.startTime.getTime();
    const durationSec = (durationMs / 1000).toFixed(1);

    this.writeLine("");
    this.writeLine("=".repeat(80));
    this.writeLine(`Session ended: ${endTime.toISOString()}`);
    this.writeLine(`Duration:      ${durationSec}s`);
    this.writeLine(`Status:        ${status}`);
    this.writeLine("=".repeat(80));

    this.stream.end();
    console.log(`[GenSearch] Log written to ${this.logPath}`);
  }

  private writeLine(line: string): void {
    this.stream.write(line + "\n");
  }
}
