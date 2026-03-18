import { useQuery } from '@tanstack/react-query';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse } from '@valet/shared';
import { api } from './client';

export const analyticsKeys = {
  all: ['analytics'] as const,
  performance: (period: number) => [...analyticsKeys.all, 'performance', period] as const,
  events: (period: number, type?: string) => [...analyticsKeys.all, 'events', period, type] as const,
};

export function useAnalyticsPerformance(periodHours: number = 720) {
  return useQuery({
    queryKey: analyticsKeys.performance(periodHours),
    queryFn: () => api.get<AnalyticsPerformanceResponse>(`/analytics/performance?period=${periodHours}`),
    refetchInterval: 60_000,
  });
}

export function useAnalyticsEvents(periodHours: number = 720, typePrefix?: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: [...analyticsKeys.events(periodHours, typePrefix), limit, offset],
    queryFn: () => {
      const params = new URLSearchParams({ period: String(periodHours), limit: String(limit), offset: String(offset) });
      if (typePrefix) params.set('type', typePrefix);
      return api.get<AnalyticsEventsResponse>(`/analytics/events?${params}`);
    },
    refetchInterval: 30_000,
  });
}
