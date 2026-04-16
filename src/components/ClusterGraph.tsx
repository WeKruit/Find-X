"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ClusterData, MentionSummary } from "@/types";

interface ClusterGraphProps {
  clusters: ClusterData[];
}

// ── Color palette for clusters ──
const CLUSTER_COLORS = [
  { fill: "#3b82f6", light: "#dbeafe", stroke: "#2563eb", text: "#1e40af", glow: "rgba(59,130,246,0.2)" },
  { fill: "#f59e0b", light: "#fef3c7", stroke: "#d97706", text: "#92400e", glow: "rgba(245,158,11,0.2)" },
  { fill: "#10b981", light: "#d1fae5", stroke: "#059669", text: "#065f46", glow: "rgba(16,185,129,0.2)" },
  { fill: "#8b5cf6", light: "#ede9fe", stroke: "#7c3aed", text: "#5b21b6", glow: "rgba(139,92,246,0.2)" },
  { fill: "#f43f5e", light: "#ffe4e6", stroke: "#e11d48", text: "#9f1239", glow: "rgba(244,63,94,0.2)" },
  { fill: "#06b6d4", light: "#cffafe", stroke: "#0891b2", text: "#155e75", glow: "rgba(6,182,212,0.2)" },
];

// ── Force simulation types ──
interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: "profile" | "mention";
  radius: number;
  clusterIndex: number;
  label: string;
  subLabel?: string;
  data: ClusterData | MentionSummary;
}

interface SimEdge {
  sourceId: string;
  targetId: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function domainShort(domain: string): string {
  return domain
    .replace(/^www\./, "")
    .replace(/\.com$/, "")
    .replace(/\.org$/, "")
    .replace(/\.net$/, "");
}

// ── Force simulation ──
function runSimulation(
  nodes: SimNode[],
  edges: SimEdge[],
  width: number,
  height: number,
  iterations: number
): void {
  const centerX = width / 2;
  const centerY = height / 2;

  // Group nodes by cluster for initial positioning
  const profileNodes = nodes.filter((n) => n.type === "profile");
  const profileCount = profileNodes.length;

  // Spread profiles further apart based on cluster count
  const spreadRadius = profileCount === 1
    ? 0
    : Math.min(width, height) * 0.3;

  profileNodes.forEach((p, i) => {
    const angle = (i / profileCount) * Math.PI * 2 - Math.PI / 2;
    p.x = centerX + Math.cos(angle) * spreadRadius;
    p.y = centerY + Math.sin(angle) * spreadRadius;
  });

  // Index profiles by id for fast lookup
  const profileById = new Map<string, SimNode>();
  for (const n of nodes) {
    if (n.type === "profile") profileById.set(n.id, n);
  }

  // Index for edge lookup (mention -> profile)
  const mentionToProfile = new Map<string, string>();
  for (const e of edges) {
    mentionToProfile.set(e.sourceId, e.targetId);
  }

  // Position mentions in a circle around their profile (not random clump)
  const clusterMentions = new Map<string, SimNode[]>();
  for (const node of nodes) {
    if (node.type === "mention") {
      const profileId = mentionToProfile.get(node.id);
      if (profileId) {
        if (!clusterMentions.has(profileId)) clusterMentions.set(profileId, []);
        clusterMentions.get(profileId)!.push(node);
      }
    }
  }

  for (const [profileId, mentions] of clusterMentions) {
    const profile = profileById.get(profileId);
    if (!profile) continue;
    const count = mentions.length;
    const orbitRadius = profile.radius + 70 + count * 8;
    mentions.forEach((m, i) => {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      m.x = profile.x + Math.cos(angle) * orbitRadius;
      m.y = profile.y + Math.sin(angle) * orbitRadius;
    });
  }

  // Precompute edge index for fast lookup
  const edgeSourceIdx = new Map<string, number>();
  const edgeTargetIdx = new Map<string, number>();
  const nodeIdx = new Map<string, number>();
  nodes.forEach((n, i) => nodeIdx.set(n.id, i));
  for (const e of edges) {
    edgeSourceIdx.set(e.sourceId, nodeIdx.get(e.targetId)!);
    edgeTargetIdx.set(e.targetId, nodeIdx.get(e.sourceId)!);
  }

  // Run simulation
  for (let iter = 0; iter < iterations; iter++) {
    const t = iter / iterations;
    const alpha = Math.pow(1 - t, 1.5); // Smoother cooling curve
    const repulsionStrength = 1500 * alpha;
    const attractionStrength = 0.04;
    const centerStrength = 0.008 * alpha;
    const clusterRepulsion = 3000 * alpha; // Extra repulsion between different clusters

    // Reset velocities with damping
    for (const n of nodes) {
      n.vx *= 0.8;
      n.vy *= 0.8;
    }

    // Repulsion (all pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq) || 1;
        const minDist = a.radius + b.radius + 30;

        // Use stronger repulsion for nodes in different clusters
        const sameCluster = a.clusterIndex === b.clusterIndex;
        const strength = sameCluster ? repulsionStrength : clusterRepulsion;

        if (dist < minDist * 5) {
          const force = strength / (distSq || 1);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          // Profile nodes are heavier (move less)
          const massA = a.type === "profile" ? 4 : 1;
          const massB = b.type === "profile" ? 4 : 1;
          const totalMass = massA + massB;

          a.vx += (fx * massB) / totalMass;
          a.vy += (fy * massB) / totalMass;
          b.vx -= (fx * massA) / totalMass;
          b.vy -= (fy * massA) / totalMass;
        }

        // Hard collision: push apart if overlapping
        if (dist < minDist) {
          const overlap = (minDist - dist) / 2;
          const pushX = (dx / dist) * overlap * 0.5;
          const pushY = (dy / dist) * overlap * 0.5;
          a.x += pushX;
          a.y += pushY;
          b.x -= pushX;
          b.y -= pushY;
        }
      }
    }

