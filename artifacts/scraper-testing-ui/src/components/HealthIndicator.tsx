import { usePayerNewsHealthCheck, getPayerNewsHealthCheckQueryKey } from '@workspace/api-client-react';

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

  if (isError || data?.status !== 'healthy') {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive font-medium" data-testid="status-health-offline">
        <div className="w-2 h-2 rounded-full bg-destructive" />
        Offline
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-success font-medium" data-testid="status-health-online">
      <div className="w-2 h-2 rounded-full bg-success" />
      API Online
    </div>
  );
}