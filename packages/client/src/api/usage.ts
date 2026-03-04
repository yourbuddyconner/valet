import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { UsageStatsResponse } from './types';

export const usageKeys = {
  all: ['usage'] as const,
  stats: (period: number) => [...usageKeys.all, 'stats', period] as const,
};

export function useUsageStats(periodHours: number = 720) {
  return useQuery({
    queryKey: usageKeys.stats(periodHours),
    queryFn: () => api.get<UsageStatsResponse>(`/usage/stats?period=${periodHours}`),
    refetchInterval: 300_000, // 5 minutes
  });
}
