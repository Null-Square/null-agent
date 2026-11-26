import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@shared/lib/utils";
import { useOrgPermissions } from "./PermissionsProvider";

type CapabilityButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  capability: string;
  children: ReactNode;
  /** Override the disabled tooltip when denied. */
  deniedTooltip?: string;
  /** Hide entirely when denied. Otherwise the button stays visible but disabled. */
  hideWhenDenied?: boolean;
  /** Show an icon prefix when denied. Default true. */
  showLockWhenDenied?: boolean;
};

/**
 * Button that auto-disables when the active user lacks `capability`.
 * Tooltip explains the missing cap so users understand why an action is greyed
 * out instead of getting an API 403 after clicking.
 */
export const CapabilityButton = forwardRef<HTMLButtonElement, CapabilityButtonProps>(
  function CapabilityButton(
    {
      capability,
      children,
      deniedTooltip,
      hideWhenDenied,
      showLockWhenDenied = true,
      className,
      disabled,
      title,
      ...rest
    },
    ref,
  ) {
    const allowed = useOrgPermissions().has(capability);
    if (!allowed && hideWhenDenied) return null;

    const blocked = !allowed;
    const tooltip = blocked
      ? deniedTooltip ?? `Your role does not permit this action (${capability}).`
      : title;

    return (
      <button
        ref={ref}
        type="button"
        title={tooltip}
        aria-disabled={blocked || disabled}
        disabled={blocked || disabled}
        className={cn(className, blocked && "cursor-not-allowed opacity-60")}
        {...rest}
      >
        {blocked && showLockWhenDenied && (
          <Lock className="mr-1 h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden />
        )}
        {children}
      </button>
    );
  },
);
