import type { MemoryOverview } from "../../types/memory";

interface MemoryOverviewCardsProps {
  overview: MemoryOverview | null;
  isLoading: boolean;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
}

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="memory-overview-card">
      <p className="memory-overview-label">{label}</p>
      <p className="memory-overview-value">{value}</p>
      {sub && <p className="memory-overview-sub">{sub}</p>}
    </div>
  );
}

export function MemoryOverviewCards({ overview, isLoading }: MemoryOverviewCardsProps) {
  if (isLoading || !overview) {
    return (
      <div className="memory-overview-grid">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="memory-overview-card memory-skeleton" />
        ))}
      </div>
    );
  }

  const estTokens = Math.ceil(overview.estimatedChars / 4);

  return (
    <div className="memory-overview-grid">
      <StatCard label="Total blocks" value={String(overview.totalBlocks)} />
      <StatCard
        label="Estimated size"
        value={`${fmt(overview.estimatedChars)} chars`}
        sub={`≈ ${fmt(estTokens)} tokens`}
      />
      <StatCard label="Message count" value={fmt(overview.totalMessages)} />
      <StatCard label="Last updated" value={fmtDate(overview.lastUpdatedAt)} />
    </div>
  );
}
