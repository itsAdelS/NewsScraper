import { usePayerNewsHealthCheck, getPayerNewsHealthCheckQueryKey } from '@workspace/api-client-react';

function getUtilisationColor(pct: number, warnThresholdPct: number): string {
  if (pct >= warnThresholdPct) return 'text-destructive';
  if (pct >= warnThresholdPct * 0.75) return 'text-warning';
  return 'text-success';
}

function PoolBadge({ active, maxContexts, utilisation, warnThresholdPct }: {
  active: number;
  maxContexts: number;
  utilisation: number;
  warnThresholdPct: number;
}) {
  const color = getUtilisationColor(utilisation, warnThresholdPct);
  return (
    <span
      className={`text-xs font-mono ${color} bg-muted px-1.5 py-0.5 rounded`}
      title={`Warn threshold: ${warnThresholdPct}%`}
      data-testid="pool-utilisation"
    >
      Pool: {active}/{maxContexts} ({utilisation}%)
    </span>
  );
}

export function HealthIndicator() {
  const { data, isError, isLoading } = usePayerNewsHealthCheck({
    query: {
      queryKey: getPayerNewsHealthCheckQueryKey(),
      refetchInterval: 30000,
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium" data-testid="status-health-loading">
        <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-pulse" />
        Checking...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive font-medium" data-testid="status-health-offline">
        <div className="w-2 h-2 rounded-full bg-destructive" />
        Offline
      </div>
    );
  }

  const pool = data.browserPool;

  if (data.status === 'degraded') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium" data-testid="status-health-degraded" title="Browser pool is near capacity">
        <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        <span className="text-warning">Pool Near Capacity</span>
        {pool && (
          <PoolBadge
            active={pool.active}
            maxContexts={pool.maxContexts}
            utilisation={pool.utilisation}
            warnThresholdPct={pool.warnThresholdPct}
          />
        )}
      </div>
    );
  }

  if (data.status !== 'healthy') {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive font-medium" data-testid="status-health-offline">
        <div className="w-2 h-2 rounded-full bg-destructive" />
        Offline
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm font-medium" data-testid="status-health-online">
      <div className="w-2 h-2 rounded-full bg-success" />
      <span className="text-success">API Online</span>
      {pool && (
        <PoolBadge
          active={pool.active}
          maxContexts={pool.maxContexts}
          utilisation={pool.utilisation}
          warnThresholdPct={pool.warnThresholdPct}
        />
      )}
    </div>
  );
}
