import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/automation/workflows/$workflowId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/workflows/$workflowId',
      params,
    });
  },
});
