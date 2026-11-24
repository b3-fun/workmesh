// from b3-mono apps/b3os-web/components/ui/button.tsx @ f50f3ba3b97e
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center overflow-hidden whitespace-nowrap",
    "font-medium transition-[background-color,border-color,color,box-shadow,filter,opacity,transform] duration-150 ease-out-quart",
    "disabled:pointer-events-none disabled:opacity-30",
    "focus-visible:outline-hidden",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        brand: [
          "text-ds-text-white",
          "shadow-ds-brand",
          "before:absolute before:inset-0 before:rounded-inherit before:bg-linear-to-b/srgb before:from-ds-brand-500 before:to-ds-brand-600 before:transition-[background-color,filter,opacity] before:duration-150 before:ease-out-quart",
          "after:absolute after:inset-0 after:rounded-inherit after:shadow-ds-inner-light after:pointer-events-none",
          "hover:before:brightness-[0.85]",
          "active:before:bg-linear-to-b/srgb active:before:from-ds-brand-600 active:before:to-ds-brand-500",
          "focus-visible:after:shadow-ds-focus-ring",
        ],
        white: [
          "text-ds-text-primary",
          "shadow-ds-white",
          "before:absolute before:inset-0 before:rounded-inherit before:bg-linear-to-b/srgb before:from-ds-neutral-100 before:to-ds-neutral-200 before:transition-[background-color,filter,opacity] before:duration-150 before:ease-out-quart",
          // Dark mode: flip the light-gray fill to dark neutrals so the
          // button doesn't render as a bright white blob on a near-black
          // page. The inner-light `after:` highlight still reads as a
          // subtle top rim.
          "dark:before:from-ds-neutral-800 dark:before:to-ds-neutral-900",
          "after:absolute after:inset-0 after:rounded-inherit after:shadow-ds-inner-light after:pointer-events-none",
          "hover:before:brightness-[1.03]",
          "active:before:bg-linear-to-b/srgb active:before:from-ds-neutral-200 active:before:to-ds-neutral-100",
          "dark:active:before:from-ds-neutral-900 dark:active:before:to-ds-neutral-800",
          "focus-visible:after:shadow-ds-focus-ring",
        ],
        black: [
          "text-ds-text-white",
          "shadow-ds-black",
          "before:absolute before:inset-0 before:rounded-inherit before:bg-linear-to-b/srgb before:from-ds-neutral-700 before:to-ds-neutral-900 before:transition-[background-color,filter,opacity] before:duration-150 before:ease-out-quart",
          "after:absolute after:inset-0 after:rounded-inherit after:shadow-ds-inner-dark after:pointer-events-none",
          "hover:before:brightness-[1.1]",
          "active:before:bg-linear-to-b/srgb active:before:from-ds-neutral-900 active:before:to-ds-neutral-700",
          "focus-visible:after:shadow-ds-focus-ring",
        ],
        "link-brand": ["text-ds-text-brand", "hover:underline", "focus-visible:underline", "disabled:no-underline"],
        "link-gray": ["text-ds-text-secondary", "hover:underline", "focus-visible:underline", "disabled:no-underline"],
        ghost: [
          "text-ds-text-primary",
          "hover:bg-ds-neutral-200",
          "active:bg-ds-neutral-200 active:shadow-ds-press-inset",
          "focus-visible:bg-ds-neutral-100 focus-visible:ring-1 focus-visible:ring-ds-focus-brand",
        ],
        destructive: [
          "text-ds-text-white",
          "shadow-ds-red",
          "before:absolute before:inset-0 before:rounded-inherit before:bg-linear-to-b/srgb before:from-ds-red-500 before:to-ds-red-600 before:transition-[background-color,filter,opacity] before:duration-150 before:ease-out-quart",
          "after:absolute after:inset-0 after:rounded-inherit after:shadow-ds-inner-light after:pointer-events-none",
          "hover:before:brightness-[0.85]",
          "active:before:bg-linear-to-b/srgb active:before:from-ds-red-600 active:before:to-ds-red-500",
          "focus-visible:after:shadow-ds-focus-ring",
        ],
        success: [
          "text-ds-text-white",
          "shadow-ds-green",
          "before:absolute before:inset-0 before:rounded-inherit before:bg-linear-to-b/srgb before:from-ds-green-500 before:to-ds-green-600 before:transition-[background-color,filter,opacity] before:duration-150 before:ease-out-quart",
          "after:absolute after:inset-0 after:rounded-inherit after:shadow-ds-inner-light after:pointer-events-none",
          "hover:before:brightness-[0.9]",
          "active:before:bg-linear-to-b/srgb active:before:from-ds-green-600 active:before:to-ds-green-500",
          "focus-visible:after:shadow-ds-focus-ring",
        ],
      },
      size: {
        xs: "h-7 gap-1 rounded-ds-sm px-3 py-1 text-xs leading-label",
        sm: "h-9 gap-1 rounded-ds-sm px-4 py-2 text-sm leading-label",
        md: "h-10 gap-1 rounded-ds-md px-6 py-2.5 text-sm leading-label",
        lg: "h-11 gap-1 rounded-ds-md px-6 py-2.5 text-sm leading-label",
        xl: "h-12 gap-1.5 rounded-ds-md px-6 py-3.5 text-base leading-label",
      },
      iconOnly: {
        true: "px-0",
        false: "",
      },
    },
    compoundVariants: [
      { iconOnly: true, size: "xs", className: "w-7" },
      { iconOnly: true, size: "sm", className: "w-9" },
      { iconOnly: true, size: "md", className: "w-10" },
      { iconOnly: true, size: "lg", className: "w-11" },
      { iconOnly: true, size: "xl", className: "w-12" },
      { variant: "link-brand", size: "xs", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-brand", size: "sm", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-brand", size: "md", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-brand", size: "lg", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-brand", size: "xl", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-gray", size: "xs", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-gray", size: "sm", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-gray", size: "md", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-gray", size: "lg", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
      { variant: "link-gray", size: "xl", className: "h-auto rounded-none px-0.5 py-0 shadow-none" },
    ],
    defaultVariants: {
      variant: "brand",
      size: "md",
      iconOnly: false,
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const CONTENT_WRAPPER_CLASS = "relative z-10 inline-flex items-center justify-center gap-[inherit]";

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, iconOnly, asChild = false, type, children, ...props }, ref) => {
    const mergedClassName = cn(buttonVariants({ variant, size, iconOnly, className }));
    if (asChild) {
      const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode }>;
      const wrapped = React.cloneElement(
        child,
        {},
        <span className={CONTENT_WRAPPER_CLASS}>{child.props.children}</span>,
      );
      return (
        <Slot className={mergedClassName} ref={ref} {...props}>
          {wrapped}
        </Slot>
      );
    }
    return (
      <button className={mergedClassName} ref={ref} type={type ?? "button"} {...props}>
        <span className={CONTENT_WRAPPER_CLASS}>{children}</span>
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