    // Attraction (edges — mentions to their profile)
    for (const edge of edges) {
      const si = nodeIdx.get(edge.sourceId);
      const ti = nodeIdx.get(edge.targetId);
      if (si === undefined || ti === undefined) continue;
      const source = nodes[si];
      const target = nodes[ti];

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealDist = source.radius + target.radius + 90;

      const force = (dist - idealDist) * attractionStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      // Mentions move toward profile; profiles barely budge
      source.vx += fx * 0.8;
      source.vy += fy * 0.8;
      target.vx -= fx * 0.15;
      target.vy -= fy * 0.15;
    }

    // Center gravity (gentle pull toward center)
    for (const n of nodes) {
      n.vx += (centerX - n.x) * centerStrength;
      n.vy += (centerY - n.y) * centerStrength;
    }

    // Update positions
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      // Keep within bounds with padding
      const pad = n.radius + 20;
      n.x = Math.max(pad, Math.min(width - pad, n.x));
      n.y = Math.max(pad, Math.min(height - pad, n.y));
    }
  }
}

// ── Detail panel for selected node ──
function MentionDetail({ mention, color }: { mention: MentionSummary; color: typeof CLUSTER_COLORS[0] }) {
  const facts: string[] = [];
  if (mention.title) facts.push(`Title: ${mention.title}`);
  if (mention.company) facts.push(`Company: ${mention.company}`);
  if (mention.location) facts.push(`Location: ${mention.location}`);
  if (mention.names.length > 0) facts.push(`Names: ${mention.names.join(", ")}`);

  return (
    <div className="p-4 rounded-lg border-2 bg-white" style={{ borderColor: color.stroke }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color.fill }} />
        <a
          href={mention.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-blue-600 hover:underline truncate"
        >
          {mention.sourceUrl}
        </a>
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 shrink-0">
          {Math.round(mention.confidence * 100)}% confidence
        </span>
      </div>
      {facts.length > 0 ? (
        <ul className="space-y-1">
          {facts.map((fact, i) => (
            <li key={i} className="text-sm text-gray-700">
              {fact}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-400 italic">No structured facts extracted</p>
      )}
      <p className="text-xs text-gray-400 mt-2">
        {mention.factCount} total fact{mention.factCount !== 1 ? "s" : ""} extracted
      </p>
    </div>
  );
}

export default function ClusterGraph({ clusters }: ClusterGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<SimEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<SimNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Measure container width (pure resize observation — no data dependencies)
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      setDimensions((prev) => ({ ...prev, width }));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Compute adaptive height based on cluster content
  useEffect(() => {
    const totalNodes = clusters.reduce((sum, c) => sum + c.mentions.length + 1, 0);
    const baseHeight = Math.max(400, dimensions.width * 0.55);
    const nodeBonus = Math.min(200, totalNodes * 15);
    const height = Math.min(700, baseHeight + nodeBonus);
    setDimensions((prev) => ({ ...prev, height }));
  }, [clusters, dimensions.width]);

  // Build graph data and run simulation
  useEffect(() => {
    if (clusters.length === 0) return;

    const simNodes: SimNode[] = [];
    const simEdges: SimEdge[] = [];

    clusters.forEach((cluster, ci) => {
      const profileId = `profile-${ci}`;
      simNodes.push({
        id: profileId,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        type: "profile",
        radius: 38,
        clusterIndex: ci,
        label: truncate(cluster.profileName, 14),
        subLabel: cluster.isPrimaryTarget ? "Target" : "Other",
        data: cluster,
      });

      cluster.mentions.forEach((mention, mi) => {
        const mentionId = `mention-${ci}-${mi}`;
        simNodes.push({
          id: mentionId,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          type: "mention",
          radius: 20,
          clusterIndex: ci,
          label: truncate(domainShort(mention.sourceDomain), 10),
          data: mention,
        });
        simEdges.push({ sourceId: mentionId, targetId: profileId });
      });
    });

    runSimulation(simNodes, simEdges, dimensions.width, dimensions.height, 400);
    setNodes([...simNodes]);
    setEdges([...simEdges]);
    setSelectedNode(null);
  }, [clusters, dimensions.width, dimensions.height]);

  const handleNodeClick = useCallback((node: SimNode) => {
    setSelectedNode((prev) => (prev?.id === node.id ? null : node));
  }, []);

  if (clusters.length === 0) return null;

  const totalMentions = clusters.reduce((sum, c) => sum + c.mentions.length, 0);

  return (
    <div className="mt-8 max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">
        Entity Cluster Graph
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        {clusters.length} profile{clusters.length !== 1 ? "s" : ""} identified from{" "}
        {totalMentions} source mention{totalMentions !== 1 ? "s" : ""}. Click a node for
        details.
      </p>

      <div
        ref={containerRef}
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        <svg
          width={dimensions.width}
          height={dimensions.height}
          viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
          className="w-full"
        >
          <defs>
            {/* Drop shadow filter */}
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.15" />
            </filter>
            <filter id="shadow-lg" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.2" />
            </filter>
            {/* Gradient backgrounds for profile nodes */}
            {CLUSTER_COLORS.map((color, i) => (
              <radialGradient key={i} id={`grad-${i}`} cx="40%" cy="35%" r="65%">
                <stop offset="0%" stopColor={color.fill} stopOpacity="1" />
                <stop offset="100%" stopColor={color.stroke} stopOpacity="1" />
              </radialGradient>
            ))}
          </defs>

          {/* Background with subtle grid */}
          <rect width={dimensions.width} height={dimensions.height} fill="#f9fafb" />
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
          </pattern>
          <rect width={dimensions.width} height={dimensions.height} fill="url(#grid)" opacity="0.5" />

          {/* Cluster background regions (convex hull approximation) */}
          {clusters.map((_, ci) => {
            const clusterNodes = nodes.filter((n) => n.clusterIndex === ci);
            if (clusterNodes.length < 2) return null;
            const color = CLUSTER_COLORS[ci % CLUSTER_COLORS.length];

            // Compute bounding box with padding
            const xs = clusterNodes.map((n) => n.x);
            const ys = clusterNodes.map((n) => n.y);
            const pad = 35;
            const minX = Math.min(...xs) - pad;
            const maxX = Math.max(...xs) + pad;
            const minY = Math.min(...ys) - pad;
            const maxY = Math.max(...ys) + pad;
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const rx = (maxX - minX) / 2 + 10;
            const ry = (maxY - minY) / 2 + 10;

            return (
              <ellipse
                key={`bg-${ci}`}
                cx={cx}
                cy={cy}
                rx={rx}
                ry={ry}
                fill={color.glow}
                stroke={color.fill}
                strokeWidth="1"
                strokeOpacity="0.15"
                strokeDasharray="6 4"
              />
            );
          })}

          {/* Edges */}
          {edges.map((edge, i) => {
            const source = nodes.find((n) => n.id === edge.sourceId);
            const target = nodes.find((n) => n.id === edge.targetId);
            if (!source || !target) return null;
            const color = CLUSTER_COLORS[source.clusterIndex % CLUSTER_COLORS.length];
            const isHighlighted =
              hoveredNode === source.id ||
              hoveredNode === target.id ||
              selectedNode?.id === source.id ||
              selectedNode?.id === target.id;

            // Slight curve for visual appeal
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const offset = Math.min(15, dist * 0.1);
            const mx = (source.x + target.x) / 2 + (dy / dist) * offset;
            const my = (source.y + target.y) / 2 - (dx / dist) * offset;

            return (
              <path
                key={i}
                d={`M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`}
                fill="none"
                stroke={color.fill}
                strokeWidth={isHighlighted ? 2.5 : 1.5}
                strokeOpacity={isHighlighted ? 0.7 : 0.25}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const color = CLUSTER_COLORS[node.clusterIndex % CLUSTER_COLORS.length];
            const isHovered = hoveredNode === node.id;
            const isSelected = selectedNode?.id === node.id;
            const active = isHovered || isSelected;

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => handleNodeClick(node)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                className="cursor-pointer"
              >
                {/* Glow ring on hover/select */}
                {active && (
                  <circle
                    r={node.radius + 8}
                    fill="none"
                    stroke={color.fill}
                    strokeWidth={2.5}
                    strokeOpacity={0.35}
                  />
                )}

                {/* Node circle */}
                {node.type === "profile" ? (
                  <circle
                    r={node.radius}
                    fill={`url(#grad-${node.clusterIndex % CLUSTER_COLORS.length})`}
                    stroke={color.stroke}
                    strokeWidth={3}
                    filter={active ? "url(#shadow-lg)" : "url(#shadow)"}
                    opacity={node.subLabel === "Other" ? 0.7 : 1}
                  />
                ) : (
                  <circle
                    r={node.radius}
                    fill={color.light}
                    stroke={color.stroke}
                    strokeWidth={active ? 2 : 1.5}
                    filter="url(#shadow)"
                  />
                )}

                {/* Label */}
                <text
                  textAnchor="middle"
                  dy={node.type === "profile" && node.subLabel ? -5 : 1}
                  fill={node.type === "profile" ? "white" : color.text}
                  fontSize={node.type === "profile" ? 11.5 : 9}
                  fontWeight={node.type === "profile" ? 700 : 600}
                  pointerEvents="none"
                  style={{ textShadow: node.type === "profile" ? "0 1px 2px rgba(0,0,0,0.3)" : "none" }}
                >
                  {node.label}
                </text>

                {/* Sub-label for profile nodes */}
                {node.type === "profile" && node.subLabel && (
                  <text
                    textAnchor="middle"
                    dy={10}
                    fill="rgba(255,255,255,0.8)"
                    fontSize={8}
                    fontWeight={500}
                    pointerEvents="none"
                    letterSpacing="0.5"
                  >
                    {node.subLabel}
                  </text>
                )}

                {/* Confidence badge for mention nodes */}
                {node.type === "mention" && (
                  <text
                    textAnchor="middle"
                    dy={node.radius + 13}
                    fill="#9ca3af"
                    fontSize={8}
                    pointerEvents="none"
                  >
                    {Math.round((node.data as MentionSummary).confidence * 100)}%
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-4 text-xs text-gray-500">
          {clusters.map((cluster, i) => {
            const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
            return (
              <div key={i} className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 rounded-full border"
                  style={{ backgroundColor: color.fill, borderColor: color.stroke }}
                />
                <span className="font-medium text-gray-700">
                  {cluster.profileName}
                  {cluster.isPrimaryTarget ? " (target)" : ""}
                </span>
                <span className="text-gray-400">
                  {cluster.mentions.length} source{cluster.mentions.length !== 1 ? "s" : ""}
                </span>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5 ml-auto">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="6" fill="#3b82f6" stroke="#2563eb" strokeWidth="1.5" />
            </svg>
            <span>Profile</span>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="5" fill="#dbeafe" stroke="#2563eb" strokeWidth="1" />
            </svg>
            <span>Source</span>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="mt-4">
          {selectedNode.type === "mention" ? (
            <MentionDetail
              mention={selectedNode.data as MentionSummary}
              color={CLUSTER_COLORS[selectedNode.clusterIndex % CLUSTER_COLORS.length]}
            />
          ) : (
            <div
              className="p-4 rounded-lg border-2 bg-white"
              style={{
                borderColor:
                  CLUSTER_COLORS[selectedNode.clusterIndex % CLUSTER_COLORS.length].stroke,
              }}
            >
              <h3 className="font-semibold text-gray-900">
                {(selectedNode.data as ClusterData).profileName}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {(selectedNode.data as ClusterData).isPrimaryTarget
                  ? "Primary search target"
                  : "Other person with similar name"}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {(selectedNode.data as ClusterData).mentions.length} source mention
                {(selectedNode.data as ClusterData).mentions.length !== 1 ? "s" : ""} clustered
                into this profile
              </p>
              <div className="mt-3 space-y-2">
                {(selectedNode.data as ClusterData).mentions.map((m, i) => (
                  <div
                    key={i}
                    className="text-xs text-gray-600 flex items-center gap-2"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor:
                          CLUSTER_COLORS[selectedNode.clusterIndex % CLUSTER_COLORS.length]
                            .fill,
                      }}
                    />
                    <a
                      href={m.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline truncate"
                    >
                      {m.sourceDomain}
                    </a>
                    <span className="text-gray-400">
                      {[m.title, m.company].filter(Boolean).join(" at ") || `${m.factCount} facts`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
