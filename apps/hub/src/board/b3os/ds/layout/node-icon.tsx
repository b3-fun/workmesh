// from b3-mono apps/b3os-web/components/ui/node-icon.tsx @ f50f3ba3b97e
// The old icon API (ai-icon.b3.fun: fetch by id, POST to generate, poll /status, the logo.dev connector fallback and
// the /_next/image optimizer) is replaced by props: `imageUrl` is the generated icon, `generating` its pending state.

import { type ComponentType, type CSSProperties, useState } from "react";
import { IconAlertWarningOutline18, IconBoltOutline18, IconDatabaseOutline18, IconGearOutline18 } from "../lib/icons";
import { cn } from "../lib/utils";
import { PixelLoader } from "../signature/pixel-loader";

// Helper to get fallback icon for connector type (matching ConnectorLogo behavior)
const getIconForConnectorType = (type: string): ComponentType<{ className?: string }> => {
  const lowerType = type.toLowerCase();

  if (lowerType.includes("db") || lowerType.includes("database") || lowerType.includes("sql")) {
    return IconDatabaseOutline18;
  }

  if (lowerType.includes("api") || lowerType.includes("webhook") || lowerType.includes("http")) {
    return IconBoltOutline18;
  }

  return IconGearOutline18;
};

/** Shared logo image wrapper used by brand overrides and connector logos */
function LogoImage({
  src,
  alt,
  className,
  onError,
  showBackground = true,
  tintClassName,
}: {
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
  showBackground?: boolean;
  /** Type-tinted backdrop class (Figma canvas-v2). Overrides the default neutral backdrop. */
  tintClassName?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "relative flex h-full w-full items-center justify-center overflow-hidden rounded-ds-xs",
          // The original's dark:bg-ds-neutral-800/80 (an opacity on a var() colour) printed no CSS: white/80 in both themes.
          showBackground ? (tintClassName ?? "bg-white/80") : "bg-transparent backdrop-blur-[0]",
          showBackground && "backdrop-blur-xs",
        )}
      >
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-contain" onError={onError} />
      </div>
    </div>
  );
}

export interface NodeIconProps {
  /**
   * Unique identifier for the icon (the original's cache key at the icon API; kept for its call sites)
   */
  id: string;

  /**
   * Subject/title of what the icon represents
   */
  subject: string;

  /**
   * Context/description for the AI to understand what to generate. Kept for the original's call sites; the beta has
   * no icon generator, so it is not read.
   */
  context?: string;

  /**
   * Optional custom logo URL - if provided, this will be used instead of AI generation
   */
  logoUrl?: string;

  /**
   * The generated icon's URL (the original fetched it from the icon API by id and template).
   */
  imageUrl?: string;

  /**
   * The icon is being generated: shows the loader (the original's generate-and-poll state).
   */
  generating?: boolean;

  /**
   * Optional connector info - if provided with a single connector,
   * the connector logo will be shown instead of the AI-generated icon
   */
  connector?: {
    type: string;
    logoUrl?: string;
  };

  /**
   * Additional CSS classes
   */
  className?: string;

  /**
   * Alt text for accessibility
   */
  alt?: string;

  /**
   * Icon color (CSS color value) - uses currentColor in SVG
   */
  color?: string;

  /**
   * Template to use for generation (default: b3os-app-flat). `line-icon` draws `imageUrl` as a mask in `color`.
   */
  template?: "line-icon" | "moebius-icon" | "b3os-app-flat";

  /**
   * Whether to show the built-in icon background shell
   */
  showBackground?: boolean;

  /**
   * Optional type-tinted backdrop class (Figma canvas-v2 icon chip). When set, overrides the
   * default neutral white/dark backdrop for the logo/connector/fallback render paths.
   */
  tintClassName?: string;
}

