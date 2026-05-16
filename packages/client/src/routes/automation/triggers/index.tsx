import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/automation/triggers/')({
  beforeLoad: () => {
    throw redirect({ to: '/automation/schedules-and-hooks' });
  },
});
