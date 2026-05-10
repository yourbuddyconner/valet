/**
 * Tiny primitive showcase. Lets us eyeball the design tokens + components in
 * isolation while building. Not a Storybook; just a single route.
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Separator,
  Spinner,
  Textarea,
  Tooltip,
  TooltipProvider,
} from "~/components/primitives";

export const Route = createFileRoute("/primitives")({
  component: Primitives,
});

function Primitives() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <main className="min-h-full p-8 max-w-3xl mx-auto space-y-8">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Primitives</h1>
          <p className="text-sm text-[--muted]">
            Internal showcase. Components are intentional wrappers over Radix.
          </p>
        </header>

        <Section title="Buttons">
          <div className="flex flex-wrap gap-2 items-center">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <Tooltip content="Compact">
              <Button size="sm">Small</Button>
            </Tooltip>
            <Button size="lg">Large</Button>
          </div>
        </Section>

        <Section title="Inputs">
          <div className="grid gap-3 max-w-sm">
            <div className="grid gap-1">
              <Label htmlFor="name">Workspace path</Label>
              <Input id="name" placeholder="/tmp/valet/dogfood" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="msg">Prompt</Label>
              <Textarea id="msg" placeholder="say hi" />
            </div>
          </div>
        </Section>

        <Section title="Card">
          <Card className="max-w-sm">
            <CardHeader>
              <CardTitle>Session: dogfood</CardTitle>
            </CardHeader>
            <CardBody className="text-sm text-[--muted]">
              A short summary of what's happening. Status badges live below.
              <div className="mt-2 flex gap-1.5">
                <Badge>idle</Badge>
                <Badge variant="success">connected</Badge>
                <Badge variant="danger">error</Badge>
              </div>
            </CardBody>
            <CardFooter>
              <Button variant="secondary" size="sm">Cancel</Button>
              <Button size="sm">Open</Button>
            </CardFooter>
          </Card>
        </Section>

        <Section title="Avatar / Spinner / Separator / ScrollArea">
          <div className="flex items-center gap-4">
            <Avatar>
              <AvatarFallback>LD</AvatarFallback>
            </Avatar>
            <Spinner />
            <Separator orientation="vertical" className="h-6" />
            <span className="text-sm text-[--muted]">scroll →</span>
            <ScrollArea className="h-16 w-48 rounded border border-[--border]">
              <div className="p-2 text-sm space-y-1">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i}>scrollable item #{i + 1}</div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </Section>

        <Section title="Dialog + Dropdown">
          <div className="flex gap-2">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent
                title="New session"
                description="Pick a workspace path. Bash runs in a fresh Docker container against this dir."
              >
                <div className="grid gap-1">
                  <Label htmlFor="ws">Workspace</Label>
                  <Input id="ws" defaultValue="/tmp/valet/dogfood" />
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={() => setOpen(false)}>Create</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>Rename</DropdownMenuItem>
                <DropdownMenuItem>Duplicate</DropdownMenuItem>
                <DropdownMenuItem className="text-danger-600">Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Section>
      </main>
    </TooltipProvider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wider text-[--muted]">{title}</h2>
      {children}
    </section>
  );
}
