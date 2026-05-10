import * as RDropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "~/lib/cn";

export const DropdownMenu = RDropdown.Root;
export const DropdownMenuTrigger = RDropdown.Trigger;
export const DropdownMenuGroup = RDropdown.Group;
export const DropdownMenuPortal = RDropdown.Portal;
export const DropdownMenuSub = RDropdown.Sub;
export const DropdownMenuRadioGroup = RDropdown.RadioGroup;

const MENU_BASE =
  "z-50 min-w-[10rem] overflow-hidden rounded-md border border-[--border] " +
  "bg-[--bg] p-1 shadow-lg text-sm " +
  "data-[state=open]:animate-in data-[state=closed]:animate-out " +
  "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0";

const ITEM_BASE =
  "relative flex select-none items-center gap-2 rounded px-2 py-1.5 outline-none " +
  "data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800 " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof RDropdown.Content>,
  ComponentPropsWithoutRef<typeof RDropdown.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...rest }, ref) {
  return (
    <RDropdown.Portal>
      <RDropdown.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(MENU_BASE, className)}
        {...rest}
      />
    </RDropdown.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof RDropdown.Item>,
  ComponentPropsWithoutRef<typeof RDropdown.Item>
>(function DropdownMenuItem({ className, ...rest }, ref) {
  return <RDropdown.Item ref={ref} className={cn(ITEM_BASE, className)} {...rest} />;
});

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof RDropdown.CheckboxItem>,
  ComponentPropsWithoutRef<typeof RDropdown.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...rest }, ref) {
  return (
    <RDropdown.CheckboxItem ref={ref} className={cn(ITEM_BASE, "pl-7", className)} {...rest}>
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <RDropdown.ItemIndicator>
          <Check className="h-3.5 w-3.5" />
        </RDropdown.ItemIndicator>
      </span>
      {children}
    </RDropdown.CheckboxItem>
  );
});

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof RDropdown.Label>,
  ComponentPropsWithoutRef<typeof RDropdown.Label>
>(function DropdownMenuLabel({ className, ...rest }, ref) {
  return (
    <RDropdown.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-xs font-medium text-[--muted]", className)}
      {...rest}
    />
  );
});

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof RDropdown.Separator>,
  ComponentPropsWithoutRef<typeof RDropdown.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  return (
    <RDropdown.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-[--border]", className)} {...rest} />
  );
});

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof RDropdown.SubTrigger>,
  ComponentPropsWithoutRef<typeof RDropdown.SubTrigger>
>(function DropdownMenuSubTrigger({ className, children, ...rest }, ref) {
  return (
    <RDropdown.SubTrigger ref={ref} className={cn(ITEM_BASE, "pr-2", className)} {...rest}>
      {children}
      <ChevronRight className="ml-auto h-4 w-4" aria-hidden />
    </RDropdown.SubTrigger>
  );
});

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof RDropdown.SubContent>,
  ComponentPropsWithoutRef<typeof RDropdown.SubContent>
>(function DropdownMenuSubContent({ className, ...rest }, ref) {
  return <RDropdown.SubContent ref={ref} className={cn(MENU_BASE, className)} {...rest} />;
});
