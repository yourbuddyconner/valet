import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="min-h-full flex items-center justify-center p-8">
      <div className="text-center space-y-2">
        <div className="text-2xl font-semibold tracking-tight">Valet</div>
        <div className="text-sm text-[--muted]">scaffold ok — primitives + screens land in W2+</div>
      </div>
    </div>
  );
}
