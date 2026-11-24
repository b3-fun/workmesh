// from b3-mono apps/b3os-web/components/ui/CheckBox.tsx @ f50f3ba3b97e

// The original is Headless UI's Checkbox (a span); here it is Radix's (a button), drawn the same (EXTRACT rule 3).
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import type * as React from "react";
import { IconCheckOutline18 } from "../lib/icons";
import { cn } from "../lib/utils";

interface CheckBoxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
  size?: CheckBoxSize;
  variant?: CheckBoxVariant;
}

type CheckBoxSize = "sm" | "md" | "lg";
type CheckBoxVariant = "default" | "brand";

const sizeClasses: Record<CheckBoxSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

const iconSizeClasses: Record<CheckBoxSize, string> = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
  lg: "h-4 w-4",
};

// Migrated from legacy `theme-*` tokens to DS tokens so the control
// reads cleanly in both light and dark modes (see `globals.css` theme
// flip). Default variant uses the high-contrast text-primary fill when
// checked; brand variant uses the blue accent.
const variantClasses = {
  default: {
    unchecked: "border-ds-border-default bg-ds-surface-card",
    checked: "border-ds-text-primary bg-ds-text-primary",
    disabled: "border-ds-border-default bg-ds-surface-muted opacity-50",
    icon: "text-ds-surface-card",
  },
  brand: {
    unchecked: "border-ds-border-default bg-ds-surface-card",
    checked: "border-ds-brand-500 bg-ds-brand-500",
    disabled: "border-ds-border-default bg-ds-surface-muted opacity-50",
    icon: "text-white",
  },
};

export interface CheckBoxControlProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
    "checked" | "onCheckedChange" | "onChange"
  > {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  size?: CheckBoxSize;
  variant?: CheckBoxVariant;
}

/**
 * The box alone, drawn as CheckBox draws it, for a caller with its own label (console area 2 fix, R1: the console's
 * checkboxes sit inside their own <label>, which names the box). Takes Radix's props: id, name, aria-*.
 */
export function CheckBoxControl({
  checked = false,
  onChange,
  disabled = false,
  className,
  size = "md",
  variant = "default",
  ...rest
}: CheckBoxControlProps) {
  const state = disabled ? "disabled" : checked ? "checked" : "unchecked";
  return (
    <CheckboxPrimitive.Root
      {...rest}
      checked={checked}
      onCheckedChange={(next) => onChange?.(next === true)}
      disabled={disabled}
      className={cn(
        "group relative shrink-0 rounded-ds-4 border transition-all duration-200 ease-[ease]",
        "focus:border-ds-brand-500 focus:outline-hidden focus:ring-0",
        "hover:border-ds-brand-500 hover:shadow-xs",
        "disabled:hover:border-ds-border-default disabled:cursor-not-allowed",
        sizeClasses[size],
        variantClasses[variant][state],
        className,
      )}
    >
      {checked && (
        <IconCheckOutline18
          className={cn(
            "absolute inset-0 m-auto transition-all duration-200 ease-[ease]",
            variantClasses[variant].icon,
            iconSizeClasses[size],
          )}
        />
      )}
    </CheckboxPrimitive.Root>
  );
}

export function CheckBox({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  size = "md",
  variant = "default",
}: CheckBoxProps) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <CheckBoxControl checked={checked} onChange={onChange} disabled={disabled} size={size} variant={variant} />
      {(label || description) && (
        <div className="flex flex-col gap-1">
          {label && (
            <label
              className={cn(
                "text-ds-text-primary cursor-pointer select-none text-sm font-medium",
                disabled && "cursor-not-allowed opacity-50",
              )}
              onClick={() => !disabled && onChange?.(!checked)}
            >
              {label}
            </label>
          )}
          {description && <p className={cn("text-ds-text-muted text-xs", disabled && "opacity-50")}>{description}</p>}
        </div>
      )}
    </div>
  );
}