export function NodeIcon({
  subject,
  logoUrl,
  imageUrl,
  generating = false,
  connector,
  className,
  alt,
  color = "white",
  template = "b3os-app-flat",
  showBackground = true,
  tintClassName,
}: NodeIconProps) {
  // The image states are keyed by the source they describe, so a new imageUrl starts loading again.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [connectorLogoStage, setConnectorLogoStage] = useState(0);
  const [brandLogoError, setBrandLogoError] = useState(false);

  // If an explicit logoUrl is provided by the definition, show it directly.
  if (logoUrl && !brandLogoError) {
    return (
      <LogoImage
        src={logoUrl}
        alt={alt || subject}
        className={className}
        onError={() => setBrandLogoError(true)}
        showBackground={showBackground}
        tintClassName={tintClassName}
      />
    );
  }

  // If a connector is provided, show the connector logo instead of AI-generated icon
  if (connector) {
    const IconComponent = getIconForConnectorType(connector.type);

    // Ordered source list (the original's second source, the ai-icon.b3.fun logo of the brand, is the old API's)
    const connectorSources = [connector.logoUrl].filter((url): url is string => Boolean(url));
    const connectorLogoSrc = connectorSources[connectorLogoStage] ?? null;

    // Show fallback icon if all sources exhausted
    if (!connectorLogoSrc) {
      return (
        <div className={cn("relative", className)}>
          <div
            className={cn(
              "flex h-full w-full items-center justify-center rounded-ds-4",
              showBackground
                ? "bg-blue-100/80 backdrop-blur-xs dark:bg-blue-500/20"
                : "bg-transparent backdrop-blur-[0]",
            )}
          >
            <IconComponent className="h-1/2 w-1/2 text-blue-600 dark:text-blue-400" />
          </div>
        </div>
      );
    }

    // Show connector logo
    return (
      <LogoImage
        src={connectorLogoSrc}
        alt={alt || subject}
        className={className}
        onError={() => setConnectorLogoStage((s) => s + 1)}
        showBackground={showBackground}
        tintClassName={tintClassName}
      />
    );
  }

  // Determine if we should use mask (for monochrome icons with custom colors)
  // or regular img (for icons with their own colors like b3os-app-flat / moebius)
  const useMask = color && template === "line-icon";

  const iconUrl = imageUrl ?? null;
  const hasError = !generating && (!iconUrl || failedSrc === iconUrl);
  const isLoading = iconUrl !== null && loadedSrc !== iconUrl;
  const isGenerating = generating;

  const handleImageError = () => {
    if (iconUrl) setFailedSrc(iconUrl);
  };

  // Fallback to default icon if everything fails
  if (hasError) {
    return (
      <div className={cn("relative", className)}>
        <div
          className={cn(
            "relative flex aspect-square h-full w-full shrink-0 flex-col items-center justify-center gap-2 rounded-ds-8",
            // bg-ds-neutral-100/80 and its dark twin (opacities on var() colours) printed no CSS in the original.
            showBackground ? "backdrop-blur-xs" : "bg-transparent backdrop-blur-[0]",
          )}
        >
          <IconAlertWarningOutline18 className="text-ds-text-disabled dark:text-ds-text-subtle h-4 w-4" />
        </div>
      </div>
    );
  }

  const maskStyle: CSSProperties | undefined =
    useMask && iconUrl
      ? {
          maskImage: `url(${iconUrl})`,
          WebkitMaskImage: `url(${iconUrl})`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          backgroundColor: color,
        }
      : undefined;

  return (
    <div className={cn("relative", className)}>
      {/* Loading/Generating state */}
      {(isLoading || isGenerating) && (
        <div
          className={cn(
            "relative flex h-full w-full flex-col items-center justify-center gap-2 rounded-ds-xs",
            // The default bg-ds-neutral-100/80 (an opacity on a var() colour) printed no CSS in the original.
            showBackground ? tintClassName : "bg-transparent backdrop-blur-[0]",
            showBackground && "backdrop-blur-xs",
          )}
        >
          <PixelLoader size="sm" color="blue" />
        </div>
      )}
      {/* Icon rendering - mask for monochrome, img for colored */}
      {iconUrl && (
        <>
          {useMask ? (
            // Mask approach for monochrome icons (line-icon)
            <div
              className={cn(
                "h-full w-full rounded-ds-8 transition-opacity duration-200 ease-[ease]",
                isLoading || isGenerating ? "opacity-0" : "opacity-100",
              )}
              style={maskStyle}
              role="img"
              aria-label={alt || subject}
            >
              {/* Hidden img to trigger loading events */}
              <img
                src={iconUrl}
                alt=""
                className="invisible h-0 w-0"
                onLoad={() => setLoadedSrc(iconUrl)}
                onError={handleImageError}
              />
            </div>
          ) : (
            // Regular img for colored icons (b3os-app-flat, moebius-icon)
            <img
              src={iconUrl}
              alt={alt || subject}
              loading="lazy"
              className={cn(
                "h-full w-full rounded-ds-xs object-contain transition-opacity duration-200 ease-[ease]",
                isLoading || isGenerating ? "opacity-0" : "opacity-100",
              )}
              onLoad={() => setLoadedSrc(iconUrl)}
              onError={handleImageError}
            />
          )}
        </>
      )}
    </div>
  );
}
